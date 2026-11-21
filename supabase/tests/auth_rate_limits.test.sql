begin;
select plan(10);

select ok(
  (select relrowsecurity from pg_class where oid = 'public.login_attempts'::regclass),
  'login_attempts mantiene RLS activo'
);
select ok(not has_table_privilege('anon', 'public.login_attempts', 'select'),
  'anon no puede leer los intentos');
select ok(not has_table_privilege('authenticated', 'public.login_attempts', 'select'),
  'authenticated no puede leer los intentos');
select ok(not has_function_privilege('anon', 'public.start_app_auth_attempt(text,text,text,timestamptz)', 'execute'),
  'anon no puede ejecutar el limitador');
select ok(has_function_privilege('service_role', 'public.start_app_auth_attempt(text,text,text,timestamptz)', 'execute'),
  'solo el backend puede ejecutar el limitador');

set local role service_role;
do $$
declare
  v jsonb;
  v_attempt_id uuid;
  v_now timestamptz := '2026-11-19 07:00:00+00';
  i integer;
  v_pair_blocked boolean := false;
  v_other_ip_allowed boolean := false;
  v_ip_blocked boolean := false;
  v_distributed_allowed boolean := false;
begin
  -- Primer intento desde account+IP permitido; se completa como fallo.
  v := public.start_app_auth_attempt(repeat('a',64), repeat('b',64), 'login', v_now);
  if v ->> 'allowed' <> 'true' then raise exception 'initial account+IP attempt unexpectedly blocked: %', v; end if;
  v_attempt_id := (v ->> 'attempt_id')::uuid;
  perform public.complete_app_login_attempt(v_attempt_id, false, v_now + interval '1 second');

  -- Quinto fallo incluido: debe seguir permitido; el sexto inicia el cooldown.
  for i in 2..5 loop
    v := public.start_app_auth_attempt(repeat('a',64), repeat('b',64), 'login', v_now + make_interval(secs => i));
    if v ->> 'allowed' <> 'true' then raise exception 'pair attempt % unexpectedly blocked: %', i, v; end if;
    perform public.complete_app_login_attempt((v ->> 'attempt_id')::uuid, false, v_now + make_interval(secs => i));
  end loop;
  v := public.start_app_auth_attempt(repeat('a',64), repeat('b',64), 'login', v_now + interval '6 seconds');
  v_pair_blocked := v ->> 'allowed' = 'false' and (v ->> 'retry_after_seconds')::integer > 0;
  if not v_pair_blocked then raise exception 'account+IP cooldown was not applied: %', v; end if;

  -- La misma cuenta desde otra IP no hereda el bloqueo: evita account lockout.
  v := public.start_app_auth_attempt(repeat('a',64), repeat('c',64), 'login', v_now + interval '7 seconds');
  v_other_ip_allowed := v ->> 'allowed' = 'true';
  if not v_other_ip_allowed then raise exception 'the account was blocked globally by another IP: %', v; end if;

  -- 25 identidades diferentes desde una misma IP activan el límite agregado.
  for i in 1..25 loop
    v := public.start_app_auth_attempt(md5('ip-test-' || i) || md5('ip-test-b-' || i), repeat('d',64), 'login', v_now + make_interval(secs => 20 + i));
    if v ->> 'allowed' <> 'true' then raise exception 'IP attempt % unexpectedly blocked before threshold: %', i, v; end if;
    perform public.complete_app_login_attempt((v ->> 'attempt_id')::uuid, false, v_now + make_interval(secs => 20 + i));
  end loop;
  v := public.start_app_auth_attempt(md5('ip-test-final') || md5('ip-test-final-b'), repeat('d',64), 'login', v_now + interval '46 seconds');
  v_ip_blocked := v ->> 'allowed' = 'false' and (v ->> 'retry_after_seconds')::integer > 0;
  if not v_ip_blocked then raise exception 'IP-wide cooldown was not applied: %', v; end if;

  -- Diez fallos desde IP distintas generan una señal, pero no bloquean la
  -- cuenta globalmente: el siguiente intento desde otra IP sigue permitido.
  for i in 1..10 loop
    v := public.start_app_auth_attempt(repeat('e',64), lpad(to_hex(i),64,'0'), 'recovery', v_now + make_interval(secs => 100 + i));
    if v ->> 'allowed' <> 'true' then raise exception 'distributed attempt % unexpectedly blocked: %', i, v; end if;
    perform public.complete_app_login_attempt((v ->> 'attempt_id')::uuid, false, v_now + make_interval(secs => 100 + i));
  end loop;
  v := public.start_app_auth_attempt(repeat('e',64), repeat('f',64), 'recovery', v_now + interval '112 seconds');
  v_distributed_allowed := v ->> 'allowed' = 'true'
    and v ->> 'account_failure_signal' = 'true'
    and coalesce((v ->> 'account_failure_count')::integer, 0) >= 10;
  if not v_distributed_allowed then raise exception 'distributed activity locked the account globally: %', v; end if;
end $$;

reset role;
select ok(true, 'el bucket cuenta+IP aplica enfriamiento progresivo');
select ok(true, 'el limitador por IP detecta ráfagas con nombres diferentes');
select ok(true, 'los intentos distribuidos dejan señal sin bloquear la cuenta');
select ok(exists (
  select 1 from public.auth_audit_logs
  where event_type = 'auth.suspicious_account_attempts'
    and metadata ->> 'identifier_hash' = repeat('e',64)
), 'se auditan intentos distribuidos sobre una cuenta sin bloquearla globalmente');
select ok(exists (
  select 1 from public.auth_audit_logs
  where event_type = 'auth.rate_limited'
    and metadata ->> 'scope' in ('account_and_ip','ip')
), 'el enfriamiento deja una señal de auditoría acotada');

select * from finish();
rollback;
