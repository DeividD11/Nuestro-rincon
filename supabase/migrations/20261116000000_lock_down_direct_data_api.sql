-- Nuestro Rincón: endurecimiento aditivo del modelo ya creado en el proyecto indicado.
-- Esta migración NO recrea el esquema base. Ver docs/REMOTE_BASELINE.md antes de aplicarla.
begin;

do $$
declare
  required_tables text[] := array[
    'app_users','invitations','user_session_refresh_tokens','login_attempts',
    'auth_login_challenges','user_recovery_codes','auth_audit_logs','user_sessions',
    'letter_threads','letters','user_profiles','user_settings','letter_versions',
    'letter_user_state','notifications'
  ];
  item text;
  rel oid;
begin
  foreach item in array required_tables loop
    rel := to_regclass(format('public.%I', item));
    if rel is null then
      raise exception 'Falta la tabla requerida public.%', item;
    end if;
    if not (select c.relrowsecurity from pg_class c where c.oid = rel) then
      raise exception 'RLS debe estar activado en public.%', item;
    end if;
  end loop;
end $$;

-- La web pública nunca consulta estas tablas directamente. Las funciones Edge
-- usan el secreto servidor y validan el token/sesión antes de cada operación.
revoke all privileges on table
  public.app_users,
  public.invitations,
  public.user_session_refresh_tokens,
  public.login_attempts,
  public.auth_login_challenges,
  public.user_recovery_codes,
  public.auth_audit_logs,
  public.user_sessions,
  public.letter_threads,
  public.letters,
  public.user_profiles,
  public.user_settings,
  public.letter_versions,
  public.letter_user_state,
  public.notifications
from public, anon, authenticated;

grant select, insert, update, delete on table
  public.app_users,
  public.invitations,
  public.user_session_refresh_tokens,
  public.login_attempts,
  public.auth_login_challenges,
  public.user_recovery_codes,
  public.auth_audit_logs,
  public.user_sessions,
  public.letter_threads,
  public.letters,
  public.user_profiles,
  public.user_settings,
  public.letter_versions,
  public.letter_user_state,
  public.notifications
to service_role;

-- Revoca la ejecución pública predeterminada de las funciones RPC de la app.
revoke execute on function public.start_app_login_attempt(text, timestamptz) from public, anon, authenticated;
revoke execute on function public.complete_app_login_attempt(uuid, boolean, timestamptz) from public, anon, authenticated;
revoke execute on function public.start_app_login_challenge(text, text, timestamptz) from public, anon, authenticated;
revoke execute on function public.create_app_session_with_refresh(uuid, uuid, timestamptz, timestamptz, text, text, text, timestamptz) from public, anon, authenticated;
revoke execute on function public.create_app_invitation(text, text, text, timestamptz, timestamptz) from public, anon, authenticated;
revoke execute on function public.accept_app_invitation(text, text, text, text[], timestamptz) from public, anon, authenticated;
revoke execute on function public.rotate_app_refresh_token(text, text, timestamptz) from public, anon, authenticated;
revoke execute on function public.consume_app_recovery_code(text, text, text, timestamptz) from public, anon, authenticated;
revoke execute on function public.create_letter_draft(uuid, uuid, text, text) from public, anon, authenticated;
revoke execute on function public.save_letter_draft(uuid, uuid, text, text, integer) from public, anon, authenticated;
revoke execute on function public.send_letter_draft(uuid, uuid, integer) from public, anon, authenticated;
revoke execute on function public.create_letter_reply(uuid, uuid, uuid, text, text) from public, anon, authenticated;
revoke execute on function public.mark_thread_letters_read(uuid, uuid) from public, anon, authenticated;
revoke execute on function public.set_letter_favorite_state(uuid, uuid, boolean) from public, anon, authenticated;
revoke execute on function public.set_letter_archive_state(uuid, uuid, boolean) from public, anon, authenticated;
revoke execute on function public.move_letter_to_trash(uuid, uuid) from public, anon, authenticated;
revoke execute on function public.restore_letter_from_trash(uuid, uuid) from public, anon, authenticated;
revoke execute on function public.empty_user_letter_trash(uuid) from public, anon, authenticated;
revoke execute on function public.search_user_letters(uuid, text, integer, text, text, timestamptz, timestamptz) from public, anon, authenticated;
revoke execute on function public.confirm_letter_permanent_deletion(uuid, uuid) from public, anon, authenticated;

grant execute on function public.start_app_login_attempt(text, timestamptz) to service_role;
grant execute on function public.complete_app_login_attempt(uuid, boolean, timestamptz) to service_role;
grant execute on function public.start_app_login_challenge(text, text, timestamptz) to service_role;
grant execute on function public.create_app_session_with_refresh(uuid, uuid, timestamptz, timestamptz, text, text, text, timestamptz) to service_role;
grant execute on function public.create_app_invitation(text, text, text, timestamptz, timestamptz) to service_role;
grant execute on function public.accept_app_invitation(text, text, text, text[], timestamptz) to service_role;
grant execute on function public.rotate_app_refresh_token(text, text, timestamptz) to service_role;
grant execute on function public.consume_app_recovery_code(text, text, text, timestamptz) to service_role;
grant execute on function public.create_letter_draft(uuid, uuid, text, text) to service_role;
grant execute on function public.save_letter_draft(uuid, uuid, text, text, integer) to service_role;
grant execute on function public.send_letter_draft(uuid, uuid, integer) to service_role;
grant execute on function public.create_letter_reply(uuid, uuid, uuid, text, text) to service_role;
grant execute on function public.mark_thread_letters_read(uuid, uuid) to service_role;
grant execute on function public.set_letter_favorite_state(uuid, uuid, boolean) to service_role;
grant execute on function public.set_letter_archive_state(uuid, uuid, boolean) to service_role;
grant execute on function public.move_letter_to_trash(uuid, uuid) to service_role;
grant execute on function public.restore_letter_from_trash(uuid, uuid) to service_role;
grant execute on function public.empty_user_letter_trash(uuid) to service_role;
grant execute on function public.search_user_letters(uuid, text, integer, text, text, timestamptz, timestamptz) to service_role;
grant execute on function public.confirm_letter_permanent_deletion(uuid, uuid) to service_role;

commit;
