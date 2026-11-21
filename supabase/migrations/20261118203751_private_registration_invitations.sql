-- Invitaciones privadas de un solo uso para el registro de las dos cuentas.
-- El código en claro solo existe en la respuesta del backend que lo genera;
-- PostgreSQL conserva únicamente su hash SHA-256 con separación de dominio.

create table if not exists public.registration_invites (
  id uuid primary key default gen_random_uuid(),
  token_hash text not null unique
    check (token_hash ~ '^[0-9a-f]{64}$'),
  invited_by_user_id uuid references public.app_users(id) on delete set null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  consumed_at timestamptz,
  consumed_user_id uuid references public.app_users(id) on delete set null,
  revoked_at timestamptz,
  constraint registration_invites_valid_lifecycle check (
    not (consumed_at is not null and revoked_at is not null)
  )
);

-- Solo puede existir una invitación pendiente para este espacio de dos personas.
create unique index if not exists registration_invites_one_pending_uidx
  on public.registration_invites ((1))
  where consumed_at is null and revoked_at is null;
create index if not exists registration_invites_expiry_idx
  on public.registration_invites (expires_at)
  where consumed_at is null and revoked_at is null;

alter table public.registration_invites enable row level security;
revoke all privileges on table public.registration_invites from public, anon, authenticated;
grant select, insert, update, delete on table public.registration_invites to service_role;

create table if not exists public.registration_invite_attempts (
  id uuid primary key default gen_random_uuid(),
  ip_hash text not null check (ip_hash ~ '^[0-9a-f]{64}$'),
  token_hash text not null check (token_hash ~ '^[0-9a-f]{64}$'),
  outcome text not null default 'pending'
    check (outcome in ('pending', 'accepted', 'rejected')),
  reason text,
  attempted_at timestamptz not null default now(),
  completed_at timestamptz,
  user_id uuid references public.app_users(id) on delete set null
);

create index if not exists registration_invite_attempts_ip_time_idx
  on public.registration_invite_attempts (ip_hash, attempted_at desc);
create index if not exists registration_invite_attempts_token_time_idx
  on public.registration_invite_attempts (token_hash, attempted_at desc);
create index if not exists registration_invite_attempts_time_idx
  on public.registration_invite_attempts (attempted_at);

alter table public.registration_invite_attempts enable row level security;
revoke all privileges on table public.registration_invite_attempts from public, anon, authenticated;
grant select, insert, update, delete on table public.registration_invite_attempts to service_role;

-- El hash recibido en esta función ya fue calculado por auth-api. El primer
-- pre-chequeo evita ejecutar PBKDF2 para códigos inexistentes; el registro
-- final vuelve a validar y consumir la invitación dentro de su transacción.
create or replace function public.check_app_registration_invite(
  p_token_hash text,
  p_now timestamptz default now()
)
returns jsonb
language plpgsql
set search_path to 'pg_catalog', 'public'
as $function$
begin
  if p_token_hash is null or p_token_hash !~ '^[0-9a-f]{64}$' or p_now is null then
    return jsonb_build_object('status', 'invalid');
  end if;

  if exists (
    select 1 from public.registration_invites
    where token_hash = p_token_hash
      and consumed_at is null
      and revoked_at is null
      and expires_at > p_now
  ) then
    return jsonb_build_object('status', 'valid');
  end if;

  return jsonb_build_object('status', 'invalid');
end;
$function$;

-- Límite combinado: 10 intentos por IP anonimizada y 5 por hash de código
-- durante 15 minutos. Al superar el límite se registra solo el primer bloqueo
-- de la ventana, evitando que un atacante convierta el log en un vector de DoS.
create or replace function public.start_app_registration_invite_attempt(
  p_ip_hash text,
  p_token_hash text,
  p_now timestamptz default now()
)
returns jsonb
language plpgsql
set search_path to 'pg_catalog', 'public'
as $function$
declare
  v_ip_count integer;
  v_token_count integer;
  v_reason text;
  v_attempt_id uuid;
