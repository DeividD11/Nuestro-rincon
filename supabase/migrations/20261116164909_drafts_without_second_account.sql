-- Permite crear y conservar borradores privados antes de que exista la segunda cuenta.
-- El destinatario se asigna de forma atómica al enviar la carta.
begin;

alter table public.letter_threads
  alter column participant_b_id drop not null;

alter table public.letters
  alter column recipient_id drop not null;

alter table public.letter_threads
  drop constraint if exists letter_threads_canonical_pair_chk,
  drop constraint if exists letter_threads_creator_is_participant_chk,
  drop constraint if exists letter_threads_distinct_participants_chk;

alter table public.letter_threads
  add constraint letter_threads_canonical_pair_chk
    check (participant_b_id is null or participant_a_id < participant_b_id),
  add constraint letter_threads_creator_is_participant_chk
    check (created_by_user_id = participant_a_id or created_by_user_id = participant_b_id),
  add constraint letter_threads_distinct_participants_chk
    check (participant_b_id is null or participant_a_id <> participant_b_id);

create or replace function public.create_letter_draft(
  p_sender_id uuid,
  p_creation_request_id uuid,
  p_title text,
  p_body text
)
returns jsonb
language plpgsql
set search_path to 'pg_catalog', 'public'
as $function$
declare
  v_thread_id uuid;
  v_letter public.letters%rowtype;
begin
  if p_sender_id is null or p_creation_request_id is null
     or p_title is null or p_body is null
     or char_length(p_title) > 180 or char_length(p_body) > 100000 then
    raise exception 'DRAFT_INPUT_INVALID' using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(p_sender_id::text || ':' || p_creation_request_id::text, 0));

  select * into v_letter
  from public.letters
  where sender_id = p_sender_id and creation_request_id = p_creation_request_id
  limit 1;

  if found then
    return jsonb_build_object('status','created','draft',jsonb_build_object(
      'id',v_letter.id,'threadId',v_letter.thread_id,'senderId',v_letter.sender_id,
      'recipientId',v_letter.recipient_id,'title',v_letter.title,'body',v_letter.body,
      'status',v_letter.status,'revision',v_letter.revision,'createdAt',v_letter.created_at,
      'updatedAt',v_letter.updated_at,'sentAt',v_letter.sent_at
    ));
  end if;

  if not exists (select 1 from public.app_users u where u.id = p_sender_id and u.status = 'active') then
    raise exception 'DRAFT_ACTOR_INVALID' using errcode = '42501';
  end if;

  insert into public.letter_threads(participant_a_id, participant_b_id, created_by_user_id)
  values (p_sender_id, null, p_sender_id)
  returning id into v_thread_id;

  insert into public.letters(thread_id, sender_id, recipient_id, creation_request_id, title, body)
  values (v_thread_id, p_sender_id, null, p_creation_request_id, p_title, p_body)
  returning * into v_letter;

  insert into public.letter_user_state(letter_id, user_id)
  values (v_letter.id, p_sender_id)
  on conflict (letter_id, user_id) do nothing;

  return jsonb_build_object('status','created','draft',jsonb_build_object(
    'id',v_letter.id,'threadId',v_letter.thread_id,'senderId',v_letter.sender_id,
    'recipientId',v_letter.recipient_id,'title',v_letter.title,'body',v_letter.body,
    'status',v_letter.status,'revision',v_letter.revision,'createdAt',v_letter.created_at,
    'updatedAt',v_letter.updated_at,'sentAt',v_letter.sent_at
  ));
end;
$function$;

create or replace function public.send_letter_draft(
  p_sender_id uuid,
  p_letter_id uuid,
  p_expected_revision integer
)
returns jsonb
language plpgsql
set search_path to 'pg_catalog', 'public'
as $function$
declare
  v_letter public.letters%rowtype;
  v_now timestamptz := clock_timestamp();
  v_recipient_id uuid;
  v_recipient_active boolean;
begin
  if p_sender_id is null or p_letter_id is null or p_expected_revision is null or p_expected_revision < 1 then
    return jsonb_build_object('status', 'invalid_input');
  end if;

  select * into v_letter
  from public.letters
  where id = p_letter_id
  for update;

  if not found or v_letter.sender_id is distinct from p_sender_id then
    return jsonb_build_object('status', 'not_found');
  end if;

  if v_letter.status = 'sent' then
    return jsonb_build_object('status', 'already_sent', 'letter', to_jsonb(v_letter));
  end if;

  if v_letter.status <> 'draft' then
    return jsonb_build_object('status', 'not_found');
  end if;

  if v_letter.revision <> p_expected_revision then
    return jsonb_build_object('status', 'conflict', 'revision', v_letter.revision);
  end if;

  if length(btrim(coalesce(v_letter.body, ''))) = 0 then
    return jsonb_build_object('status', 'body_required');
  end if;

  if v_letter.recipient_id is null then
    select id into v_recipient_id
    from public.app_users
    where status = 'active' and id <> p_sender_id
    order by id
    limit 1;

    if v_recipient_id is null then
      return jsonb_build_object('status', 'recipient_unavailable');
    end if;

    update public.letter_threads
    set participant_a_id = least(p_sender_id, v_recipient_id),
        participant_b_id = greatest(p_sender_id, v_recipient_id),
        last_activity_at = v_now
    where id = v_letter.thread_id;

    update public.letters
    set recipient_id = v_recipient_id
    where id = v_letter.id
    returning * into v_letter;
  else
    select exists (
      select 1 from public.app_users
      where id = v_letter.recipient_id and status = 'active'
    ) into v_recipient_active;

    if not v_recipient_active then
      return jsonb_build_object('status', 'recipient_unavailable');
    end if;
  end if;

  update public.letters
  set status = 'sent',
      sent_at = v_now,
      updated_at = v_now,
      revision = revision + 1
  where id = v_letter.id
  returning * into v_letter;

  insert into public.letter_user_state(letter_id, user_id)
  values (v_letter.id, v_letter.sender_id), (v_letter.id, v_letter.recipient_id)
  on conflict (letter_id, user_id) do nothing;

  insert into public.notifications(user_id, letter_id, actor_user_id, notification_type, metadata)
  values (
    v_letter.recipient_id,
    v_letter.id,
    v_letter.sender_id,
    case when v_letter.reply_to_letter_id is null then 'letter_received' else 'letter_reply_received' end,
    jsonb_build_object('threadId', v_letter.thread_id)
  )
  on conflict (user_id, letter_id, notification_type) do nothing;

  update public.letter_threads
  set last_activity_at = v_now
  where id = v_letter.thread_id;

  return jsonb_build_object('status', 'sent', 'letter', to_jsonb(v_letter));
end;
$function$;

revoke execute on function public.create_letter_draft(uuid, uuid, text, text) from public, anon, authenticated;
revoke execute on function public.send_letter_draft(uuid, uuid, integer) from public, anon, authenticated;
grant execute on function public.create_letter_draft(uuid, uuid, text, text) to service_role;
grant execute on function public.send_letter_draft(uuid, uuid, integer) to service_role;

commit;
