-- Limitación de intentos de autenticación por cuenta+origen y por IP.
-- Las IP se guardan como HMAC; nunca se persiste la dirección original.
-- La limitación por cuenta se combina con IP para que un tercero no pueda
-- bloquear las credenciales de la víctima desde otra conexión.

begin;

alter table public.login_attempts
  add column if not exists ip_digest text,
  add column if not exists action text not null default 'login';

alter table public.login_attempts enable row level security;
revoke all privileges on table public.login_attempts from public, anon, authenticated;
grant select, insert, update, delete on table public.login_attempts to service_role;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.login_attempts'::regclass
      and conname = 'login_attempts_ip_digest_check'
  ) then
    alter table public.login_attempts
      add constraint login_attempts_ip_digest_check
      check (ip_digest is null or ip_digest ~ '^[0-9a-f]{64}$');
  end if;
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.login_attempts'::regclass
      and conname = 'login_attempts_action_check'
  ) then
    alter table public.login_attempts
      add constraint login_attempts_action_check
      check (action in ('login', 'recovery', 'registration'));
  end if;
end $$;

create index if not exists login_attempts_ip_recent_idx
  on public.login_attempts (ip_digest, attempted_at desc)
  where ip_digest is not null and outcome in ('pending', 'failed');

create index if not exists login_attempts_account_ip_recent_idx
  on public.login_attempts (identifier_hash, ip_digest, attempted_at desc)
  where outcome in ('pending', 'failed');

create or replace function public.start_app_auth_attempt(
  p_identifier_hash text,
  p_ip_digest text,
  p_action text,
  p_now timestamptz default now()
)
returns jsonb
language plpgsql
set search_path to 'pg_catalog', 'public'
as $function$
declare
  v_pair_count integer := 0;
  v_pair_last timestamptz;
  v_pair_delay integer := 0;
  v_ip_count integer := 0;
  v_ip_last timestamptz;
  v_ip_delay integer := 0;
  v_account_failures integer := 0;
  v_attempt_id uuid;
  v_retry integer := 0;
  v_scope text;
