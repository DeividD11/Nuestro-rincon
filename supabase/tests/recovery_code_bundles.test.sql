begin;
select plan(13);

select ok(
  has_function_privilege('service_role', 'public.rotate_app_recovery_codes_bundle(uuid,uuid,text,text,jsonb,timestamptz)', 'execute'),
  'el backend puede rotar el conjunto de códigos'
);
select ok(
  not has_function_privilege('anon', 'public.rotate_app_recovery_codes_bundle(uuid,uuid,text,text,jsonb,timestamptz)', 'execute'),
  'anon no puede rotar códigos de recuperación'
);
select ok(
  not has_function_privilege('authenticated', 'public.rotate_app_recovery_codes_bundle(uuid,uuid,text,text,jsonb,timestamptz)', 'execute'),
  'authenticated no puede rotar códigos de recuperación'
);

select ok(
  has_function_privilege('service_role', 'public.register_app_user_with_invite_idempotent_bundle(text,text,text,text,text,text,jsonb,timestamptz)', 'execute'),
  'service_role puede crear cuentas con el conjunto inicial de diez códigos'
);
select ok(
  not has_function_privilege('anon', 'public.register_app_user_with_invite_idempotent_bundle(text,text,text,text,text,text,jsonb,timestamptz)', 'execute'),
  'anon no puede invocar el alta con códigos de respaldo'
);
select ok(
  not has_function_privilege('authenticated', 'public.register_app_user_with_invite_idempotent_bundle(text,text,text,text,text,text,jsonb,timestamptz)', 'execute'),
  'authenticated no puede invocar el alta con códigos de respaldo'
);

insert into public.app_users(id, username, email, display_name, password_hash, status)
values ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'recovery-bundle-test', 'recovery-bundle-test@example.invalid', 'Recovery Bundle Test', repeat('a',64), 'active');

insert into public.user_sessions(id, user_id, created_at, last_seen_at, idle_expires_at, absolute_expires_at, access_expires_at)
values ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', now(), now(), now()+interval '1 day', now()+interval '2 days', now()+interval '15 minutes');

insert into public.user_recovery_codes(user_id, code_hash, created_at)
values ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', repeat('f',64), now());

set local role service_role;
do $$
declare
  v_hashes jsonb := '[]'::jsonb;
  v_hash text;
  v_result jsonb;
  v_now timestamptz := clock_timestamp();
  i integer;
begin
  for i in 1..10 loop
    v_hash := lpad(to_hex(i), 64, '0');
    v_hashes := v_hashes || to_jsonb(v_hash);
  end loop;
  v_result := public.rotate_app_recovery_codes_bundle(
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    repeat('1',64), repeat('2',64), v_hashes, v_now
  );
  if v_result->>'status' <> 'rotated' then raise exception 'rotation failed: %', v_result; end if;
  if (select count(*) from public.user_recovery_codes where user_id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' and used_at is null) <> 10 then
    raise exception 'expected ten active recovery codes';
  end if;
  v_result := public.rotate_app_recovery_codes_bundle(
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    repeat('1',64), repeat('2',64), v_hashes, v_now
  );
  if v_result->>'status' <> 'already_rotated' then raise exception 'idempotent retry failed: %', v_result; end if;
  v_result := public.rotate_app_recovery_codes_bundle(
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    repeat('3',64), repeat('4',64), v_hashes, v_now
  );
  if v_result->>'status' <> 'rotated' then raise exception 'subsequent rotation failed: %', v_result; end if;
end $$;
reset role;

select is(
  (select count(*)::integer from public.user_recovery_codes where user_id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' and used_at is null),
  10,
  'la rotación deja exactamente diez códigos activos'
);
select is(
  (select count(*)::integer from public.user_recovery_codes where user_id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' and code_hash=repeat('f',64)),
  0,
  'el código anterior queda invalidado al rotar'
);
select is(
  (select code_count::integer from public.recovery_code_bundle_receipts where request_hash=repeat('1',64)),
  10,
  'el recibo idempotente conserva solo el conteo del conjunto'
);
select ok(
  (select relrowsecurity from pg_class where oid='public.recovery_code_bundle_receipts'::regclass),
  'la tabla de recibos mantiene RLS activo'
);
select ok(
  not has_table_privilege('anon','public.recovery_code_bundle_receipts','select'),
  'anon no puede leer recibos de rotación'
);
select is(
  public.consume_app_recovery_code(
    'recovery-bundle-test', lpad(to_hex(1),64,'0'),
    'pbkdf2-sha256$600000$YWJjZA$YWJjZA', now()
  )->>'status',
  'recovered',
  'un código válido puede recuperar la contraseña'
);
select is(
  (select count(*)::integer from public.user_recovery_codes where user_id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' and used_at is null),
  0,
  'al recuperar la cuenta se invalidan los códigos restantes del conjunto'
);
select * from finish();
rollback;
