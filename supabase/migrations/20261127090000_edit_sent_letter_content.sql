-- Permite editar explícitamente contenido enviado sin romper la identidad del hilo.
-- Cada edición conserva la versión previa y exige remitente + revisión esperada.
begin;

create or replace function public.guard_letter_participants_and_immutability()
returns trigger
language plpgsql
set search_path to 'pg_catalog', 'public'
as $function$
declare
  v_a uuid;
  v_b uuid;
  v_parent_status text;
  v_parent_created_at timestamptz;
  v_recipient_binding_allowed boolean := false;
  v_sent_content_edit_allowed boolean := false;
  v_validate_reply_parent boolean := false;
begin
  select participant_a_id, participant_b_id
    into v_a, v_b
  from public.letter_threads
  where id = new.thread_id;

  if not found then
    raise exception 'LETTER_THREAD_NOT_FOUND' using errcode = '23503';
  end if;

  if not (
    (new.sender_id = v_a and new.recipient_id = v_b)
    or (new.sender_id = v_b and new.recipient_id = v_a)
  ) then
    raise exception 'LETTER_PARTICIPANTS_INVALID' using errcode = '23514';
  end if;

  if tg_op = 'INSERT' then
    v_validate_reply_parent := true;
  else
    v_validate_reply_parent :=
      new.reply_to_letter_id is distinct from old.reply_to_letter_id
      or new.thread_id is distinct from old.thread_id;
  end if;

  if v_validate_reply_parent and new.reply_to_letter_id is not null then
    select status, created_at
      into v_parent_status, v_parent_created_at
    from public.letters
    where id = new.reply_to_letter_id
      and thread_id = new.thread_id;

    if not found or v_parent_status <> 'sent' or v_parent_created_at >= new.created_at then
      raise exception 'LETTER_REPLY_PARENT_INVALID' using errcode = '23514';
    end if;
  end if;

  if tg_op = 'UPDATE' then
    v_recipient_binding_allowed :=
      old.status = 'draft'
      and old.recipient_id is null
      and new.recipient_id is not null
      and new.sender_id = old.sender_id
      and new.thread_id = old.thread_id
      and new.reply_to_letter_id is not distinct from old.reply_to_letter_id
      and new.created_at is not distinct from old.created_at
      and (
        (new.sender_id = v_a and new.recipient_id = v_b)
        or (new.sender_id = v_b and new.recipient_id = v_a)
      );

    if new.sender_id is distinct from old.sender_id
       or (new.recipient_id is distinct from old.recipient_id and not v_recipient_binding_allowed)
       or new.thread_id is distinct from old.thread_id
       or new.reply_to_letter_id is distinct from old.reply_to_letter_id
       or new.created_at is distinct from old.created_at then
      raise exception 'LETTER_IDENTITY_IMMUTABLE' using errcode = '23000';
    end if;

    if old.status = 'sent' then
      v_sent_content_edit_allowed :=
        current_setting('app.letter_editor_user_id', true) = old.sender_id::text
        and new.status = 'sent'
        and new.content_purged_at is not distinct from old.content_purged_at
        and new.title is not null
        and new.body is not null
        and new.sent_at is not distinct from old.sent_at
        and new.revision = old.revision + 1
        and new.updated_at > old.updated_at;

      if not v_sent_content_edit_allowed then
        if new.status <> 'purged'
           or new.content_purged_at is null
           or new.title is not null
           or new.body is not null
           or new.sent_at is distinct from old.sent_at
           or new.revision <> old.revision then
          raise exception 'LETTER_SENT_IMMUTABLE' using errcode = '23000';
        end if;
      end if;
    elsif old.status <> 'draft' then
      raise exception 'LETTER_STATE_TRANSITION_INVALID' using errcode = '23000';
    end if;
  end if;

  return new;
end;
$function$;

-- Edición explícita y versionada de cartas/respuestas ya enviadas. El permiso
-- temporal usado por el trigger solo se establece dentro de esta RPC y exige
-- que el editor sea el remitente original.
create or replace function public.edit_sent_letter_content(
  p_sender_id uuid,
  p_letter_id uuid,
  p_title text,
  p_body text,
  p_expected_revision integer
)
returns jsonb
language plpgsql
set search_path to 'pg_catalog', 'public'
as $function$
declare
  v_letter public.letters%rowtype;
  v_state public.letter_user_state%rowtype;
  v_next_version integer;
begin
  if p_sender_id is null or p_letter_id is null or p_title is null or p_body is null
     or p_expected_revision is null or p_expected_revision < 1
     or char_length(p_title) > 180 or char_length(p_body) > 100000
     or btrim(regexp_replace(regexp_replace(p_body, '<[^>]*>', '', 'g'), '&nbsp;', '', 'gi')) = '' then
    raise exception 'LETTER_EDIT_INPUT_INVALID' using errcode = '22023';
  end if;

  select * into v_letter
  from public.letters
  where id = p_letter_id
  for update;

  if not found
     or v_letter.sender_id is distinct from p_sender_id
     or v_letter.status <> 'sent'
     or v_letter.content_purged_at is not null then
    return jsonb_build_object('status', 'not_found');
  end if;

  select * into v_state
  from public.letter_user_state
  where letter_id = p_letter_id and user_id = p_sender_id
  for update;

  if not found or v_state.trashed_at is not null then
    return jsonb_build_object('status', 'not_found');
  end if;

  if v_letter.title is not distinct from p_title and v_letter.body is not distinct from p_body then
    return jsonb_build_object('status', 'saved', 'revision', v_letter.revision, 'unchanged', true);
  end if;

  if v_letter.revision <> p_expected_revision then
    return jsonb_build_object('status', 'conflict', 'revision', v_letter.revision);
  end if;

  select coalesce(max(version_no), 0) + 1 into v_next_version
  from public.letter_versions
  where letter_id = v_letter.id;

  insert into public.letter_versions(
    letter_id, version_no, created_by_user_id, title_snapshot, body_snapshot
  ) values (
    v_letter.id, v_next_version, p_sender_id, v_letter.title, v_letter.body
  );

  perform set_config('app.letter_editor_user_id', p_sender_id::text, true);

  update public.letters
  set title = p_title,
      body = p_body,
      revision = revision + 1,
      updated_at = clock_timestamp()
  where id = v_letter.id
  returning * into v_letter;

  update public.letter_threads
  set last_activity_at = v_letter.updated_at
  where id = v_letter.thread_id;

  return jsonb_build_object(
    'status', 'saved',
    'revision', v_letter.revision,
    'letter', jsonb_build_object(
      'id', v_letter.id,
      'threadId', v_letter.thread_id,
      'senderId', v_letter.sender_id,
      'recipientId', v_letter.recipient_id,
      'replyToLetterId', v_letter.reply_to_letter_id,
      'title', v_letter.title,
      'body', v_letter.body,
      'status', v_letter.status,
      'revision', v_letter.revision,
      'createdAt', v_letter.created_at,
      'updatedAt', v_letter.updated_at,
      'sentAt', v_letter.sent_at
    )
  );
end;
$function$;

revoke execute on function public.edit_sent_letter_content(uuid, uuid, text, text, integer) from public, anon, authenticated;
grant execute on function public.edit_sent_letter_content(uuid, uuid, text, text, integer) to service_role;

commit;
