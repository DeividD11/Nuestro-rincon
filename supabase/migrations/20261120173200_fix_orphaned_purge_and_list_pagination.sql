-- El borrado compartido solo espera confirmaciones de cuentas activas.
-- Si un participante elimina su cuenta, su registro queda anonimizado y disabled;
-- no debe bloquear para siempre la eliminación solicitada por la otra persona.
-- Además, centraliza la consulta paginada/búsqueda de carpetas en PostgreSQL.
begin;

create or replace function public.purge_shared_letters_without_active_confirmation(
  p_scope_user_id uuid default null
)
returns integer
language plpgsql
set search_path to 'pg_catalog', 'public'
as $function$
declare
  v_letter_id uuid;
  v_purged integer := 0;
begin
  for v_letter_id in
    select l.id
    from public.letters l
    where l.status = 'sent'
      and l.content_purged_at is null
      and (p_scope_user_id is null or p_scope_user_id in (l.sender_id, l.recipient_id))
      -- Si no quedan cuentas activas, nadie puede recuperar la correspondencia.
      -- Si quedan una o dos, cada cuenta activa debe haber descartado y confirmado.
      and not exists (
        select 1
        from public.app_users active_user
        where active_user.id in (l.sender_id, l.recipient_id)
          and active_user.status = 'active'
          and not exists (
            select 1
            from public.letter_user_state s
            where s.letter_id = l.id
              and s.user_id = active_user.id
              and s.trashed_at is not null
              and s.purge_confirmed_at is not null
          )
      )
    order by l.id
    for update of l
  loop
    delete from public.letter_versions where letter_id = v_letter_id;
    delete from public.notifications where letter_id = v_letter_id;
    update public.letters
       set status = 'purged',
           title = null,
           body = null,
           content_purged_at = clock_timestamp()
     where id = v_letter_id
       and status = 'sent'
       and content_purged_at is null;
    if found then v_purged := v_purged + 1; end if;
  end loop;
  return v_purged;
end;
$function$;

revoke execute on function public.purge_shared_letters_without_active_confirmation(uuid) from public, anon, authenticated;
grant execute on function public.purge_shared_letters_without_active_confirmation(uuid) to service_role;

-- Cuando una cuenta se elimina, vuelve a evaluar únicamente sus cartas compartidas.
-- Se conservan para el participante activo hasta que este confirme; si ya confirmó,
-- se purgan en esta misma transacción. Si ambas cuentas están deshabilitadas,
-- los contenidos dejan de tener un propietario capaz de recuperarlos.
create or replace function public.purge_shared_letters_after_account_disabled()
returns trigger
language plpgsql
set search_path to 'pg_catalog', 'public'
as $function$
begin
  if old.status = 'active' and new.status = 'disabled' then
    perform public.purge_shared_letters_without_active_confirmation(new.id);
  end if;
  return new;
end;
$function$;

revoke execute on function public.purge_shared_letters_after_account_disabled() from public, anon, authenticated;
grant execute on function public.purge_shared_letters_after_account_disabled() to service_role;

drop trigger if exists app_user_purge_shared_letters_after_disable on public.app_users;
create trigger app_user_purge_shared_letters_after_disable
after update of status on public.app_users
for each row
when (old.status is distinct from new.status and new.status = 'disabled')
execute function public.purge_shared_letters_after_account_disabled();

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

  if v_letter.status = 'draft' then
    delete from public.letter_versions where letter_id = p_letter_id;
    delete from public.notifications where letter_id = p_letter_id;
    update public.letters
       set status = 'purged', title = null, body = null, content_purged_at = v_now
     where id = p_letter_id;
    return jsonb_build_object('status', 'purged', 'scope', 'owner_only');
  end if;

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

  -- Solo las cuentas que pueden seguir accediendo a la correspondencia cuentan.
  -- La segunda confirmación se exige si ambas cuentas continúan activas.
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

  -- Protección defensiva: si cambió el estado de las cuentas entre lecturas,
  -- informa pendiente y no afirma que se haya borrado el contenido.
  return jsonb_build_object(
    'status', 'pending_other_participant',
    'confirmedParticipants', v_confirmed_count,
    'requiredParticipants', v_active_count
  );
end;
$function$;

revoke execute on function public.confirm_letter_permanent_deletion(uuid, uuid) from public, anon, authenticated;
grant execute on function public.confirm_letter_permanent_deletion(uuid, uuid) to service_role;

-- Repara las cartas que ya habían quedado bloqueadas por una cuenta eliminada.
-- La rutina solo purga cuando todas las cuentas activas participantes ya confirmaron,
-- o cuando no queda ninguna cuenta activa capaz de recuperar el contenido.
select public.purge_shared_letters_without_active_confirmation(null);

-- Índices compuestos para los órdenes deterministas de listas, hilos y avisos.
create index if not exists letters_recipient_page_idx
  on public.letters(recipient_id, sent_at desc, id desc)
  where status = 'sent' and content_purged_at is null;
create index if not exists letters_sender_page_idx
  on public.letters(sender_id, sent_at desc, id desc)
  where status = 'sent' and content_purged_at is null;
create index if not exists letters_draft_page_idx
  on public.letters(sender_id, updated_at desc, id desc)
  where status = 'draft' and content_purged_at is null;
create index if not exists letters_thread_page_idx
  on public.letters(thread_id, sent_at desc, id desc)
  where status = 'sent' and content_purged_at is null;
create index if not exists letter_state_favorites_page_idx
  on public.letter_user_state(user_id, updated_at desc, letter_id desc)
  where is_favorite and trashed_at is null;
create index if not exists letter_state_archive_page_idx
  on public.letter_user_state(user_id, archived_at desc, letter_id desc)
  where archived_at is not null and trashed_at is null;