begin
  if p_identifier_hash is null or p_identifier_hash !~ '^[0-9a-f]{64}$'
     or (p_ip_digest is not null and p_ip_digest !~ '^[0-9a-f]{64}$')
     or p_action is null or p_action not in ('login', 'recovery', 'registration')
     or p_now is null then
    return jsonb_build_object('allowed', false, 'reason', 'invalid');
  end if;

  -- Orden estable de bloqueos: primero cuenta+IP, después IP. Evita que
  -- intentos concurrentes del mismo origen eludan los contadores.
  if p_ip_digest is not null then
    perform pg_advisory_xact_lock(hashtextextended(
      'auth-attempt-account-ip:' || p_identifier_hash || ':' || p_ip_digest, 0));
    perform pg_advisory_xact_lock(hashtextextended('auth-attempt-ip:' || p_ip_digest, 0));

    select count(*)::integer, max(attempted_at)
      into v_pair_count, v_pair_last
    from public.login_attempts
    where identifier_hash = p_identifier_hash
      and ip_digest = p_ip_digest
      and attempted_at > p_now - interval '15 minutes'
      and (outcome = 'failed'
        or (outcome = 'pending' and attempted_at > p_now - interval '2 minutes'));

    select count(*)::integer, max(attempted_at)
      into v_ip_count, v_ip_last
    from public.login_attempts
    where ip_digest = p_ip_digest
      and attempted_at > p_now - interval '15 minutes'
      and (outcome = 'failed'
        or (outcome = 'pending' and attempted_at > p_now - interval '2 minutes'));
  else
    -- Si el proxy no proporciona una IP verificable, no se crea un bucket
    -- compartido "unknown" que pueda bloquear a todas las personas.
    perform pg_advisory_xact_lock(hashtextextended('auth-attempt-account:' || p_identifier_hash, 0));
  end if;

  select count(*)::integer into v_account_failures
  from public.login_attempts
  where identifier_hash = p_identifier_hash
    and outcome = 'failed'
    and attempted_at > p_now - interval '1 hour';

  -- El bucket de cuenta+IP inicia un enfriamiento de 30 s desde el quinto
  -- fallo; cada fallo adicional duplica el tiempo hasta un máximo de 15 min.
  -- Un intento desde otra IP no bloquea al titular legítimo.
  if p_ip_digest is not null and v_pair_count >= 5 and v_pair_last is not null then
    v_pair_delay := least(900, (30 * power(2, least(v_pair_count - 5, 4)))::integer);
    v_retry := greatest(v_retry,
      ceil(extract(epoch from (v_pair_last + make_interval(secs => v_pair_delay) - p_now)))::integer);
    if v_retry > 0 then v_scope := 'account_and_ip'; end if;
  end if;

  -- Límite agregado de origen: 25 fallos en 15 min. Su enfriamiento crece
  -- progresivamente y queda acotado a 4 min para reducir falsos bloqueos en
  -- redes compartidas.
  if p_ip_digest is not null and v_ip_count >= 25 and v_ip_last is not null then
    v_ip_delay := least(240, (15 * power(2, least(v_ip_count - 25, 4)))::integer);
    if ceil(extract(epoch from (v_ip_last + make_interval(secs => v_ip_delay) - p_now)))::integer > v_retry then
      v_retry := greatest(0, ceil(extract(epoch from (v_ip_last + make_interval(secs => v_ip_delay) - p_now)))::integer);
      v_scope := 'ip';
    end if;
  end if;

  -- Se registra el patrón distribuido por cuenta, pero NO se bloquea la cuenta
  -- globalmente: una persona no puede inutilizar el acceso de la víctima
  -- provocando intentos fallidos desde otra IP. La Edge Function añade una
  -- fricción corta solo a respuestas fallidas, nunca a credenciales correctas.
  if v_account_failures >= 10 and not exists (
    select 1 from public.auth_audit_logs
    where event_type = 'auth.suspicious_account_attempts'
      and metadata ->> 'identifier_hash' = p_identifier_hash
      and occurred_at > p_now - interval '10 minutes'
  ) then
    insert into public.auth_audit_logs(user_id, event_type, occurred_at, ip_digest, metadata)
    values (null, 'auth.suspicious_account_attempts', p_now, p_ip_digest,
      jsonb_build_object('action', p_action, 'identifier_hash', p_identifier_hash,
                         'failed_attempts_last_hour', v_account_failures));
  end if;
  if p_ip_digest is not null and v_ip_count = 20 then
    insert into public.auth_audit_logs(user_id, event_type, occurred_at, ip_digest, metadata)
    values (null, 'auth.suspicious_ip_activity', p_now, p_ip_digest,
      jsonb_build_object('action', p_action, 'failed_attempts_last_15m', v_ip_count));
  end if;

  if v_retry > 0 then
    -- Evita llenar la auditoría con una fila por cada petición bloqueada.
    if not exists (
      select 1 from public.auth_audit_logs
      where event_type = 'auth.rate_limited'
        and ip_digest is not distinct from p_ip_digest
        and occurred_at > p_now - interval '5 minutes'
        and metadata ->> 'scope' = coalesce(v_scope, 'unknown')
        and metadata ->> 'identifier_hash' = p_identifier_hash
    ) then
      insert into public.auth_audit_logs(user_id, event_type, occurred_at, ip_digest, metadata)
      values (null, 'auth.rate_limited', p_now, p_ip_digest,
        jsonb_build_object('action', p_action, 'scope', coalesce(v_scope, 'unknown'),
                           'identifier_hash', p_identifier_hash,
                           'retry_after_seconds', v_retry));
    end if;
    return jsonb_build_object('allowed', false, 'reason', 'rate_limited',
                              'retry_after_seconds', v_retry, 'scope', v_scope);
  end if;

  insert into public.login_attempts(identifier_hash, ip_digest, action, outcome, attempted_at)
  values (p_identifier_hash, p_ip_digest, p_action, 'pending', p_now)
  returning id into v_attempt_id;

  return jsonb_build_object('allowed', true, 'attempt_id', v_attempt_id,
                            'account_failure_signal', v_account_failures >= 10,
                            'account_failure_count', v_account_failures);
end;
$function$;

revoke all on function public.start_app_auth_attempt(text, text, text, timestamptz)
  from public, anon, authenticated;
grant execute on function public.start_app_auth_attempt(text, text, text, timestamptz)
  to service_role;

-- La función anterior queda temporalmente disponible solo para permitir
-- despliegues sin interrupción si el backend v11 sigue activo durante la
-- actualización. Los endpoints nuevos usan start_app_auth_attempt.
revoke execute on function public.start_app_login_attempt(text, timestamptz)
  from public, anon, authenticated;
grant execute on function public.start_app_login_attempt(text, timestamptz)
  to service_role;

commit;
