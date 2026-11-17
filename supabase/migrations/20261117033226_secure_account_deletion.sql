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
