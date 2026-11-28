-- Retirar una carta/respuesta enviada a Borradores del autor y permitir que
-- el autor elimine definitivamente su propio contenido sin una segunda cuenta.
-- No elimina filas de correspondencia ni toca contenido ajeno: purga el cuerpo
-- de la creación del autor y conserva el registro para integridad referencial.
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
  v_sent_withdrawal_allowed boolean := false;
  v_validate_reply_parent boolean := false;
begin
  select participant_a_id, participant_b_id
    into v_a, v_b
  from public.letter_threads
  where id = new.thread_id;

  if not found then
    raise exception 'LETTER_THREAD_NOT_FOUND' using errcode = '23503';
  end if;

  -- Un borrador no tiene destinatario. Esto incluye los borradores nuevos y
  -- los mensajes enviados que su autor haya retirado explícitamente.
  if not (
    (new.sender_id = v_a and new.recipient_id = v_b)
    or (new.sender_id = v_b and new.recipient_id = v_a)
    or (new.status = 'draft' and new.recipient_id is null and new.sender_id in (v_a, v_b))
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
       or (new.recipient_id is distinct from old.recipient_id
           and not v_recipient_binding_allowed
           and not (
             old.status = 'sent'
             and new.status = 'draft'
             and new.recipient_id is null
             and new.sender_id = old.sender_id
             and current_setting('app.letter_withdrawer_user_id', true) = old.sender_id::text
           ))
       or new.thread_id is distinct from old.thread_id
       or new.reply_to_letter_id is distinct from old.reply_to_letter_id
       or new.created_at is distinct from old.created_at then
      raise exception 'LETTER_IDENTITY_IMMUTABLE' using errcode = '23000';
    end if;

    if old.status = 'sent' then
      v_sent_content_edit_allowed :=
        current_setting('app.letter_editor_user_id', true) = old.sender_id::text
        and new.status = 'sent'
        and new.recipient_id is not distinct from old.recipient_id
        and new.content_purged_at is not distinct from old.content_purged_at
        and new.title is not null
        and new.body is not null
        and new.sent_at is not distinct from old.sent_at
        and new.revision = old.revision + 1
        and new.updated_at > old.updated_at;

      v_sent_withdrawal_allowed :=
        current_setting('app.letter_withdrawer_user_id', true) = old.sender_id::text
        and new.status = 'draft'
        and new.recipient_id is null
        and new.content_purged_at is not distinct from old.content_purged_at
        and new.title is not distinct from old.title
        and new.body is not distinct from old.body
        and new.sent_at is null
        and new.revision = old.revision + 1
        and new.updated_at > old.updated_at;

      if not v_sent_content_edit_allowed and not v_sent_withdrawal_allowed then
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

create or replace function public.withdraw_sent_letter_to_draft(
  p_user_id uuid,
  p_letter_id uuid
)
returns jsonb
language plpgsql
set search_path to 'pg_catalog', 'public'
as $function$
declare
  v_letter public.letters%rowtype;
  v_now timestamptz := clock_timestamp();
begin
  if p_user_id is null or p_letter_id is null then
    return jsonb_build_object('status', 'invalid_input');
  end if;

  select * into v_letter
  from public.letters
  where id = p_letter_id
  for update;

  if not found or v_letter.sender_id is distinct from p_user_id
     or v_letter.content_purged_at is not null then
    return jsonb_build_object('status', 'not_found');
  end if;

  if v_letter.status = 'draft' and v_letter.recipient_id is null then
    return jsonb_build_object('status', 'already_draft', 'letterId', v_letter.id);
  end if;
  if v_letter.status <> 'sent' then
    return jsonb_build_object('status', 'invalid_state');
  end if;

  if not exists (
    select 1 from public.app_users
    where id = p_user_id and status = 'active'
  ) then
    return jsonb_build_object('status', 'not_found');
  end if;

  perform set_config('app.letter_withdrawer_user_id', p_user_id::text, true);

  update public.letters
     set status = 'draft',
         recipient_id = null,
         sent_at = null,
         revision = revision + 1,
         updated_at = v_now
   where id = p_letter_id
   returning * into v_letter;

  -- El autor vuelve a tener un borrador activo. El estado privado del otro
  -- participante queda conservado, pero no puede listar/ver un draft ajeno.
  update public.letter_user_state
     set archived_at = null,
         trashed_at = null,
         purge_confirmed_at = null,
         read_at = null,
         updated_at = v_now
   where letter_id = p_letter_id and user_id = p_user_id;

  delete from public.notifications where letter_id = p_letter_id;

  update public.letter_threads
     set last_activity_at = v_now
   where id = v_letter.thread_id;

  return jsonb_build_object(
    'status', 'withdrawn',
    'scope', 'owner_only',
    'letterId', v_letter.id,
    'revision', v_letter.revision
  );
end;
$function$;

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
  v_confirmed_count integer := 0;
  v_active_count integer := 0;
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
  if not found then return jsonb_build_object('status', 'not_found'); end if;

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

  -- El autor tiene control de su propia creación. No necesita autorización
  -- adicional para eliminar el contenido de su carta o respuesta enviada.
  if v_letter.status = 'draft' or (v_letter.status = 'sent' and p_user_id = v_letter.sender_id) then
    delete from public.letter_versions where letter_id = p_letter_id;
    delete from public.notifications where letter_id = p_letter_id;
    update public.letters
       set status = 'purged', title = null, body = null, content_purged_at = v_now
     where id = p_letter_id;
    return jsonb_build_object('status', 'purged', 'scope', 'owner_only');
  end if;

  -- Cuando elimina la copia recibida el destinatario conserva el flujo de
  -- confirmación compartida que evita borrar el contenido del remitente.
  select count(*)::integer into v_active_count
  from public.app_users u
  where u.id in (v_letter.sender_id, v_letter.recipient_id)
    and u.status = 'active';

  select count(*)::integer into v_confirmed_count
  from public.letter_user_state s
  join public.app_users u on u.id = s.user_id and u.status = 'active'
  where s.letter_id = p_letter_id
    and s.user_id in (v_letter.sender_id, v_letter.recipient_id)
    and s.trashed_at is not null
    and s.purge_confirmed_at is not null;

  if v_active_count > 0 and v_confirmed_count < v_active_count then
    return jsonb_build_object(
      'status', case when v_was_confirmed then 'already_confirmed_waiting' else 'pending_other_participant' end,
      'confirmedParticipants', v_confirmed_count,
      'requiredParticipants', v_active_count
    );
  end if;

  perform public.purge_shared_letters_without_active_confirmation(p_user_id);
  if exists (
    select 1 from public.letters
    where id = p_letter_id and (status = 'purged' or content_purged_at is not null)
  ) then
    return jsonb_build_object(
      'status', 'purged',
      'scope', case when v_active_count = 1 then 'remaining_active_participant' else 'both_participants' end,
      'confirmedParticipants', v_confirmed_count,
      'requiredParticipants', v_active_count
    );
  end if;

  return jsonb_build_object(
    'status', 'pending_other_participant',
    'confirmedParticipants', v_confirmed_count,
    'requiredParticipants', v_active_count
  );
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
  values (v_letter.id, v_letter.sender_id)
  on conflict (letter_id, user_id) do update
    set archived_at = null,
        trashed_at = null,
        read_at = null,
        purge_confirmed_at = null,
        updated_at = v_now;

  insert into public.letter_user_state(letter_id, user_id)
  values (v_letter.id, v_letter.recipient_id)
  on conflict (letter_id, user_id) do update
    set archived_at = null,
        trashed_at = null,
        read_at = null,
        purge_confirmed_at = null,
        updated_at = v_now;

  insert into public.notifications(user_id, letter_id, actor_user_id, notification_type, metadata, created_at, read_at)
  values (
    v_letter.recipient_id,
    v_letter.id,
    v_letter.sender_id,
    case when v_letter.reply_to_letter_id is null then 'letter_received' else 'letter_reply_received' end,
    jsonb_build_object('threadId', v_letter.thread_id),
    v_now,
    null
  )
  on conflict (user_id, letter_id, notification_type) do update
    set actor_user_id = excluded.actor_user_id,
        metadata = excluded.metadata,
        created_at = excluded.created_at,
        read_at = null;

  update public.letter_threads
     set last_activity_at = v_now
   where id = v_letter.thread_id;

  return jsonb_build_object('status', 'sent', 'letter', to_jsonb(v_letter));
end;
$function$;

revoke all on function public.withdraw_sent_letter_to_draft(uuid, uuid) from public, anon, authenticated;
grant execute on function public.withdraw_sent_letter_to_draft(uuid, uuid) to service_role;
revoke all on function public.confirm_letter_permanent_deletion(uuid, uuid) from public, anon, authenticated;
grant execute on function public.confirm_letter_permanent_deletion(uuid, uuid) to service_role;
revoke all on function public.send_letter_draft(uuid, uuid, integer) from public, anon, authenticated;
grant execute on function public.send_letter_draft(uuid, uuid, integer) to service_role;

commit;
