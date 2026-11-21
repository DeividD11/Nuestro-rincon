begin;

-- Paginación keyset para las carpetas. Se conserva list_user_letters para los
-- agregados compactos del dashboard; las vistas paginadas dejan de ejecutar
-- COUNT(*) exacto en cada página.
create or replace function public.list_user_letters_cursor(
  p_user_id uuid,
  p_folder text,
  p_search text default '',
  p_cursor_sort_at timestamptz default null,
  p_cursor_id uuid default null,
  p_limit integer default 40
)
returns jsonb
language plpgsql
set search_path to 'pg_catalog', 'public'
as $function$
declare
  v_search text := lower(btrim(coalesce(p_search, '')));
  v_items jsonb := '[]'::jsonb;
  v_has_more boolean := false;
  v_next_cursor jsonb := null;
begin
  if p_user_id is null or p_folder is null
     or p_folder not in ('inbox','sent','drafts','favorites','archive','trash')
     or p_limit is null or p_limit < 1 or p_limit > 100
     or ((p_cursor_sort_at is null) <> (p_cursor_id is null))
     or char_length(coalesce(p_search, '')) > 120 then
    raise exception 'LETTER_LIST_INPUT_INVALID' using errcode = '22023';
  end if;

  if not exists (
    select 1 from public.app_users u
    where u.id = p_user_id and u.status = 'active'
  ) then
    raise exception 'LETTER_LIST_ACTOR_INVALID' using errcode = '42501';
  end if;

  with eligible as (
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
  ), page_candidates as materialized (
    select e.*
    from eligible e
    where p_cursor_sort_at is null
       or (e.sort_at, e.id) < (p_cursor_sort_at, p_cursor_id)
    order by e.sort_at desc nulls last, e.id desc
    limit p_limit + 1
  ), page_rows as (
    select * from page_candidates
    order by sort_at desc nulls last, id desc
    limit p_limit
  ), last_row as (
    select sort_at, id from page_rows
    order by sort_at asc nulls first, id asc
    limit 1
  )
  select
    (select count(*) > p_limit from page_candidates),
    (select jsonb_build_object('sortAt', sort_at, 'id', id) from last_row),
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
  into v_has_more, v_next_cursor, v_items;

  return jsonb_build_object(
    'items', v_items,
    'limit', p_limit,
    'hasMore', v_has_more,
    'nextCursor', case when v_has_more then v_next_cursor else null end,
    'loaded', jsonb_array_length(v_items)
  );
end;
$function$;

revoke execute on function public.list_user_letters_cursor(uuid, text, text, timestamptz, uuid, integer) from public, anon, authenticated;
grant execute on function public.list_user_letters_cursor(uuid, text, text, timestamptz, uuid, integer) to service_role;

commit;
