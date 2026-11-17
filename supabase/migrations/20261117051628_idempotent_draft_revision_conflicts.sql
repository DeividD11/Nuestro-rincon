-- Un reintento con contenido ya persistido debe ser idempotente aunque el
-- cliente conserve una revisión anterior (por ejemplo, tras perder respuesta).
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

  -- Primero comprobamos igualdad exacta. Si un guardado anterior sí llegó a
  -- PostgreSQL pero su respuesta se perdió, repetirlo no debe parecer conflicto.
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

  -- Mantener una instantánea de recuperación periódica, no una por cada debounce.
  if v_letter.updated_at <= clock_timestamp() - interval '10 minutes' then
    select coalesce(max(version_no), 0) + 1 into v_next_version
    from public.letter_versions where letter_id = v_letter.id;
    insert into public.letter_versions(letter_id, version_no, created_by_user_id, title_snapshot, body_snapshot)
    values (v_letter.id, v_next_version, p_sender_id, v_letter.title, v_letter.body);
  end if;

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