begin
  if p_ip_hash is null or p_ip_hash !~ '^[0-9a-f]{64}$'
     or p_token_hash is null or p_token_hash !~ '^[0-9a-f]{64}$'
     or p_now is null then
    return jsonb_build_object('allowed', false, 'reason', 'invalid_request');
  end if;

  -- Orden de bloqueo estable para evitar interbloqueos entre peticiones concurrentes.
  perform pg_advisory_xact_lock(hashtextextended('registration-invite-ip:' || p_ip_hash, 0));
  perform pg_advisory_xact_lock(hashtextextended('registration-invite-token:' || p_token_hash, 0));

  select count(*)::integer into v_ip_count
  from public.registration_invite_attempts
  where ip_hash = p_ip_hash and attempted_at > p_now - interval '15 minutes';

  select count(*)::integer into v_token_count
  from public.registration_invite_attempts
  where token_hash = p_token_hash and attempted_at > p_now - interval '15 minutes';

  if v_ip_count >= 10 then
    v_reason := 'ip_window';
  elsif v_token_count >= 5 then
    v_reason := 'code_window';
  end if;

  if v_reason is not null then
    -- Solo un evento por cada ventana bloqueada: los siguientes rechazos no
    -- generan escrituras adicionales hasta que expire la ventana.
    if (v_reason = 'ip_window' and v_ip_count = 10)
       or (v_reason = 'code_window' and v_token_count = 5) then
      insert into public.auth_audit_logs(user_id, event_type, occurred_at, ip_digest, metadata)
      values (null, 'registration.invite_rate_limited', p_now, p_ip_hash,
              jsonb_build_object('reason', v_reason, 'window_minutes', 15));
    end if;
    return jsonb_build_object('allowed', false, 'reason', v_reason);
  end if;

  insert into public.registration_invite_attempts(ip_hash, token_hash, outcome, attempted_at)
  values (p_ip_hash, p_token_hash, 'pending', p_now)
  returning id into v_attempt_id;

  -- Limpieza acotada para evitar retener indefinidamente huellas de intentos.
  delete from public.registration_invite_attempts
  where id in (
    select id from public.registration_invite_attempts
    where attempted_at < p_now - interval '30 days'
    order by attempted_at asc
    limit 200
  );

  return jsonb_build_object('allowed', true, 'attempt_id', v_attempt_id);
end;
$function$;

create or replace function public.complete_app_registration_invite_attempt(
  p_attempt_id uuid,
  p_outcome text,
  p_reason text default null,
  p_user_id uuid default null,
  p_now timestamptz default now()
)
returns jsonb
language plpgsql
set search_path to 'pg_catalog', 'public'
as $function$
declare
  v_ip_hash text;
  v_updated integer;
begin
  if p_attempt_id is null or p_outcome is null or p_outcome not in ('accepted', 'rejected') or p_now is null then
    return jsonb_build_object('status', 'invalid');
  end if;

  update public.registration_invite_attempts
     set outcome = p_outcome,
         reason = left(coalesce(p_reason, ''), 80),
         completed_at = p_now,
         user_id = case when p_outcome = 'accepted' then p_user_id else null end
   where id = p_attempt_id and outcome = 'pending'
  returning ip_hash into v_ip_hash;

  get diagnostics v_updated = row_count;
  if v_updated <> 1 then
    return jsonb_build_object('status', 'not_found');
  end if;

  insert into public.auth_audit_logs(user_id, event_type, occurred_at, ip_digest, metadata)
  values (
    case when p_outcome = 'accepted' then p_user_id else null end,
    case when p_outcome = 'accepted' then 'registration.invite_accepted' else 'registration.invite_rejected' end,
    p_now,
    v_ip_hash,
    jsonb_build_object('reason', left(coalesce(p_reason, ''), 80))
  );

  return jsonb_build_object('status', 'completed');
end;
$function$;

create or replace function public.get_app_registration_invitation_status(
  p_user_id uuid,
  p_now timestamptz default now()
)
returns jsonb
language plpgsql
set search_path to 'pg_catalog', 'public'
as $function$
declare
  v_account_count integer;
  v_pending_id uuid;
  v_pending_expires timestamptz;
begin
  if p_user_id is null or p_now is null or not exists (
    select 1 from public.app_users where id = p_user_id and status = 'active'
  ) then
    return jsonb_build_object('status', 'unauthorized');
  end if;

  perform pg_advisory_xact_lock(hashtextextended('private-letters-account-cap', 0));

  update public.registration_invites
     set revoked_at = p_now
   where consumed_at is null and revoked_at is null and expires_at <= p_now;

  select count(*)::integer into v_account_count
  from public.app_users where status in ('active', 'pending_email');

  select id, expires_at into v_pending_id, v_pending_expires
  from public.registration_invites
  where consumed_at is null and revoked_at is null and expires_at > p_now
  order by created_at desc limit 1;

  return jsonb_build_object(
    'status', 'ok',
    'account_count', v_account_count,
    'pending', v_pending_id is not null,
    'expires_at', v_pending_expires,
    'can_create', v_account_count = 1 and v_pending_id is null
  );
