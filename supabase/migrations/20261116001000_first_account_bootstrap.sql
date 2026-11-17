-- First-account provisioning without an invitation token.
-- The only caller is auth-api, which checks APP_BOOTSTRAP_SECRET before RPC.
-- This RPC shares the same advisory lock as create_app_invitation and
-- accept_app_invitation so two simultaneous first-account requests cannot win.
begin;

create or replace function public.create_first_app_user(
  p_email text,
  p_display_name text,
  p_username text,
  p_password_hash text,
  p_recovery_hashes text[],
  p_now timestamptz default now()
)
returns jsonb
language plpgsql
set search_path to 'pg_catalog', 'public'
as $function$
declare
  v_user_id uuid;
  v_user_count integer;
  v_hash text;
begin
  perform pg_advisory_xact_lock(hashtextextended('private-letters-account-cap', 0));

  select count(*)::integer into v_user_count from public.app_users;
  if v_user_count > 0 then
    return jsonb_build_object('status', 'bootstrap_already_used');
  end if;

  if exists (
    select 1
    from public.invitations
    where accepted_at is null
      and revoked_at is null
      and expires_at > p_now
  ) then
    return jsonb_build_object('status', 'bootstrap_invitation_pending');
  end if;

  if p_email is null
     or length(btrim(p_email)) < 3
     or length(btrim(p_email)) > 254
     or btrim(p_email) !~* '^\S+@\S+\.\S+$'
     or p_display_name is null
     or length(btrim(p_display_name)) not between 1 and 100
     or p_username is null
     or lower(btrim(p_username)) !~ '^[a-z0-9][a-z0-9._-]{2,47}$'
     or p_password_hash is null
     or length(p_password_hash) < 30
     or coalesce(cardinality(p_recovery_hashes), 0) not between 8 and 12
     or (select count(distinct item.hash) from unnest(p_recovery_hashes) as item(hash)) <> cardinality(p_recovery_hashes)
     or exists (
       select 1 from unnest(p_recovery_hashes) as item(hash)
       where item.hash !~ '^[0-9a-f]{64}$'
     ) then
    return jsonb_build_object('status', 'invalid_input');
  end if;

  insert into public.app_users(username, email, display_name, password_hash, created_at, updated_at)
  values (lower(btrim(p_username)), lower(btrim(p_email)), btrim(p_display_name), p_password_hash, p_now, p_now)
  returning id into v_user_id;

  foreach v_hash in array p_recovery_hashes loop
    insert into public.user_recovery_codes(user_id, code_hash, created_at)
    values (v_user_id, v_hash, p_now);
  end loop;

  insert into public.auth_audit_logs(user_id, event_type, occurred_at)
  values (v_user_id, 'account.bootstrap_created', p_now);

  return jsonb_build_object('status', 'created', 'user_id', v_user_id);
exception when unique_violation then
  return jsonb_build_object('status', 'username_or_email_exists');
end;
$function$;

revoke execute on function public.create_first_app_user(text, text, text, text, text[], timestamptz)
  from public, anon, authenticated;
grant execute on function public.create_first_app_user(text, text, text, text, text[], timestamptz)
  to service_role;

commit;
