-- Nuestro Rincón v35: registra de forma reproducible la configuración privada
-- de Storage. No modifica perfiles, cartas ni archivos existentes.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'private-media',
  'private-media',
  false,
  5242880,
  array['image/jpeg', 'image/png', 'image/webp']::text[]
)
on conflict (id) do update
set name = excluded.name,
    public = false,
    file_size_limit = excluded.file_size_limit,
    allowed_mime_types = excluded.allowed_mime_types;