end;
$function$;

create or replace function public.create_app_registration_invite(
  p_inviter_user_id uuid,
  p_token_hash text,
  p_expires_at timestamptz,
  p_now timestamptz default now()
)
returns jsonb
language plpgsql
set search_path to 'pg_catalog', 'public'
as $function$
declare
  v_account_count integer;
  v_invite_id uuid;
begin
  if p_inviter_user_id is null or p_token_hash is null
     or p_token_hash !~ '^[0-9a-f]{64}$'
     or p_now is null or p_expires_at is null
     or p_expires_at <= p_now
     or p_expires_at > p_now + interval '7 days 1 minute' then
    return jsonb_build_object('status', 'invalid');
  end if;

  perform pg_advisory_xact_lock(hashtextextended('private-letters-account-cap', 0));

  if not exists (
    select 1 from public.app_users
    where id = p_inviter_user_id and status = 'active'
  ) then
    return jsonb_build_object('status', 'unauthorized');
  end if;

  update public.registration_invites
     set revoked_at = p_now
   where consumed_at is null and revoked_at is null and expires_at <= p_now;

  select count(*)::integer into v_account_count
  from public.app_users where status in ('active', 'pending_email');

  if v_account_count >= 2 then
    return jsonb_build_object('status', 'account_limit_reached');
  end if;
  if v_account_count <> 1 then
    return jsonb_build_object('status', 'bootstrap_required');
  end if;
  if exists (
    select 1 from public.registration_invites
    where consumed_at is null and revoked_at is null and expires_at > p_now
  ) then
    return jsonb_build_object('status', 'pending_invitation_exists');
  end if;

  insert into public.registration_invites(token_hash, invited_by_user_id, created_at, expires_at)
  values (p_token_hash, p_inviter_user_id, p_now, p_expires_at)
  returning id into v_invite_id;

  insert into public.auth_audit_logs(user_id, event_type, occurred_at, metadata)
  values (p_inviter_user_id, 'registration.invite_created', p_now,
          jsonb_build_object('invitation_id', v_invite_id, 'expires_at', p_expires_at));

  return jsonb_build_object('status', 'created', 'invitation_id', v_invite_id, 'expires_at', p_expires_at);
end;
$function$;

create or replace function public.revoke_app_registration_invite(
  p_inviter_user_id uuid,
  p_now timestamptz default now()
)
returns jsonb
language plpgsql
set search_path to 'pg_catalog', 'public'
as $function$
declare
  v_invitation_id uuid;
begin
  if p_inviter_user_id is null or p_now is null then
    return jsonb_build_object('status', 'invalid');
  end if;

  perform pg_advisory_xact_lock(hashtextextended('private-letters-account-cap', 0));

  if not exists (
    select 1 from public.app_users
    where id = p_inviter_user_id and status = 'active'
  ) then
    return jsonb_build_object('status', 'unauthorized');
  end if;

  select id into v_invitation_id
  from public.registration_invites
  where consumed_at is null and revoked_at is null and expires_at > p_now
  order by created_at desc limit 1
  for update;

  if v_invitation_id is null then
    return jsonb_build_object('status', 'not_found');
  end if;

  update public.registration_invites set revoked_at = p_now
  where id = v_invitation_id and consumed_at is null and revoked_at is null;
  if not found then
    return jsonb_build_object('status', 'not_found');
  end if;

  insert into public.auth_audit_logs(user_id, event_type, occurred_at, metadata)
  values (p_inviter_user_id, 'registration.invite_revoked', p_now,
          jsonb_build_object('invitation_id', v_invitation_id));

  return jsonb_build_object('status', 'revoked');
end;
$function$;

