create or replace function public.delete_app_account(
  p_user_id uuid,
  p_current_session_id uuid,
  p_now timestamptz default now()
)
returns jsonb
language plpgsql
set search_path to 'pg_catalog', 'public'
as $function$
declare
  v_user public.app_users%rowtype;
  v_draft_ids uuid[];
  v_deleted_username text;
  v_deleted_email text;
begin
  if p_user_id is null or p_current_session_id is null or p_now is null then
    return jsonb_build_object('status', 'invalid_input');
  end if;

  select * into v_user
  from public.app_users
  where id = p_user_id and status = 'active'
  for update;
  if not found then return jsonb_build_object('status', 'not_found'); end if;

  if not exists (
    select 1 from public.user_sessions s
    where s.id = p_current_session_id
      and s.user_id = p_user_id
      and s.revoked_at is null
      and s.absolute_expires_at > p_now
      and s.idle_expires_at > p_now
  ) then
    return jsonb_build_object('status', 'session_invalid');
  end if;

  select coalesce(array_agg(l.id), '{}'::uuid[]) into v_draft_ids
  from public.letters l
  where l.sender_id = p_user_id
    and l.status = 'draft'
    and l.content_purged_at is null;

  if cardinality(v_draft_ids) > 0 then
    delete from public.notifications where letter_id = any(v_draft_ids);
    delete from public.letter_user_state where letter_id = any(v_draft_ids);
    delete from public.letter_versions where letter_id = any(v_draft_ids);
    delete from public.letters where id = any(v_draft_ids);
  end if;

  -- Borra preferencias y estados privados. Las cartas enviadas se conservan
  -- para el buzón del otro participante; su autor queda anonimizado.
  delete from public.letter_user_state where user_id = p_user_id;
  delete from public.notifications where user_id = p_user_id;
  update public.notifications set actor_user_id = null where actor_user_id = p_user_id;
  delete from public.invitations where invited_by = p_user_id or accepted_user_id = p_user_id;
  delete from public.app_email_action_tokens where user_id = p_user_id;
  delete from public.user_recovery_codes where user_id = p_user_id;
  delete from public.user_sessions where user_id = p_user_id;
  delete from public.user_settings where user_id = p_user_id;
  delete from public.user_profiles where user_id = p_user_id;
  delete from public.auth_audit_logs where user_id = p_user_id;

  delete from public.letter_threads t
  where (t.participant_a_id = p_user_id
      or t.participant_b_id = p_user_id
      or t.created_by_user_id = p_user_id)
    and not exists (select 1 from public.letters l where l.thread_id = t.id);

  v_deleted_username := 'eliminado-' || substr(replace(p_user_id::text, '-', ''), 1, 16);
  v_deleted_email := v_deleted_username || '@accounts.nuestro-rincon.invalid';

  update public.app_users
     set username = v_deleted_username,
         email = v_deleted_email,
         display_name = 'Cuenta eliminada',
         password_hash = 'disabled$' || replace(gen_random_uuid()::text, '-', ''),
         status = 'disabled',
         last_login_at = null,
         email_verified_at = null,
         password_changed_at = p_now,
         updated_at = p_now
   where id = p_user_id;

  return jsonb_build_object(
    'status', 'deleted',
    'shared_letters_preserved', true,
    'drafts_deleted', cardinality(v_draft_ids)
  );
end;
$function$;

revoke execute on function public.register_app_user_without_email(text, text, text, text, timestamptz) from public, anon, authenticated;
revoke execute on function public.delete_app_account(uuid, uuid, timestamptz) from public, anon, authenticated;
grant execute on function public.register_app_user_without_email(text, text, text, text, timestamptz) to service_role;
grant execute on function public.delete_app_account(uuid, uuid, timestamptz) to service_role;
