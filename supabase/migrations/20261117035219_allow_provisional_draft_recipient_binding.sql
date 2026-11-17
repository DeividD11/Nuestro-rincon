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

  if new.reply_to_letter_id is not null then
    select status, created_at into v_parent_status, v_parent_created_at
    from public.letters
    where id = new.reply_to_letter_id and thread_id = new.thread_id;
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
      and ((new.sender_id = v_a and new.recipient_id = v_b)
        or (new.sender_id = v_b and new.recipient_id = v_a));

    if new.sender_id is distinct from old.sender_id
       or (new.recipient_id is distinct from old.recipient_id and not v_recipient_binding_allowed)
       or new.thread_id is distinct from old.thread_id
       or new.reply_to_letter_id is distinct from old.reply_to_letter_id
       or new.created_at is distinct from old.created_at then
      raise exception 'LETTER_IDENTITY_IMMUTABLE' using errcode = '23000';
    end if;

    if old.status = 'sent' then
      if new.status <> 'purged' or new.content_purged_at is null
         or new.title is not null or new.body is not null
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