-- El alta y el consumo de la invitación suceden dentro de la misma transacción.
-- Si falla cualquier inserción del usuario/perfil/preferencias/recuperación, el
-- UPDATE que consume el código también se revierte.
create or replace function public.register_app_user_with_invite(
  p_invitation_hash text,
  p_display_name text,
  p_username text,
  p_password_hash text,
  p_recovery_code_hash text,
  p_now timestamptz default now()
)
returns jsonb
language plpgsql
set search_path to 'pg_catalog', 'public'
as $function$
declare
  v_user_id uuid;
  v_invitation_id uuid;
  v_account_count integer;
  v_username text := lower(normalize(btrim(coalesce(p_username, '')), NFKC));
  v_email text;
begin
  perform pg_advisory_xact_lock(hashtextextended('private-letters-account-cap', 0));

  if p_invitation_hash is null or p_invitation_hash !~ '^[0-9a-f]{64}$'
     or p_now is null
     or p_display_name is null or length(btrim(p_display_name)) not between 1 and 80
     or v_username !~ '^[[:alnum:]][[:alnum:]_.@+-]{2,47}$'
     or p_password_hash is null
     or p_password_hash !~ '^pbkdf2-sha256\$[0-9]+\$[A-Za-z0-9_-]+\$[A-Za-z0-9_-]+$'
     or length(p_password_hash) > 256
     or p_recovery_code_hash is null or p_recovery_code_hash !~ '^[0-9a-f]{64}$' then
    return jsonb_build_object('status', 'invalid_input');
  end if;

  select id into v_invitation_id
  from public.registration_invites
  where token_hash = p_invitation_hash
    and consumed_at is null
    and revoked_at is null
    and expires_at > p_now
  for update;

  if v_invitation_id is null then
    return jsonb_build_object('status', 'invalid_invitation');
  end if;

  select count(*)::integer into v_account_count
  from public.app_users where status in ('active', 'pending_email');
  if v_account_count >= 2 then
    return jsonb_build_object('status', 'account_limit_reached');
  end if;

  v_email := v_username || '@accounts.nuestro-rincon.invalid';

  insert into public.app_users(
    username, email, display_name, password_hash, status,
    created_at, updated_at, email_verified_at, password_changed_at
  )
  values (
    v_username, v_email, btrim(p_display_name), p_password_hash, 'active',
    p_now, p_now, p_now, p_now
  )
  returning id into v_user_id;

  insert into public.user_profiles(user_id, display_name, created_at, updated_at)
  values (v_user_id, btrim(p_display_name), p_now, p_now);

  insert into public.user_settings(user_id, created_at, updated_at)
  values (v_user_id, p_now, p_now);

  insert into public.user_recovery_codes(user_id, code_hash, created_at)
  values (v_user_id, p_recovery_code_hash, p_now);

  update public.registration_invites
     set consumed_at = p_now,
         consumed_user_id = v_user_id
   where id = v_invitation_id
     and consumed_at is null and revoked_at is null;

  if not found then
    raise exception 'registration_invitation_race';
  end if;

  insert into public.auth_audit_logs(user_id, event_type, occurred_at, metadata)
  values (v_user_id, 'account.registered', p_now,
          jsonb_build_object('method', 'private_invitation', 'recovery_code_issued', true,
                             'invitation_id', v_invitation_id));

  return jsonb_build_object('status', 'created', 'user_id', v_user_id);
exception when unique_violation then
  return jsonb_build_object('status', 'username_or_email_exists');
end;
$function$;

-- El registro público anterior ya no debe quedar como ruta alternativa. También
-- se retiran las RPC de invitación por email que pertenecían al flujo histórico.
do $block$
declare
  v_function record;
begin
  for v_function in
    select p.oid::regprocedure as signature
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname = any(array[
        'register_app_user_without_email',
        'register_app_user',
        'accept_app_invitation',
        'create_app_invitation'
      ])
  loop
    execute format('revoke all privileges on function %s from public, anon, authenticated, service_role', v_function.signature);
  end loop;
end;
$block$;

-- Al deshabilitar una cuenta, cualquier invitación pendiente de ese espacio
-- queda revocada. Esto incluye una invitación de bootstrap sin emisor.
create or replace function public.revoke_registration_invites_after_account_disable()
returns trigger
language plpgsql
set search_path to 'pg_catalog', 'public'
as $function$
begin
  if old.status = 'active' and new.status <> 'active' then
    update public.registration_invites
       set revoked_at = coalesce(new.updated_at, now())
     where consumed_at is null and revoked_at is null
       and (invited_by_user_id = old.id or not exists (
         select 1 from public.app_users u
         where u.id <> old.id and u.status in ('active', 'pending_email')
       ));
  end if;
  return new;
