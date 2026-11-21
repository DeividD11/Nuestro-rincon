-- Permite purgar una respuesta aunque la carta original ya se haya purgado.
-- La relación de respuesta solo se valida al crearla o al cambiar su referencia;
-- una transición a status='purged' no debe depender del estado actual del padre.
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
      if new.status <> 'purged'
         or new.content_purged_at is null
         or new.title is not null
         or new.body is not null
         or new.sent_at is distinct from old.sent_at
         or new.revision <> old.revision then
        raise exception 'LETTER_SENT_IMMUTABLE' using errcode = '23000';
      end if;
    elsif old.status <> 'draft' then
      raise exception 'LETTER_STATE_TRANSITION_INVALID' using errcode = '23000';
    end if;
  end if;

  return new;
end;
$function$;

-- La confirmación de cada participante es idempotente. Repetirla no vuelve a
-- escribir marcas ni genera una nueva acción; la segunda persona completa el purge.
create or replace function public.confirm_letter_permanent_deletion(
  p_user_id uuid,
  p_letter_id uuid
)
returns jsonb
language plpgsql
set search_path to 'pg_catalog', 'public'
as $function$
declare
  v_letter public.letters%rowtype;
  v_state public.letter_user_state%rowtype;
  v_confirmed_count integer;
  v_was_confirmed boolean;
  v_now timestamptz := clock_timestamp();
begin
  if p_user_id is null or p_letter_id is null then
    return jsonb_build_object('status', 'invalid_input');
  end if;

  select * into v_letter
  from public.letters
  where id = p_letter_id
  for update;
  if not found then
    return jsonb_build_object('status', 'not_found');
  end if;

  if v_letter.status = 'purged' or v_letter.content_purged_at is not null then
    return jsonb_build_object('status', 'already_purged');
  end if;

  if v_letter.status = 'draft' and v_letter.sender_id <> p_user_id then
    return jsonb_build_object('status', 'not_found');
  end if;

  if v_letter.status = 'sent' and p_user_id not in (v_letter.sender_id, v_letter.recipient_id) then
    return jsonb_build_object('status', 'not_found');
  end if;

  select * into v_state
  from public.letter_user_state
  where letter_id = p_letter_id and user_id = p_user_id
  for update;

  if not found or v_state.trashed_at is null then
    return jsonb_build_object('status', 'not_in_trash');
  end if;

  v_was_confirmed := v_state.purge_confirmed_at is not null;

  update public.letter_user_state
  set purge_confirmed_at = coalesce(purge_confirmed_at, v_now),
      updated_at = case when purge_confirmed_at is null then v_now else updated_at end
  where letter_id = p_letter_id and user_id = p_user_id;

  if v_letter.status = 'draft' then
    delete from public.letter_versions where letter_id = p_letter_id;
    delete from public.notifications where letter_id = p_letter_id;
    update public.letters
    set status = 'purged', title = null, body = null, content_purged_at = v_now
    where id = p_letter_id;
    return jsonb_build_object('status', 'purged', 'scope', 'owner_only');
  end if;

  select count(*)::integer
    into v_confirmed_count
  from public.letter_user_state s
  where s.letter_id = p_letter_id
    and s.user_id in (v_letter.sender_id, v_letter.recipient_id)
    and s.trashed_at is not null
    and s.purge_confirmed_at is not null;

  if v_confirmed_count < 2 then
    return jsonb_build_object(
      'status', case when v_was_confirmed then 'already_confirmed_waiting' else 'pending_other_participant' end,
      'confirmedParticipants', v_confirmed_count,
      'requiredParticipants', 2
    );
  end if;

  delete from public.letter_versions where letter_id = p_letter_id;
  delete from public.notifications where letter_id = p_letter_id;
  update public.letters
  set status = 'purged', title = null, body = null, content_purged_at = v_now
  where id = p_letter_id;

  return jsonb_build_object('status', 'purged', 'scope', 'both_participants');
end;
$function$;

revoke execute on function public.confirm_letter_permanent_deletion(uuid, uuid) from public, anon, authenticated;
grant execute on function public.confirm_letter_permanent_deletion(uuid, uuid) to service_role;


-- Serializa el autoguardado con el descarte usando el mismo orden de bloqueo
-- que move_letter_to_trash (carta y luego estado del participante). Si el
-- descarte gana la carrera, una escritura tardía no puede hacer reaparecer
-- el borrador ni actualizar su contenido dentro de Papelera.
create or replace function public.save_letter_draft(
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
     or char_length(p_title) > 180 or char_length(p_body) > 100000 then
    raise exception 'DRAFT_INPUT_INVALID' using errcode = '22023';
  end if;

  select * into v_letter
  from public.letters
  where id = p_letter_id
  for update;

  if not found or v_letter.sender_id is distinct from p_sender_id or v_letter.status <> 'draft' then
    return jsonb_build_object('status','not_found');
  end if;

  select * into v_state
  from public.letter_user_state
  where letter_id = p_letter_id and user_id = p_sender_id
  for update;

  if not found then
    return jsonb_build_object('status','not_found');
  end if;
  if v_state.trashed_at is not null then
    return jsonb_build_object('status','discarded','letterId',p_letter_id);
  end if;

  if v_letter.title is not distinct from p_title and v_letter.body is not distinct from p_body then
    return jsonb_build_object('status','saved','draft',jsonb_build_object(
      'id',v_letter.id,'threadId',v_letter.thread_id,'senderId',v_letter.sender_id,
      'recipientId',v_letter.recipient_id,'title',v_letter.title,'body',v_letter.body,
      'status',v_letter.status,'revision',v_letter.revision,'createdAt',v_letter.created_at,
      'updatedAt',v_letter.updated_at,'sentAt',v_letter.sent_at
    ));
  end if;

  if v_letter.revision <> p_expected_revision then
    return jsonb_build_object('status','conflict','draft',jsonb_build_object(
      'id',v_letter.id,'threadId',v_letter.thread_id,'senderId',v_letter.sender_id,
      'recipientId',v_letter.recipient_id,'title',v_letter.title,'body',v_letter.body,
      'status',v_letter.status,'revision',v_letter.revision,'createdAt',v_letter.created_at,
      'updatedAt',v_letter.updated_at,'sentAt',v_letter.sent_at
    ));
  end if;

  if v_letter.updated_at <= clock_timestamp() - interval '10 minutes' then
    select coalesce(max(version_no), 0) + 1 into v_next_version
    from public.letter_versions where letter_id = v_letter.id;
    insert into public.letter_versions(letter_id, version_no, created_by_user_id, title_snapshot, body_snapshot)
    values (v_letter.id, v_next_version, p_sender_id, v_letter.title, v_letter.body);
  end if;

  update public.letters
  set title = p_title, body = p_body, revision = revision + 1, updated_at = clock_timestamp()
  where id = v_letter.id
  returning * into v_letter;

  update public.letter_threads set last_activity_at = v_letter.updated_at where id = v_letter.thread_id;

  return jsonb_build_object('status','saved','draft',jsonb_build_object(
    'id',v_letter.id,'threadId',v_letter.thread_id,'senderId',v_letter.sender_id,
    'recipientId',v_letter.recipient_id,'title',v_letter.title,'body',v_letter.body,
    'status',v_letter.status,'revision',v_letter.revision,'createdAt',v_letter.created_at,
    'updatedAt',v_letter.updated_at,'sentAt',v_letter.sent_at
  ));
end;
$function$;

revoke execute on function public.save_letter_draft(uuid, uuid, text, text, integer) from public, anon, authenticated;
grant execute on function public.save_letter_draft(uuid, uuid, text, text, integer) to service_role;

commit;
