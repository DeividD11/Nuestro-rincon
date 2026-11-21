
-- Recibo separado para ligar el intento de registro al hash del conjunto completo.
-- La tabla no conserva los códigos ni ningún valor recuperable.
create table if not exists public.registration_recovery_bundle_receipts (
  request_hash text primary key check (request_hash ~ '^[0-9a-f]{64}$'),
  user_id uuid not null references public.app_users(id) on delete cascade,
  bundle_hash text not null check (bundle_hash ~ '^[0-9a-f]{64}$'),
  code_count smallint not null check (code_count = 10),
  created_at timestamptz not null default now()
);

create index if not exists registration_recovery_bundle_receipts_user_idx
  on public.registration_recovery_bundle_receipts(user_id, created_at desc);

alter table public.registration_recovery_bundle_receipts enable row level security;
revoke all privileges on table public.registration_recovery_bundle_receipts from public, anon, authenticated;
grant select, insert, update, delete on table public.registration_recovery_bundle_receipts to service_role;

-- Nueva cuenta recibe diez códigos independientes desde el registro inicial.
-- La función anterior se conserva para solicitudes legacy que aún usan un código.
create or replace function public.register_app_user_with_invite_idempotent_bundle(
  p_request_hash text,
  p_invitation_hash text,
  p_display_name text,
  p_username text,
  p_password_hash text,
  p_bundle_hash text,
  p_code_hashes jsonb,
  p_now timestamptz default now()
)
returns jsonb
language plpgsql
set search_path to 'pg_catalog', 'public'
as $function$
declare
  v_receipt public.registration_request_receipts%rowtype;
  v_invitation_id uuid;
  v_user_id uuid;
  v_account_count integer;
  v_username text := lower(normalize(btrim(coalesce(p_username, '')), NFKC));
  v_email text;
  v_count integer;
  v_distinct_count integer;
  v_first_hash text;
begin
  if p_request_hash is null or p_request_hash !~ '^[0-9a-f]{64}$'
     or p_invitation_hash is null or p_invitation_hash !~ '^[0-9a-f]{64}$'
     or p_bundle_hash is null or p_bundle_hash !~ '^[0-9a-f]{64}$'
     or p_now is null
     or p_display_name is null or length(btrim(p_display_name)) not between 1 and 80
     or v_username !~ '^[[:alnum:]][[:alnum:]_.@+-]{2,47}$'
     or p_password_hash is null
     or p_password_hash !~ '^pbkdf2-sha256\$[0-9]+\$[A-Za-z0-9_-]+\$[A-Za-z0-9_-]+$'
     or length(p_password_hash) > 256
     or jsonb_typeof(p_code_hashes) is distinct from 'array' then
    return jsonb_build_object('status', 'invalid_input');
  end if;

  select count(*)::integer, count(distinct value)::integer
    into v_count, v_distinct_count
  from jsonb_array_elements_text(p_code_hashes) as codes(value)
  where value ~ '^[0-9a-f]{64}$';
  if jsonb_array_length(p_code_hashes) <> 10 or v_count <> 10 or v_distinct_count <> 10 then
    return jsonb_build_object('status', 'invalid_input');
  end if;
  v_first_hash := p_code_hashes ->> 0;

  perform pg_advisory_xact_lock(hashtextextended('registration-request:' || p_request_hash, 0));

  select * into v_receipt
  from public.registration_request_receipts
  where request_hash = p_request_hash
  for update;

  if found then
    if v_receipt.invitation_hash <> p_invitation_hash
       or v_receipt.username_normalized <> v_username
       or v_receipt.recovery_code_hash <> v_first_hash then
      return jsonb_build_object('status', 'request_conflict');
    end if;
    if not exists (
      select 1 from public.registration_recovery_bundle_receipts r
      where r.request_hash = p_request_hash and r.user_id = v_receipt.user_id
        and r.bundle_hash = p_bundle_hash and r.code_count = 10
    ) then
      return jsonb_build_object('status', 'request_conflict');
    end if;
    if v_receipt.user_id is null or not exists (
      select 1 from public.app_users where id = v_receipt.user_id and status = 'active'
    ) then
      return jsonb_build_object('status', 'request_unavailable');
    end if;
    return jsonb_build_object('status', 'already_created', 'user_id', v_receipt.user_id);
  end if;

  perform pg_advisory_xact_lock(hashtextextended('private-letters-account-cap', 0));

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
  ) values (
    v_username, v_email, btrim(p_display_name), p_password_hash, 'active',
    p_now, p_now, p_now, p_now
  ) returning id into v_user_id;

  insert into public.user_profiles(user_id, display_name, created_at, updated_at)
  values (v_user_id, btrim(p_display_name), p_now, p_now);
  insert into public.user_settings(user_id, created_at, updated_at)
  values (v_user_id, p_now, p_now);
  insert into public.user_recovery_codes(user_id, code_hash, created_at)
  select v_user_id, value, p_now
  from jsonb_array_elements_text(p_code_hashes) as codes(value);

  update public.registration_invites
     set consumed_at = p_now, consumed_user_id = v_user_id
   where id = v_invitation_id and consumed_at is null and revoked_at is null;
  if not found then raise exception 'registration_invitation_race'; end if;

  insert into public.registration_request_receipts(
    request_hash, invitation_hash, username_normalized, recovery_code_hash, user_id, created_at
  ) values (p_request_hash, p_invitation_hash, v_username, v_first_hash, v_user_id, p_now);

  insert into public.registration_recovery_bundle_receipts(request_hash, user_id, bundle_hash, code_count, created_at)
  values (p_request_hash, v_user_id, p_bundle_hash, 10, p_now);

  insert into public.auth_audit_logs(user_id, event_type, occurred_at, metadata)
  values (v_user_id, 'account.registered', p_now,
          jsonb_build_object('method', 'private_invitation', 'recovery_codes_issued', 10,
                             'idempotent_registration', true));
  return jsonb_build_object('status', 'created', 'user_id', v_user_id, 'recovery_code_count', 10);
