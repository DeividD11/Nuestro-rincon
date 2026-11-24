-- Revocación atómica de todas las sesiones excepto la sesión que hace la petición.
-- La autorización se realiza en letters-api mediante la sesión opaca de Nuestro Rincón.
-- La función queda disponible únicamente para service_role; no se expone a Data API.

begin;

create or replace function public.revoke_other_app_sessions(
  p_user_id uuid,
  p_current_session_id uuid,
  p_now timestamptz default now()
)
returns integer
language plpgsql
security invoker
set search_path = pg_catalog, public
as $function$
declare
  v_session_ids uuid[];
  v_revoked_count integer := 0;
begin
  if p_user_id is null or p_current_session_id is null or p_now is null then
    raise exception 'INVALID_INPUT';
  end if;

  -- Bloquea primero el conjunto completo para evitar carreras con una
  -- revocación individual o una renovación de sesión que se esté ejecutando.
  select coalesce(array_agg(locked.id), array[]::uuid[])
    into v_session_ids
  from (
    select s.id
    from public.user_sessions as s
    where s.user_id = p_user_id
      and s.id <> p_current_session_id
      and s.revoked_at is null
    order by s.id
    for update
  ) as locked;

  if cardinality(v_session_ids) = 0 then
    return 0;
  end if;

  update public.user_sessions as s
     set revoked_at = p_now,
         revocation_reason = 'user_revoked_all_other_sessions',
         access_token_hash = null,
         access_expires_at = p_now
   where s.user_id = p_user_id
     and s.id = any(v_session_ids)
     and s.id <> p_current_session_id
     and s.revoked_at is null;
  get diagnostics v_revoked_count = row_count;

  update public.user_session_refresh_tokens as t
     set revoked_at = p_now
   where t.session_id = any(v_session_ids)
     and t.revoked_at is null;

  delete from public.push_subscriptions as p
   where p.user_id = p_user_id
     and p.session_id = any(v_session_ids);

  return v_revoked_count;
end;
$function$;

revoke all on function public.revoke_other_app_sessions(uuid, uuid, timestamptz)
  from public, anon, authenticated;
grant execute on function public.revoke_other_app_sessions(uuid, uuid, timestamptz)
  to service_role;

create index if not exists push_subscriptions_session_id_idx
  on public.push_subscriptions (session_id);

commit;
