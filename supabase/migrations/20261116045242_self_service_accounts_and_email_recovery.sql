-- Public self-service registration for the two private participants.
-- Email ownership is verified before login is allowed. Password recovery uses
-- one-time email links; no Supabase Auth is involved.
begin;

alter table public.app_users
  add column if not exists email_verified_at timestamptz;

alter table public.app_users
  drop constraint if exists app_users_status_check;

alter table public.app_users
  add constraint app_users_status_check
  check (status = any (array['active'::text, 'disabled'::text, 'pending_email'::text]));

create table if not exists public.app_email_action_tokens (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.app_users(id) on delete cascade,
  purpose text not null check (purpose in ('verify_email', 'password_reset')),
  token_hash text not null unique check (token_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  consumed_at timestamptz,
  constraint app_email_action_tokens_expiry_chk check (expires_at > created_at)
);

create index if not exists app_email_action_tokens_user_purpose_idx
  on public.app_email_action_tokens(user_id, purpose, created_at desc);
create index if not exists app_email_action_tokens_expiry_idx
  on public.app_email_action_tokens(expires_at)
  where consumed_at is null;

alter table public.app_email_action_tokens enable row level security;
revoke all on table public.app_email_action_tokens from public, anon, authenticated;
grant select, insert, update, delete on table public.app_email_action_tokens to service_role;

-- Registration is limited to the two accounts supported by this private space.
-- The advisory lock serializes competing signups; unverified accounts reserve
-- a slot until verified or manually removed by an administrator.
create or replace function public.register_app_user(
  p_email text,
  p_display_name text,
  p_username text,
  p_password_hash text,
  p_verification_token_hash text,
  p_token_expires_at timestamptz,
  p_now timestamptz default now()
)
returns jsonb
language plpgsql
set search_path to 'pg_catalog', 'public'
as $function$
declare
  v_user_id uuid;
  v_account_count integer;
begin
  perform pg_advisory_xact_lock(hashtextextended('private-letters-account-cap', 0));

  select count(*)::integer into v_account_count from public.app_users;
  if v_account_count >= 2 then
    return jsonb_build_object('status', 'account_limit_reached');
  end if;

  if p_email is null or length(btrim(p_email)) < 3 or length(btrim(p_email)) > 254
     or btrim(p_email) !~* '^[^[:space:]@]+@[^[:space:]@]+[.][^[:space:]@]+$'
     or p_display_name is null or length(btrim(p_display_name)) not between 1 and 80
     or p_username is null or lower(btrim(p_username)) !~ '^[a-z0-9][a-z0-9._-]{2,47}$'
     or p_password_hash is null or length(p_password_hash) < 30
     or p_verification_token_hash is null or p_verification_token_hash !~ '^[0-9a-f]{64}$'
     or p_token_expires_at is null or p_token_expires_at <= p_now then
    return jsonb_build_object('status', 'invalid_input');
  end if;

  insert into public.app_users(username, email, display_name, password_hash, status, created_at, updated_at)
  values (lower(btrim(p_username)), lower(btrim(p_email)), btrim(p_display_name), p_password_hash, 'pending_email', p_now, p_now)
  returning id into v_user_id;

  insert into public.user_profiles(user_id, display_name, created_at, updated_at)
  values (v_user_id, btrim(p_display_name), p_now, p_now);

  insert into public.user_settings(user_id, created_at, updated_at)
  values (v_user_id, p_now, p_now);

  insert into public.app_email_action_tokens(user_id, purpose, token_hash, created_at, expires_at)
  values (v_user_id, 'verify_email', p_verification_token_hash, p_now, p_token_expires_at);

  insert into public.auth_audit_logs(user_id, event_type, occurred_at, metadata)
  values (v_user_id, 'account.registration_started', p_now, jsonb_build_object('email_verified', false));

  return jsonb_build_object('status', 'created', 'user_id', v_user_id);
exception when unique_violation then
  return jsonb_build_object('status', 'username_or_email_exists');
end;
$function$;

create or replace function public.create_app_email_action_token(
  p_user_id uuid,
  p_purpose text,
  p_token_hash text,
  p_expires_at timestamptz,
  p_now timestamptz default now()
)
returns jsonb
language plpgsql
set search_path to 'pg_catalog', 'public'
as $function$
declare
  v_status text;
begin
  if p_user_id is null or p_purpose is null or p_purpose not in ('verify_email', 'password_reset')
     or p_token_hash is null or p_token_hash !~ '^[0-9a-f]{64}$'
     or p_expires_at is null or p_expires_at <= p_now then
    return jsonb_build_object('status', 'invalid_input');
  end if;

  select status into v_status from public.app_users where id = p_user_id for update;
  if not found then return jsonb_build_object('status', 'not_found'); end if;
  if (p_purpose = 'verify_email' and v_status <> 'pending_email')
     or (p_purpose = 'password_reset' and v_status <> 'active') then
    return jsonb_build_object('status', 'not_available');
  end if;

  update public.app_email_action_tokens
     set consumed_at = coalesce(consumed_at, p_now)
   where user_id = p_user_id and purpose = p_purpose and consumed_at is null;

  insert into public.app_email_action_tokens(user_id, purpose, token_hash, created_at, expires_at)
  values (p_user_id, p_purpose, p_token_hash, p_now, p_expires_at);

  return jsonb_build_object('status', 'created');
exception when unique_violation then
  return jsonb_build_object('status', 'invalid_input');
end;
$function$;

create or replace function public.consume_app_email_action_token(
  p_token_hash text,
  p_purpose text,
  p_new_password_hash text default null,
  p_now timestamptz default now()
)
returns jsonb
language plpgsql
set search_path to 'pg_catalog', 'public'
as $function$
declare
  v_token public.app_email_action_tokens%rowtype;
  v_user public.app_users%rowtype;
begin
  if p_token_hash is null or p_token_hash !~ '^[0-9a-f]{64}$'
     or p_purpose is null or p_purpose not in ('verify_email', 'password_reset') then
    return jsonb_build_object('status', 'invalid');
  end if;

  select * into v_token
    from public.app_email_action_tokens
   where token_hash = p_token_hash and purpose = p_purpose
   for update;

  if not found or v_token.consumed_at is not null or v_token.expires_at <= p_now then
    return jsonb_build_object('status', 'invalid');
  end if;

  select * into v_user from public.app_users where id = v_token.user_id for update;
  if not found then return jsonb_build_object('status', 'invalid'); end if;

  if p_purpose = 'verify_email' then
    if v_user.status <> 'pending_email' then
      return jsonb_build_object('status', 'invalid');
    end if;
    update public.app_users
       set status = 'active', email_verified_at = p_now, updated_at = p_now
     where id = v_user.id;
    update public.app_email_action_tokens
       set consumed_at = p_now
     where id = v_token.id;
    insert into public.auth_audit_logs(user_id, event_type, occurred_at, metadata)
    values (v_user.id, 'account.email_verified', p_now, jsonb_build_object('method', 'email_link'));
    return jsonb_build_object('status', 'verified', 'user_id', v_user.id);
  end if;

  if v_user.status <> 'active' or p_new_password_hash is null or length(p_new_password_hash) < 30 then
    return jsonb_build_object('status', 'invalid');
  end if;

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
  update public.app_email_action_tokens
     set consumed_at = p_now
   where id = v_token.id;
  insert into public.auth_audit_logs(user_id, event_type, occurred_at, metadata)
  values (v_user.id, 'account.password_recovered', p_now, jsonb_build_object('method', 'email_link'));

  return jsonb_build_object('status', 'password_reset', 'user_id', v_user.id);
end;
$function$;

revoke execute on function public.register_app_user(text, text, text, text, text, timestamptz, timestamptz)
  from public, anon, authenticated;
revoke execute on function public.create_app_email_action_token(uuid, text, text, timestamptz, timestamptz)
  from public, anon, authenticated;
revoke execute on function public.consume_app_email_action_token(text, text, text, timestamptz)
  from public, anon, authenticated;
grant execute on function public.register_app_user(text, text, text, text, text, timestamptz, timestamptz)
  to service_role;
grant execute on function public.create_app_email_action_token(uuid, text, text, timestamptz, timestamptz)
  to service_role;
grant execute on function public.consume_app_email_action_token(text, text, text, timestamptz)
  to service_role;

commit;
