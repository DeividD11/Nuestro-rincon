-- Entrega recuperable del código de recuperación e idempotencia de registro.
-- El navegador genera el código y lo conserva temporalmente en localStorage.
-- PostgreSQL guarda únicamente sus hashes y una huella de la petición.

create table if not exists public.registration_request_receipts (
  request_hash text primary key check (request_hash ~ '^[0-9a-f]{64}$'),
  invitation_hash text not null unique check (invitation_hash ~ '^[0-9a-f]{64}$'),
  username_normalized text not null check (length(username_normalized) between 3 and 48),
  recovery_code_hash text not null check (recovery_code_hash ~ '^[0-9a-f]{64}$'),
  user_id uuid references public.app_users(id) on delete set null,
  created_at timestamptz not null default now()
);

create index if not exists registration_request_receipts_user_idx
  on public.registration_request_receipts (user_id);
create index if not exists registration_request_receipts_created_idx
  on public.registration_request_receipts (created_at);

alter table public.registration_request_receipts enable row level security;
revoke all privileges on table public.registration_request_receipts from public, anon, authenticated;
grant select, insert, update, delete on table public.registration_request_receipts to service_role;

create table if not exists public.recovery_code_rotation_receipts (
  request_hash text primary key check (request_hash ~ '^[0-9a-f]{64}$'),
  user_id uuid not null references public.app_users(id) on delete cascade,
  recovery_code_hash text not null check (recovery_code_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null default now()
);

create index if not exists recovery_code_rotation_receipts_user_idx
  on public.recovery_code_rotation_receipts (user_id, created_at desc);

alter table public.recovery_code_rotation_receipts enable row level security;
revoke all privileges on table public.recovery_code_rotation_receipts from public, anon, authenticated;
grant select, insert, update, delete on table public.recovery_code_rotation_receipts to service_role;

-- La misma clave de petición y el mismo código permiten recuperar una operación
-- ya confirmada aunque la respuesta HTTP original se haya perdido.
create or replace function public.register_app_user_with_invite_idempotent(
  p_request_hash text,
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
  v_receipt public.registration_request_receipts%rowtype;
  v_invitation_id uuid;
  v_user_id uuid;
  v_account_count integer;
  v_username text := lower(normalize(btrim(coalesce(p_username, '')), NFKC));
  v_email text;
begin
  if p_request_hash is null or p_request_hash !~ '^[0-9a-f]{64}$'
     or p_invitation_hash is null or p_invitation_hash !~ '^[0-9a-f]{64}$'
     or p_now is null
     or p_display_name is null or length(btrim(p_display_name)) not between 1 and 80
     or v_username !~ '^[[:alnum:]][[:alnum:]_.@+-]{2,47}$'
     or p_password_hash is null
     or p_password_hash !~ '^pbkdf2-sha256\$[0-9]+\$[A-Za-z0-9_-]+\$[A-Za-z0-9_-]+$'
     or length(p_password_hash) > 256
     or p_recovery_code_hash is null or p_recovery_code_hash !~ '^[0-9a-f]{64}$' then
    return jsonb_build_object('status', 'invalid_input');
  end if;

  -- La clave de idempotencia se bloquea primero. Dos reintentos simultáneos
  -- quedan serializados y el segundo observa el recibo creado por el primero.
  perform pg_advisory_xact_lock(hashtextextended('registration-request:' || p_request_hash, 0));

  select * into v_receipt
  from public.registration_request_receipts
  where request_hash = p_request_hash
  for update;

  if found then
    if v_receipt.invitation_hash <> p_invitation_hash
       or v_receipt.username_normalized <> v_username
       or v_receipt.recovery_code_hash <> p_recovery_code_hash then
      return jsonb_build_object('status', 'request_conflict');
    end if;
    if v_receipt.user_id is null or not exists (
      select 1 from public.app_users where id = v_receipt.user_id and status = 'active'
    ) then
      return jsonb_build_object('status', 'request_unavailable');
    end if;
    return jsonb_build_object('status', 'already_created', 'user_id', v_receipt.user_id);
  end if;

  -- Se conserva el límite de dos cuentas y el consumo de invitación en la misma
  -- transacción que crea cuenta, perfil, preferencias, código y recibo.
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

  insert into public.registration_request_receipts(
    request_hash, invitation_hash, username_normalized, recovery_code_hash, user_id, created_at
  ) values (
    p_request_hash, p_invitation_hash, v_username, p_recovery_code_hash, v_user_id, p_now
  );

  insert into public.auth_audit_logs(user_id, event_type, occurred_at, metadata)
  values (v_user_id, 'account.registered', p_now,
          jsonb_build_object('method', 'private_invitation', 'recovery_code_issued', true,
                             'idempotent_registration', true));

  return jsonb_build_object('status', 'created', 'user_id', v_user_id);
exception when unique_violation then
  return jsonb_build_object('status', 'username_or_email_exists');
end;
$function$;

-- Regenera el código bajo contraseña verificada en auth-api y sesión vigente.
-- La transacción invalida todos los códigos anteriores e inserta solo el nuevo.
create or replace function public.rotate_app_recovery_code(
  p_user_id uuid,
  p_session_id uuid,
  p_request_hash text,
  p_recovery_code_hash text,
  p_now timestamptz default now()
)
returns jsonb
language plpgsql
set search_path to 'pg_catalog', 'public'
as $function$
declare
  v_user public.app_users%rowtype;
  v_receipt public.recovery_code_rotation_receipts%rowtype;
begin
  if p_user_id is null or p_session_id is null
     or p_request_hash is null or p_request_hash !~ '^[0-9a-f]{64}$'
     or p_recovery_code_hash is null or p_recovery_code_hash !~ '^[0-9a-f]{64}$'
     or p_now is null then
    return jsonb_build_object('status', 'invalid_input');
  end if;

  perform pg_advisory_xact_lock(hashtextextended('recovery-code-rotation:' || p_request_hash, 0));

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
  from public.recovery_code_rotation_receipts
  where request_hash = p_request_hash
  for update;

  if found then
    if v_receipt.user_id <> p_user_id or v_receipt.recovery_code_hash <> p_recovery_code_hash then
      return jsonb_build_object('status', 'request_conflict');
    end if;
    if exists (
      select 1 from public.user_recovery_codes
      where user_id = p_user_id and code_hash = p_recovery_code_hash and used_at is null
    ) then
      return jsonb_build_object('status', 'already_rotated');
    end if;
    return jsonb_build_object('status', 'request_superseded');
  end if;

  delete from public.user_recovery_codes where user_id = p_user_id;
  insert into public.user_recovery_codes(user_id, code_hash, created_at)
  values (p_user_id, p_recovery_code_hash, p_now);

  -- Si todavía quedaba un recibo de alta en el navegador, su código antiguo
  -- deja de ser válido para reintentos. El nuevo código queda asociado al alta.
  update public.registration_request_receipts
     set recovery_code_hash = p_recovery_code_hash
   where user_id = p_user_id;

  insert into public.recovery_code_rotation_receipts(request_hash, user_id, recovery_code_hash, created_at)
  values (p_request_hash, p_user_id, p_recovery_code_hash, p_now);

  insert into public.auth_audit_logs(user_id, event_type, session_id, occurred_at, metadata)
  values (p_user_id, 'account.recovery_code_rotated', p_session_id, p_now,
          jsonb_build_object('method', 'current_password', 'previous_codes_invalidated', true));

  return jsonb_build_object('status', 'rotated');
end;
$function$;

-- El RPC anterior ya no debe permitir altas sin clave de idempotencia.
revoke all on function public.register_app_user_with_invite(text, text, text, text, text, timestamptz)
  from public, anon, authenticated, service_role;
revoke all on function public.register_app_user_with_invite_idempotent(text, text, text, text, text, text, timestamptz)
  from public, anon, authenticated;
revoke all on function public.rotate_app_recovery_code(uuid, uuid, text, text, timestamptz)
  from public, anon, authenticated;
grant execute on function public.register_app_user_with_invite_idempotent(text, text, text, text, text, text, timestamptz)
  to service_role;
grant execute on function public.rotate_app_recovery_code(uuid, uuid, text, text, timestamptz)
  to service_role;
