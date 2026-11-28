-- Cola transaccional para eliminar objetos privados de cartas sin dejar huérfanos.
-- Los triggers solo registran rutas; la eliminación binaria siempre usa Storage API.
begin;

create table if not exists public.private_media_cleanup_jobs (
  id uuid primary key default gen_random_uuid(),
  object_path text not null unique,
  status text not null default 'pending'
    check (status in ('pending', 'processing', 'completed')),
  attempts integer not null default 0 check (attempts >= 0),
  next_attempt_at timestamptz not null default clock_timestamp(),
  locked_at timestamptz,
  last_error_code text check (last_error_code is null or length(last_error_code) <= 80),
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  completed_at timestamptz,
  constraint private_media_cleanup_path_ck check (
    object_path ~ '^letters/[0-9a-f-]{36}/[0-9a-f-]{36}/[0-9a-f-]{36}\.(jpg|jpeg|png|webp)$'
  )
);

alter table public.private_media_cleanup_jobs enable row level security;
revoke all on table public.private_media_cleanup_jobs from public, anon, authenticated;
grant select, insert, update, delete on table public.private_media_cleanup_jobs to service_role;

create index if not exists private_media_cleanup_pending_idx
  on public.private_media_cleanup_jobs(next_attempt_at, created_at)
  where status = 'pending';
create index if not exists private_media_cleanup_stale_idx
  on public.private_media_cleanup_jobs(locked_at)
  where status = 'processing';

create or replace function public.enqueue_private_media_cleanup_from_html(p_html text)
returns integer
language plpgsql
set search_path to 'pg_catalog', 'public'
as $function$
declare
  v_path text;
  v_count integer := 0;
