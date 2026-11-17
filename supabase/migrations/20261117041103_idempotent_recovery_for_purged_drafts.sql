-- Reutiliza una clave de creación incluso cuando su borrador previo fue purgado.
-- La clave derivada es determinista: los reintentos no crean duplicados.
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
  v_effective_request_id uuid := p_creation_request_id;
  v_digest text;
begin
  if p_sender_id is null or p_creation_request_id is null
     or p_title is null or p_body is null
     or char_length(p_title) > 180 or char_length(p_body) > 100000 then
    raise exception 'DRAFT_INPUT_INVALID' using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(p_sender_id::text || ':' || p_creation_request_id::text, 0));

  loop
    select * into v_letter
    from public.letters
    where sender_id = p_sender_id and creation_request_id = v_effective_request_id
    limit 1;

    if not found then exit; end if;

    if v_letter.status <> 'purged' then
      return jsonb_build_object('status','created','draft',jsonb_build_object(
        'id',v_letter.id,'threadId',v_letter.thread_id,'senderId',v_letter.sender_id,
        'recipientId',v_letter.recipient_id,'title',v_letter.title,'body',v_letter.body,
        'status',v_letter.status,'revision',v_letter.revision,'createdAt',v_letter.created_at,
        'updatedAt',v_letter.updated_at,'sentAt',v_letter.sent_at
      ));
    end if;

    v_digest := md5('nuestro-rincon-purged-draft:' || p_sender_id::text || ':' ||
                    v_effective_request_id::text || ':' || v_letter.id::text);
    v_effective_request_id := (
      substr(v_digest,1,8) || '-' || substr(v_digest,9,4) || '-' ||
      substr(v_digest,13,4) || '-' || substr(v_digest,17,4) || '-' || substr(v_digest,21,12)
    )::uuid;
  end loop;

  if not exists (select 1 from public.app_users u where u.id = p_sender_id and u.status = 'active') then
    raise exception 'DRAFT_ACTOR_INVALID' using errcode = '42501';
  end if;

  insert into public.letter_threads(participant_a_id, participant_b_id, created_by_user_id)
  values (p_sender_id, null, p_sender_id)
  returning id into v_thread_id;

  insert into public.letters(thread_id, sender_id, recipient_id, creation_request_id, title, body)
  values (v_thread_id, p_sender_id, null, v_effective_request_id, p_title, p_body)
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

revoke execute on function public.create_letter_draft(uuid, uuid, text, text) from public, anon, authenticated;
grant execute on function public.create_letter_draft(uuid, uuid, text, text) to service_role;
