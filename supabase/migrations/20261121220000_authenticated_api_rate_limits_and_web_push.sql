begin;

-- Límite server-side por usuario y grupo de operación. No usa memoria del
-- Edge Runtime (que no es compartida entre instancias) ni una identidad del
-- navegador enviada por el cliente.
create table if not exists public.app_api_rate_limit_buckets (
  user_id uuid not null references public.app_users(id) on delete cascade,
  action_group text not null check (action_group in ('letter_list', 'read', 'write', 'security')),
  bucket_start timestamptz not null,
  request_count integer not null default 0 check (request_count >= 0),
  updated_at timestamptz not null default now(),
  primary key (user_id, action_group, bucket_start)
);

alter table public.app_api_rate_limit_buckets enable row level security;
revoke all on table public.app_api_rate_limit_buckets from public, anon, authenticated;
grant select, insert, update, delete on table public.app_api_rate_limit_buckets to service_role;

create or replace function public.consume_app_api_rate_limit(
  p_user_id uuid,
  p_session_id uuid,
  p_action_group text,
  p_now timestamptz default now()
)
returns jsonb
language plpgsql
set search_path = pg_catalog, public
as $function$
declare
  v_limit integer;
  v_count integer;
  v_bucket timestamptz;
  v_retry integer;
begin
  if p_user_id is null or p_session_id is null or p_now is null
     or p_action_group not in ('letter_list', 'read', 'write', 'security') then
    return jsonb_build_object('allowed', false, 'reason', 'invalid');
  end if;

  case p_action_group
    when 'letter_list' then v_limit := 45;
    when 'read' then v_limit := 120;
    when 'write' then v_limit := 30;
    when 'security' then v_limit := 8;
    else return jsonb_build_object('allowed', false, 'reason', 'invalid');
  end case;

  perform 1
  from public.app_users u
  where u.id = p_user_id and u.status = 'active';
  if not found then
    return jsonb_build_object('allowed', false, 'reason', 'user_invalid');
  end if;

  perform 1
  from public.user_sessions s
  where s.id = p_session_id and s.user_id = p_user_id
    and s.revoked_at is null
    and s.idle_expires_at > p_now
    and s.absolute_expires_at > p_now
    and s.access_expires_at > p_now
  for update;
  if not found then
    return jsonb_build_object('allowed', false, 'reason', 'session_invalid');
  end if;

  perform pg_advisory_xact_lock(hashtextextended(
    'app-api-rate-limit:' || p_user_id::text || ':' || p_action_group, 0
  ));

  v_bucket := date_trunc('minute', p_now);
  insert into public.app_api_rate_limit_buckets(user_id, action_group, bucket_start, request_count, updated_at)
  values (p_user_id, p_action_group, v_bucket, 1, p_now)
  on conflict (user_id, action_group, bucket_start)
  do update set request_count = public.app_api_rate_limit_buckets.request_count + 1,
                updated_at = excluded.updated_at
  returning request_count into v_count;

  -- La limpieza queda acotada a la identidad que genera la solicitud.
  delete from public.app_api_rate_limit_buckets
  where user_id = p_user_id and bucket_start < p_now - interval '48 hours';

  v_retry := greatest(1, ceil(extract(epoch from (v_bucket + interval '1 minute' - p_now)))::integer);
  return jsonb_build_object(
    'allowed', v_count <= v_limit,
    'limit', v_limit,
    'remaining', greatest(0, v_limit - v_count),
    'retry_after_seconds', case when v_count > v_limit then v_retry else 0 end
  );
end;
$function$;
revoke all on function public.consume_app_api_rate_limit(uuid, uuid, text, timestamptz) from public, anon, authenticated;
grant execute on function public.consume_app_api_rate_limit(uuid, uuid, text, timestamptz) to service_role;

-- Suscripciones vinculadas a una sesión propia, no a Supabase Auth.
create table if not exists public.push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.app_users(id) on delete cascade,
  session_id uuid not null references public.user_sessions(id) on delete cascade,
  endpoint_hash text not null unique check (endpoint_hash ~ '^[0-9a-f]{64}$'),
  endpoint text not null check (length(endpoint) <= 2048),
  p256dh text not null check (length(p256dh) between 40 and 200),
  auth text not null check (length(auth) between 12 and 100),
  user_agent text check (user_agent is null or length(user_agent) <= 500),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now()
);
create index if not exists push_subscriptions_user_session_idx
  on public.push_subscriptions(user_id, session_id);

alter table public.push_subscriptions enable row level security;
revoke all on table public.push_subscriptions from public, anon, authenticated;
grant select, insert, update, delete on table public.push_subscriptions to service_role;

