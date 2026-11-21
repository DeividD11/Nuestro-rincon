begin;
select plan(11);

select ok(
  to_regprocedure('public.rename_app_profile(uuid,text,timestamptz)') is not null,
  'existe el RPC transaccional de cambio de nombre'
);
select ok(
  has_function_privilege('service_role', 'public.rename_app_profile(uuid,text,timestamptz)', 'execute'),
  'service_role puede ejecutar el RPC'
);
select ok(
  not has_function_privilege('anon', 'public.rename_app_profile(uuid,text,timestamptz)', 'execute'),
  'anon no puede ejecutar el RPC'
);
select ok(
  not has_function_privilege('authenticated', 'public.rename_app_profile(uuid,text,timestamptz)', 'execute'),
  'authenticated no puede ejecutar directamente el RPC'
);

insert into public.app_users(id, username, email, display_name, password_hash, status)
values (
  'abababab-abab-4bab-8bab-abababababab',
  'profile-rename-test',
  'profile-rename-test@example.invalid',
  'Nombre inicial',
  repeat('c', 64),
  'active'
);

select is(
  public.rename_app_profile(
    'abababab-abab-4bab-8bab-abababababab',
    'Nombre actualizado',
    now()
  )->>'status',
  'updated',
  'el RPC informa que el perfil se actualizó'
);
select is(
  public.rename_app_profile(
    'abababab-abab-4bab-8bab-abababababab',
    'Nombre actualizado',
    now()
  )->'user'->>'displayName',
  'Nombre actualizado',
  'el RPC devuelve la identidad y el nombre confirmados'
);
select is(
  (select display_name from public.app_users where id = 'abababab-abab-4bab-8bab-abababababab'),
  'Nombre actualizado',
  'app_users recibe el nuevo nombre'
);
select is(
  (select display_name from public.user_profiles where user_id = 'abababab-abab-4bab-8bab-abababababab'),
  'Nombre actualizado',
  'user_profiles recibe el mismo nombre dentro de la transacción'
);
select is(
  public.rename_app_profile(
    'abababab-abab-4bab-8bab-abababababab',
    '   ',
    now()
  )->>'status',
  'invalid_input',
  'el RPC rechaza nombres vacíos'
);

-- Provoca un error después de actualizar app_users, al escribir user_profiles.
-- El bloque DO crea un sub-bloque transaccional: la excepción revierte el primer
-- UPDATE y permite comprobar que las dos tablas no quedan desincronizadas.
alter table public.user_profiles
  add constraint profile_rename_test_reject_name
  check (display_name <> 'CAUSE_FAILURE');

do $test$
begin
  perform public.rename_app_profile(
    'abababab-abab-4bab-8bab-abababababab',
    'CAUSE_FAILURE',
    now()
  );
  raise exception 'PROFILE_RENAME_FAILURE_WAS_NOT_TRIGGERED';
exception
  when check_violation then
    null;
end;
$test$;

select is(
  (select display_name from public.app_users where id = 'abababab-abab-4bab-8bab-abababababab'),
  'Nombre actualizado',
  'si falla el upsert del perfil, PostgreSQL revierte el UPDATE de app_users'
);
select is(
  (select display_name from public.user_profiles where user_id = 'abababab-abab-4bab-8bab-abababababab'),
  'Nombre actualizado',
  'si falla la segunda escritura, user_profiles conserva el último estado confirmado'
);

select * from finish();
rollback;
