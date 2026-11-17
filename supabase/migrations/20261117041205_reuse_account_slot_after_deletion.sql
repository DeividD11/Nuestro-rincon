-- Una cuenta deshabilitada tras una baja ya no consume uno de los dos espacios.
create or replace function public.register_app_user_without_email(
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
  v_account_count integer;
  v_username text := lower(normalize(btrim(coalesce(p_username, '')), NFKC));
  v_email text;
begin
  perform pg_advisory_xact_lock(hashtextextended('private-letters-account-cap', 0));
  select count(*)::integer into v_account_count
  from public.app_users
  where status in ('active', 'pending_email');

  if v_account_count >= 2 then
    return jsonb_build_object('status', 'account_limit_reached');
  end if;

  if p_display_name is null or length(btrim(p_display_name)) not between 1 and 80
     or v_username !~ '^[[:alnum:]][[:alnum:]_.@+-]{2,47}$'
     or p_password_hash is null or p_password_hash !~ '^pbkdf2-sha256\$[0-9]+\$[A-Za-z0-9_-]+\$[A-Za-z0-9_-]+$'
     or length(p_password_hash) > 256
     or p_recovery_code_hash is null or p_recovery_code_hash !~ '^[0-9a-f]{64}$'
     or p_now is null then
    return jsonb_build_object('status', 'invalid_input');
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

  insert into public.auth_audit_logs(user_id, event_type, occurred_at, metadata)
  values (v_user_id, 'account.registered', p_now,
          jsonb_build_object('method', 'username_password', 'recovery_code_issued', true));

  return jsonb_build_object('status', 'created', 'user_id', v_user_id);
exception when unique_violation then
  return jsonb_build_object('status', 'username_or_email_exists');
end;
$function$;

revoke execute on function public.register_app_user_without_email(text, text, text, text, timestamptz) from public, anon, authenticated;
grant execute on function public.register_app_user_without_email(text, text, text, text, timestamptz) to service_role;