create index if not exists letter_state_trash_page_idx
  on public.letter_user_state(user_id, trashed_at desc, letter_id desc)
  where trashed_at is not null;
create index if not exists notifications_user_page_idx
  on public.notifications(user_id, created_at desc, id desc);

-- Consulta paginada y búsqueda en PostgreSQL: nunca limita a los primeros 100
-- resultados para luego buscar solo en memoria dentro de Edge Functions.
create or replace function public.list_user_letters(
  p_user_id uuid,
  p_folder text,
  p_search text default '',
  p_offset integer default 0,
  p_limit integer default 40
)
returns jsonb
language plpgsql
set search_path to 'pg_catalog', 'public'
as $function$
declare
  v_search text := lower(btrim(coalesce(p_search, '')));
  v_total bigint := 0;
  v_unread bigint := 0;
  v_items jsonb := '[]'::jsonb;
begin
  if p_user_id is null or p_folder is null
     or p_folder not in ('inbox','sent','drafts','favorites','archive','trash')
     or p_offset is null or p_offset < 0 or p_offset > 10000000
     or p_limit is null or p_limit < 1 or p_limit > 100
     or char_length(coalesce(p_search, '')) > 120 then
    raise exception 'LETTER_LIST_INPUT_INVALID' using errcode = '22023';
  end if;

  if not exists (select 1 from public.app_users u where u.id = p_user_id and u.status = 'active') then
    raise exception 'LETTER_LIST_ACTOR_INVALID' using errcode = '42501';
  end if;

  with eligible as materialized (
    select
      l.id, l.thread_id, l.sender_id, l.recipient_id, l.reply_to_letter_id,
      l.title, l.body, l.status, l.revision, l.created_at, l.updated_at,
      l.sent_at, l.content_purged_at, l.creation_request_id,
      us.user_id as state_user_id, us.is_favorite, us.archived_at,
      us.trashed_at, us.read_at, us.purge_confirmed_at,
      recipient_state.read_at as recipient_read_at,
      case
        when p_folder in ('inbox','sent') then l.sent_at
        when p_folder = 'trash' then us.trashed_at
        when p_folder = 'archive' then us.archived_at
        when p_folder = 'favorites' then us.updated_at
        else l.updated_at
      end as sort_at
    from public.letters l
    join public.letter_user_state us
      on us.letter_id = l.id and us.user_id = p_user_id
    left join public.letter_user_state recipient_state
      on recipient_state.letter_id = l.id and recipient_state.user_id = l.recipient_id
    where l.content_purged_at is null
      and (
        (p_folder = 'drafts' and l.status = 'draft' and l.sender_id = p_user_id and us.trashed_at is null)
        or (p_folder = 'inbox' and l.status = 'sent' and l.recipient_id = p_user_id and us.trashed_at is null and us.archived_at is null)
        or (p_folder = 'sent' and l.status = 'sent' and l.sender_id = p_user_id and us.trashed_at is null and us.archived_at is null)
        or (p_folder = 'favorites' and l.status = 'sent' and us.is_favorite is true and us.trashed_at is null)
        or (p_folder = 'archive' and l.status = 'sent' and us.archived_at is not null and us.trashed_at is null)
        or (p_folder = 'trash' and l.status in ('draft','sent') and us.trashed_at is not null)
      )
      and (
        v_search = ''
        or strpos(lower(coalesce(l.title, '')), v_search) > 0
        or strpos(
          lower(regexp_replace(
            replace(replace(replace(replace(replace(coalesce(l.body, ''), '&nbsp;', ' '), '&amp;', '&'), '&lt;', '<'), '&gt;', '>'), '&quot;', '"'),
            '<[^>]*>', ' ', 'g'
          )),
          v_search
        ) > 0
      )
  ), totals as (
    select count(*)::bigint as total,
           count(*) filter (where p_folder = 'inbox' and read_at is null)::bigint as unread
    from eligible
  ), page_rows as (
    select * from eligible
    order by sort_at desc nulls last, id desc
    offset p_offset limit p_limit
  )
  select totals.total,
         totals.unread,
         coalesce((
           select jsonb_agg(
             jsonb_build_object(
               'letter', jsonb_build_object(
                 'id', p.id, 'thread_id', p.thread_id, 'sender_id', p.sender_id,
                 'recipient_id', p.recipient_id, 'reply_to_letter_id', p.reply_to_letter_id,
                 'title', p.title, 'body', p.body, 'status', p.status,
                 'revision', p.revision, 'created_at', p.created_at,
                 'updated_at', p.updated_at, 'sent_at', p.sent_at,
                 'content_purged_at', p.content_purged_at,
                 'creation_request_id', p.creation_request_id
               ),
               'state', jsonb_build_object(
                 'user_id', p.state_user_id, 'is_favorite', p.is_favorite,
                 'archived_at', p.archived_at, 'trashed_at', p.trashed_at,
                 'read_at', p.read_at, 'purge_confirmed_at', p.purge_confirmed_at
               ),
               'recipient_read_at', p.recipient_read_at
             ) order by p.sort_at desc nulls last, p.id desc
           ) from page_rows p
         ), '[]'::jsonb)
    into v_total, v_unread, v_items
  from totals;

  return jsonb_build_object(
    'items', v_items,
    'total', v_total,
    'unread', v_unread,
    'offset', p_offset,
    'limit', p_limit,
    'hasMore', p_offset + jsonb_array_length(v_items) < v_total,
    'nextOffset', p_offset + jsonb_array_length(v_items)
  );
end;
$function$;

revoke execute on function public.list_user_letters(uuid, text, text, integer, integer) from public, anon, authenticated;
grant execute on function public.list_user_letters(uuid, text, text, integer, integer) to service_role;

commit;