begin
  if p_html is null or p_html = '' then return 0; end if;

  for v_path in
    select captures[1]
    from regexp_matches(
      p_html,
      $pattern$data-image-path[[:space:]]*=[[:space:]]*["'](letters/[0-9a-f-]{36}/[0-9a-f-]{36}/[0-9a-f-]{36}\.(jpg|jpeg|png|webp))["']$pattern$,
      'gi'
    ) as regex_result(captures)
  loop
    insert into public.private_media_cleanup_jobs as existing(object_path)
    values (v_path)
    on conflict (object_path) do update
      set status = case
            when existing.status = 'completed' then 'pending'
            else existing.status
          end,
          next_attempt_at = least(existing.next_attempt_at, clock_timestamp()),
          locked_at = case
            when existing.status = 'completed' then null
            else existing.locked_at
          end,
          completed_at = case
            when existing.status = 'completed' then null
            else existing.completed_at
          end,
          updated_at = clock_timestamp();
    v_count := v_count + 1;
  end loop;
  return v_count;
end;
$function$;

create or replace function public.capture_letter_media_cleanup_from_letter()
returns trigger
language plpgsql
set search_path to 'pg_catalog', 'public'
as $function$
begin
  perform public.enqueue_private_media_cleanup_from_html(old.body);
  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$function$;

create or replace function public.capture_letter_media_cleanup_from_version()
returns trigger
language plpgsql
set search_path to 'pg_catalog', 'public'
as $function$
begin
  perform public.enqueue_private_media_cleanup_from_html(old.body_snapshot);
  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$function$;

revoke execute on function public.enqueue_private_media_cleanup_from_html(text) from public, anon, authenticated;
revoke execute on function public.capture_letter_media_cleanup_from_letter() from public, anon, authenticated;
revoke execute on function public.capture_letter_media_cleanup_from_version() from public, anon, authenticated;
grant execute on function public.enqueue_private_media_cleanup_from_html(text) to service_role;
grant execute on function public.capture_letter_media_cleanup_from_letter() to service_role;
grant execute on function public.capture_letter_media_cleanup_from_version() to service_role;

drop trigger if exists letters_capture_media_cleanup_update on public.letters;
create trigger letters_capture_media_cleanup_update
before update of body on public.letters
for each row when (old.body is distinct from new.body)
execute function public.capture_letter_media_cleanup_from_letter();

drop trigger if exists letters_capture_media_cleanup_delete on public.letters;
create trigger letters_capture_media_cleanup_delete
before delete on public.letters
for each row execute function public.capture_letter_media_cleanup_from_letter();

drop trigger if exists letter_versions_capture_media_cleanup_update on public.letter_versions;
create trigger letter_versions_capture_media_cleanup_update
before update of body_snapshot on public.letter_versions
for each row when (old.body_snapshot is distinct from new.body_snapshot)
execute function public.capture_letter_media_cleanup_from_version();

drop trigger if exists letter_versions_capture_media_cleanup_delete on public.letter_versions;
create trigger letter_versions_capture_media_cleanup_delete
before delete on public.letter_versions
for each row execute function public.capture_letter_media_cleanup_from_version();

-- Reclama solo rutas que ya no aparecen en el contenido actual ni en versiones.
-- SKIP LOCKED evita que dos invocaciones de Edge trabajen el mismo objeto.
create or replace function public.claim_private_media_cleanup_jobs(
  p_limit integer default 20,
  p_now timestamptz default clock_timestamp()
)
returns table(id uuid, object_path text, attempts integer)
language plpgsql
set search_path to 'pg_catalog', 'public'
as $function$
begin
  if p_limit is null or p_limit < 1 or p_limit > 100 then
    raise exception 'MEDIA_CLEANUP_LIMIT_INVALID';
  end if;

  return query
  with candidates as (
    select j.id
    from public.private_media_cleanup_jobs j
    where (
      (j.status = 'pending' and j.next_attempt_at <= p_now)
      or (j.status = 'processing' and j.locked_at < p_now - interval '10 minutes')
    )
    and not exists (
      select 1 from public.letters l
      where position(j.object_path in coalesce(l.body, '')) > 0
    )
    and not exists (
      select 1 from public.letter_versions v
      where position(j.object_path in coalesce(v.body_snapshot, '')) > 0
    )
    order by j.next_attempt_at, j.created_at
    for update skip locked
    limit p_limit
  )
  update public.private_media_cleanup_jobs j
     set status = 'processing',
         attempts = j.attempts + 1,
         locked_at = p_now,
         updated_at = p_now
    from candidates c
   where j.id = c.id
  returning j.id, j.object_path, j.attempts;
end;
$function$;

create or replace function public.finish_private_media_cleanup_job(
  p_job_id uuid,
  p_success boolean,
  p_error_code text default null,
  p_now timestamptz default clock_timestamp()
)
returns jsonb
language plpgsql
set search_path to 'pg_catalog', 'public'
as $function$
declare
  v_job public.private_media_cleanup_jobs%rowtype;
  v_error text;
begin
  if p_job_id is null or p_success is null then
    raise exception 'MEDIA_CLEANUP_INPUT_INVALID';
  end if;

  select * into v_job
  from public.private_media_cleanup_jobs
  where id = p_job_id
  for update;
  if not found then return jsonb_build_object('status', 'not_found'); end if;
  if v_job.status = 'completed' then return jsonb_build_object('status', 'completed'); end if;
  if v_job.status <> 'processing' then return jsonb_build_object('status', 'not_claimed'); end if;

  if p_success then
    update public.private_media_cleanup_jobs
       set status = 'completed', locked_at = null, last_error_code = null,
           completed_at = p_now, updated_at = p_now
     where id = p_job_id;
    return jsonb_build_object('status', 'completed');
  end if;

  v_error := upper(regexp_replace(coalesce(p_error_code, 'STORAGE_DELETE_FAILED'), '[^A-Z0-9_-]', '', 'g'));
  if v_error = '' then v_error := 'STORAGE_DELETE_FAILED'; end if;
  update public.private_media_cleanup_jobs
     set status = 'pending', locked_at = null,
         last_error_code = left(v_error, 80),
         next_attempt_at = p_now + make_interval(mins => least(1440, power(2, least(v_job.attempts, 10))::integer)),
         updated_at = p_now
   where id = p_job_id;
  return jsonb_build_object('status', 'retry_scheduled', 'attempts', v_job.attempts);
end;
$function$;

revoke execute on function public.claim_private_media_cleanup_jobs(integer, timestamptz) from public, anon, authenticated;
revoke execute on function public.finish_private_media_cleanup_job(uuid, boolean, text, timestamptz) from public, anon, authenticated;
grant execute on function public.claim_private_media_cleanup_jobs(integer, timestamptz) to service_role;
grant execute on function public.finish_private_media_cleanup_job(uuid, boolean, text, timestamptz) to service_role;

commit;
