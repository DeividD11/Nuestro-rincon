-- Propuesta histórica no reconciliada: columna y constraint de avatar.
-- Los objetos de perfil ya existen en producción; no ejecutar sin un diff completo.
-- El bucket privado se registra por separado en 20261124052017_ensure_private_media_bucket.

begin;

alter table public.user_profiles
  add column if not exists avatar_path text;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'user_profiles_avatar_path_owner_ck'
      and conrelid = 'public.user_profiles'::regclass
  ) then
    alter table public.user_profiles
      add constraint user_profiles_avatar_path_owner_ck
      check (
        avatar_path is null
        or (
          avatar_path like user_id::text || '/avatars/%'
          and avatar_path ~ '^[0-9a-f-]{36}/avatars/[0-9a-f-]{36}\.(jpg|jpeg|png|webp)$'
        )
      );
  end if;
end
$$;


comment on column public.user_profiles.avatar_path is
  'Ruta privada del avatar en Storage; no contiene URLs firmadas ni credenciales.';

commit;
