-- Actualiza el nombre público de la cuenta y el perfil en una sola transacción.
-- La Edge Function valida la sesión y suministra el ID autenticado; el cliente
-- nunca puede escoger el identificador de usuario para esta operación.
create or replace function public.rename_app_profile(
  p_user_id uuid,
  p_display_name text,
  p_now timestamptz default now()
)
returns jsonb
language plpgsql
set search_path to 'pg_catalog', 'public'
as $function$
declare
  v_user public.app_users%rowtype;
  v_display_name text := btrim(coalesce(p_display_name, ''));
begin
  if p_user_id is null
     or p_now is null
     or v_display_name = ''
     or char_length(v_display_name) > 80 then
    return jsonb_build_object('status', 'invalid_input');
  end if;

  select * into v_user
  from public.app_users
  where id = p_user_id and status = 'active'
  for update;

  if not found then
    return jsonb_build_object('status', 'not_found');
  end if;

  update public.app_users
  set display_name = v_display_name,
      updated_at = p_now
  where id = p_user_id
  returning * into v_user;

  insert into public.user_profiles(user_id, display_name, created_at, updated_at)
  values (p_user_id, v_display_name, p_now, p_now)
  on conflict (user_id) do update
    set display_name = excluded.display_name,
        updated_at = excluded.updated_at;

  return jsonb_build_object(
    'status', 'updated',
    'user', jsonb_build_object(
      'id', v_user.id,
      'username', v_user.username,
      'email', v_user.email,
      'displayName', v_user.display_name
    )
  );
end;
$function$;

revoke execute on function public.rename_app_profile(uuid, text, timestamptz) from public, anon, authenticated;
grant execute on function public.rename_app_profile(uuid, text, timestamptz) to service_role;