create or replace function public.upsert_app_push_subscription(
  p_user_id uuid,
  p_session_id uuid,
  p_endpoint_hash text,
  p_endpoint text,
  p_p256dh text,
  p_auth text,
  p_user_agent text,
  p_now timestamptz default now()
)
returns jsonb
language plpgsql
set search_path = pg_catalog, public
as $function$
begin
  if p_user_id is null or p_session_id is null or p_now is null
     or p_endpoint_hash is null or p_endpoint_hash !~ '^[0-9a-f]{64}$'
     or p_endpoint is null or length(p_endpoint) > 2048
     or p_p256dh is null or length(p_p256dh) not between 40 and 200
     or p_auth is null or length(p_auth) not between 12 and 100
     or (p_user_agent is not null and length(p_user_agent) > 500) then
    return jsonb_build_object('status', 'invalid_input');
  end if;

  perform 1 from public.app_users
  where id = p_user_id and status = 'active';
  if not found then return jsonb_build_object('status', 'user_invalid'); end if;

  perform 1 from public.user_sessions
  where id = p_session_id and user_id = p_user_id
    and revoked_at is null
    and idle_expires_at > p_now
    and absolute_expires_at > p_now
    and access_expires_at > p_now
  for update;
  if not found then return jsonb_build_object('status', 'session_invalid'); end if;

  insert into public.push_subscriptions(
    user_id, session_id, endpoint_hash, endpoint, p256dh, auth,
    user_agent, created_at, updated_at, last_seen_at
  ) values (
    p_user_id, p_session_id, p_endpoint_hash, p_endpoint, p_p256dh, p_auth,
    nullif(p_user_agent, ''), p_now, p_now, p_now
  )
  on conflict (endpoint_hash) do update set
    user_id = excluded.user_id,
    session_id = excluded.session_id,
    endpoint = excluded.endpoint,
    p256dh = excluded.p256dh,
    auth = excluded.auth,
    user_agent = excluded.user_agent,
    updated_at = excluded.updated_at,
    last_seen_at = excluded.last_seen_at;

  return jsonb_build_object('status', 'subscribed');
end;
$function$;
revoke all on function public.upsert_app_push_subscription(uuid, uuid, text, text, text, text, text, timestamptz) from public, anon, authenticated;
grant execute on function public.upsert_app_push_subscription(uuid, uuid, text, text, text, text, text, timestamptz) to service_role;

create table if not exists public.push_delivery_attempts (
  id uuid primary key default gen_random_uuid(),
  notification_id uuid not null references public.notifications(id) on delete cascade,
  subscription_id uuid not null references public.push_subscriptions(id) on delete cascade,
  status text not null default 'pending' check (status in ('pending', 'sent', 'failed', 'gone')),
  http_status integer check (http_status is null or http_status between 100 and 599),
  created_at timestamptz not null default now(),
  attempted_at timestamptz not null default now(),
  unique (notification_id, subscription_id)
);
create index if not exists push_delivery_attempts_subscription_idx
  on public.push_delivery_attempts(subscription_id, created_at desc);

alter table public.push_delivery_attempts enable row level security;
revoke all on table public.push_delivery_attempts from public, anon, authenticated;
grant select, insert, update, delete on table public.push_delivery_attempts to service_role;


-- Reclama una entrega con ventana de reintento. Los intentos completados no
-- se vuelven a enviar; fallos transitorios pueden reintentarse tras 5 minutos.
create or replace function public.claim_app_push_delivery(
  p_notification_id uuid,
  p_subscription_id uuid,
  p_now timestamptz default now()
)
returns jsonb
language plpgsql
set search_path = pg_catalog, public
as $function$
declare
  v_id uuid;
begin
  if p_notification_id is null or p_subscription_id is null or p_now is null then
    return jsonb_build_object('claimed', false, 'reason', 'invalid_input');
  end if;

  perform pg_advisory_xact_lock(hashtextextended(
    'push-delivery:' || p_notification_id::text || ':' || p_subscription_id::text, 0
  ));

  insert into public.push_delivery_attempts(
    notification_id, subscription_id, status, http_status, created_at, attempted_at
  )
  select p_notification_id, p_subscription_id, 'pending', null, p_now, p_now
  where exists (
    select 1
    from public.notifications n
    join public.push_subscriptions s on s.id = p_subscription_id
    where n.id = p_notification_id and n.user_id = s.user_id
  )
  on conflict (notification_id, subscription_id) do update
    set status = 'pending', http_status = null, attempted_at = excluded.attempted_at
    where public.push_delivery_attempts.status not in ('sent', 'gone')
      and public.push_delivery_attempts.attempted_at < p_now - interval '5 minutes'
  returning id into v_id;

  if v_id is null then
    return jsonb_build_object('claimed', false, 'reason', 'already_claimed_or_sent');
  end if;
  return jsonb_build_object('claimed', true, 'attempt_id', v_id);
end;
$function$;
revoke all on function public.claim_app_push_delivery(uuid, uuid, timestamptz) from public, anon, authenticated;
grant execute on function public.claim_app_push_delivery(uuid, uuid, timestamptz) to service_role;

commit;