exception when unique_violation then
  return jsonb_build_object('status', 'username_or_email_exists');
end;
$function$;

revoke all on function public.register_app_user_with_invite_idempotent_bundle(text, text, text, text, text, text, jsonb, timestamptz)
  from public, anon, authenticated;
grant execute on function public.register_app_user_with_invite_idempotent_bundle(text, text, text, text, text, text, jsonb, timestamptz)
  to service_role;

-- Diez códigos de recuperación independientes, de un solo uso y con rotación idempotente.
-- PostgreSQL conserva únicamente hashes SHA-256; el conjunto en claro solo vive
-- temporalmente en el navegador hasta que la persona confirma que lo ha guardado.

create table if not exists public.recovery_code_bundle_receipts (
  request_hash text primary key check (request_hash ~ '^[0-9a-f]{64}$'),
  user_id uuid not null references public.app_users(id) on delete cascade,
  bundle_hash text not null check (bundle_hash ~ '^[0-9a-f]{64}$'),
  code_count smallint not null check (code_count = 10),
  created_at timestamptz not null default now()
);

create index if not exists recovery_code_bundle_receipts_user_idx
  on public.recovery_code_bundle_receipts(user_id, created_at desc);

alter table public.recovery_code_bundle_receipts enable row level security;
revoke all privileges on table public.recovery_code_bundle_receipts from public, anon, authenticated;
grant select, insert, update, delete on table public.recovery_code_bundle_receipts to service_role;

create or replace function public.rotate_app_recovery_codes_bundle(
  p_user_id uuid,
  p_session_id uuid,
  p_request_hash text,
  p_bundle_hash text,
  p_code_hashes jsonb,
  p_now timestamptz default now()
)
returns jsonb
language plpgsql
set search_path to 'pg_catalog', 'public'
as $function$
declare
  v_user public.app_users%rowtype;
  v_receipt public.recovery_code_bundle_receipts%rowtype;
  v_count integer;
  v_distinct_count integer;
  v_active_count integer;