end;
$function$;

drop trigger if exists app_users_revoke_registration_invites on public.app_users;
create trigger app_users_revoke_registration_invites
after update of status on public.app_users
for each row execute function public.revoke_registration_invites_after_account_disable();
revoke all on function public.revoke_registration_invites_after_account_disable() from public, anon, authenticated, service_role;

-- SQL Editor (rol postgres) es el único canal de bootstrap para una instalación
-- vacía. El resultado contiene el código en claro una sola vez; solo el hash
-- se almacena. En el proyecto ya inicializado no se necesita este procedimiento.
create or replace function public.bootstrap_app_registration_invite()
returns jsonb
language plpgsql
set search_path to 'pg_catalog', 'public'
as $function$
declare
  v_account_count integer;
  v_raw text;
  v_hash text;
  v_now timestamptz := now();
  v_expires timestamptz;
  v_code text;
begin
  if current_user <> 'postgres' then
    raise exception 'bootstrap_role_required';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('private-letters-account-cap', 0));

  select count(*)::integer into v_account_count
  from public.app_users where status in ('active', 'pending_email');
  if v_account_count <> 0 then
    raise exception 'bootstrap_only_for_empty_installation';
  end if;

  update public.registration_invites
     set revoked_at = v_now
   where consumed_at is null and revoked_at is null and expires_at <= v_now;
  if exists (
    select 1 from public.registration_invites
    where consumed_at is null and revoked_at is null and expires_at > v_now
  ) then
    raise exception 'pending_invitation_already_exists';
  end if;

  v_raw := encode(extensions.gen_random_bytes(32), 'hex');
  v_hash := encode(sha256(convert_to('registration-invite:v1:' || v_raw, 'UTF8')), 'hex');
  v_expires := v_now + interval '7 days';
  v_code := 'NR1-' || substr(v_raw, 1, 8) || '-' || substr(v_raw, 9, 8) || '-'
    || substr(v_raw, 17, 8) || '-' || substr(v_raw, 25, 8) || '-'
    || substr(v_raw, 33, 8) || '-' || substr(v_raw, 41, 8) || '-'
    || substr(v_raw, 49, 8) || '-' || substr(v_raw, 57, 8);

  insert into public.registration_invites(token_hash, created_at, expires_at)
  values (v_hash, v_now, v_expires);

  return jsonb_build_object('code', v_code, 'expires_at', v_expires);
end;
$function$;

-- Todas las RPC se invocan únicamente desde auth-api con su credencial privada.
-- No se concede acceso directo a anon/authenticated ni se usa SECURITY DEFINER.
revoke all on function public.check_app_registration_invite(text, timestamptz) from public, anon, authenticated;
revoke all on function public.start_app_registration_invite_attempt(text, text, timestamptz) from public, anon, authenticated;
revoke all on function public.complete_app_registration_invite_attempt(uuid, text, text, uuid, timestamptz) from public, anon, authenticated;
revoke all on function public.get_app_registration_invitation_status(uuid, timestamptz) from public, anon, authenticated;
revoke all on function public.create_app_registration_invite(uuid, text, timestamptz, timestamptz) from public, anon, authenticated;
revoke all on function public.revoke_app_registration_invite(uuid, timestamptz) from public, anon, authenticated;
revoke all on function public.register_app_user_with_invite(text, text, text, text, text, timestamptz) from public, anon, authenticated;
revoke all on function public.bootstrap_app_registration_invite() from public, anon, authenticated, service_role;

grant execute on function public.check_app_registration_invite(text, timestamptz) to service_role;
grant execute on function public.start_app_registration_invite_attempt(text, text, timestamptz) to service_role;
grant execute on function public.complete_app_registration_invite_attempt(uuid, text, text, uuid, timestamptz) to service_role;
grant execute on function public.get_app_registration_invitation_status(uuid, timestamptz) to service_role;
grant execute on function public.create_app_registration_invite(uuid, text, timestamptz, timestamptz) to service_role;
grant execute on function public.revoke_app_registration_invite(uuid, timestamptz) to service_role;
grant execute on function public.register_app_user_with_invite(text, text, text, text, text, timestamptz) to service_role;
grant execute on function public.bootstrap_app_registration_invite() to postgres;
