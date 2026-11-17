-- Cambio de contraseña atómico y revocación de las demás sesiones.
create or replace function public.change_app_password(
  p_user_id uuid,
  p_current_session_id uuid,
  p_new_password_hash text,
  p_now timestamptz default now()
)
returns jsonb
language plpgsql
set search_path to 'pg_catalog', 'public'
as $function$
begin
  if p_user_id is null
     or p_current_session_id is null
     or p_new_password_hash is null
     or p_new_password_hash !~ '^pbkdf2-sha256\$[0-9]+\$[A-Za-z0-9_-]+\$[A-Za-z0-9_-]+$'
     or length(p_new_password_hash) > 256
     or p_now is null then
    return jsonb_build_object('status', 'invalid_input');
  end if;

  update public.app_users
     set password_hash = p_new_password_hash,
         password_changed_at = p_now,
         updated_at = p_now
   where id = p_user_id and status = 'active';
  if not found then
    return jsonb_build_object('status', 'not_found');
  end if;

  update public.user_session_refresh_tokens r
     set revoked_at = coalesce(r.revoked_at, p_now)
    from public.user_sessions s
   where r.session_id = s.id
     and s.user_id = p_user_id
     and s.id <> p_current_session_id
     and r.revoked_at is null;

  update public.user_sessions
     set revoked_at = coalesce(revoked_at, p_now),
         revocation_reason = 'password_changed',
         access_token_hash = null,
         access_expires_at = p_now
   where user_id = p_user_id
     and id <> p_current_session_id
     and revoked_at is null;

  insert into public.auth_audit_logs(user_id, event_type, occurred_at, metadata)
  values (
    p_user_id,
    'account.password_changed',
    p_now,
    jsonb_build_object('method', 'current_password', 'other_sessions_revoked', true)
  );

  return jsonb_build_object('status', 'changed');
end;
$function$;

revoke execute on function public.change_app_password(uuid, uuid, text, timestamptz) from public, anon, authenticated;
grant execute on function public.change_app_password(uuid, uuid, text, timestamptz) to service_role;