begin
  if p_user_id is null or p_session_id is null
     or p_request_hash is null or p_request_hash !~ '^[0-9a-f]{64}$'
     or p_bundle_hash is null or p_bundle_hash !~ '^[0-9a-f]{64}$'
     or p_now is null or jsonb_typeof(p_code_hashes) is distinct from 'array' then
    return jsonb_build_object('status', 'invalid_input');
  end if;

  select count(*)::integer, count(distinct value)::integer
    into v_count, v_distinct_count
  from jsonb_array_elements_text(p_code_hashes) as codes(value)
  where value ~ '^[0-9a-f]{64}$';
  if jsonb_array_length(p_code_hashes) <> 10
     or v_count <> 10 or v_distinct_count <> 10 then
    return jsonb_build_object('status', 'invalid_input');
  end if;

  -- Bloqueo de petición evita que dos reintentos reemplacen dos veces el conjunto.
  perform pg_advisory_xact_lock(hashtextextended('recovery-code-bundle:' || p_request_hash, 0));

  select * into v_user
  from public.app_users
  where id = p_user_id and status = 'active'
  for update;
  if not found then
    return jsonb_build_object('status', 'not_found');
  end if;

  perform 1 from public.user_sessions
  where id = p_session_id and user_id = p_user_id
    and revoked_at is null
    and idle_expires_at > p_now
    and absolute_expires_at > p_now
    and access_expires_at > p_now
  for update;
  if not found then
    return jsonb_build_object('status', 'session_invalid');
  end if;

  select * into v_receipt
  from public.recovery_code_bundle_receipts
  where request_hash = p_request_hash
  for update;

  if found then
    if v_receipt.user_id <> p_user_id or v_receipt.bundle_hash <> p_bundle_hash then
      return jsonb_build_object('status', 'request_conflict');
    end if;
    select count(*)::integer into v_active_count
    from public.user_recovery_codes
    where user_id = p_user_id and used_at is null;
    if v_active_count = 10 then
      return jsonb_build_object('status', 'already_rotated', 'code_count', 10);
    end if;
    return jsonb_build_object('status', 'request_superseded');
  end if;

  delete from public.user_recovery_codes where user_id = p_user_id;
  insert into public.user_recovery_codes(user_id, code_hash, created_at)
  select p_user_id, value, p_now
  from jsonb_array_elements_text(p_code_hashes) as codes(value);

  -- El recibo del alta idempotente apunta a uno de los nuevos hashes. Esto
  -- permite que el reintento del alta detecte si el código original sigue activo.
  update public.registration_request_receipts
     set recovery_code_hash = p_code_hashes ->> 0
   where user_id = p_user_id;

  insert into public.recovery_code_bundle_receipts(request_hash, user_id, bundle_hash, code_count, created_at)
  values (p_request_hash, p_user_id, p_bundle_hash, 10, p_now);

  insert into public.auth_audit_logs(user_id, event_type, session_id, occurred_at, metadata)
  values (p_user_id, 'account.recovery_code_bundle_rotated', p_session_id, p_now,
          jsonb_build_object('code_count', 10, 'previous_codes_invalidated', true));

  return jsonb_build_object('status', 'rotated', 'code_count', 10);
end;
$function$;

revoke all on function public.rotate_app_recovery_codes_bundle(uuid, uuid, text, text, jsonb, timestamptz)
  from public, anon, authenticated;
grant execute on function public.rotate_app_recovery_codes_bundle(uuid, uuid, text, text, jsonb, timestamptz)
  to service_role;

-- Cuando se utiliza un código para recuperar la contraseña, se invalida todo el
-- conjunto restante. Después del acceso, la persona debe crear un conjunto nuevo.
create or replace function public.consume_app_recovery_code(
  p_username_normalized text,
  p_code_hash text,
  p_new_password_hash text,
  p_now timestamptz default now()
)
returns jsonb
language plpgsql
set search_path to 'pg_catalog', 'public'
as $function$
declare
  v_user public.app_users%rowtype;
  v_code public.user_recovery_codes%rowtype;
begin
  if p_username_normalized is null or p_code_hash is null
     or p_code_hash !~ '^[0-9a-f]{64}$'
     or p_new_password_hash is null
     or p_new_password_hash !~ '^pbkdf2-sha256\$[0-9]+\$[A-Za-z0-9_-]+\$[A-Za-z0-9_-]+$'
     or p_now is null then
    return jsonb_build_object('status', 'invalid');
  end if;

  select * into v_user
  from public.app_users
  where username_normalized = lower(btrim(p_username_normalized)) and status = 'active'
  for update;

  if not found then
    return jsonb_build_object('status', 'invalid');
  end if;

  select * into v_code
  from public.user_recovery_codes
  where user_id = v_user.id and code_hash = p_code_hash and used_at is null
  for update;

  if not found then
    return jsonb_build_object('status', 'invalid');
  end if;

  update public.user_recovery_codes
     set used_at = p_now
   where user_id = v_user.id and used_at is null;

  update public.app_users
  set password_hash = p_new_password_hash,
      password_changed_at = p_now,
      updated_at = p_now
  where id = v_user.id;

  update public.user_sessions
  set revoked_at = coalesce(revoked_at, p_now),
      revocation_reason = 'password_recovery'
  where user_id = v_user.id;

  update public.user_session_refresh_tokens r
  set revoked_at = coalesce(r.revoked_at, p_now)
  from public.user_sessions s
  where r.session_id = s.id and s.user_id = v_user.id;

  insert into public.auth_audit_logs(user_id, event_type, occurred_at, metadata)
  values (v_user.id, 'account.password_recovered', p_now,
          jsonb_build_object('recovery_codes_invalidated', true));

  return jsonb_build_object('status', 'recovered', 'user_id', v_user.id);
end;
$function$;

revoke all on function public.consume_app_recovery_code(text, text, text, timestamptz)
  from public, anon, authenticated;
grant execute on function public.consume_app_recovery_code(text, text, text, timestamptz)
  to service_role;
