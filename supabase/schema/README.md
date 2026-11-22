# Instantánea y reconstrucción del esquema remoto

El proyecto `tiqbmuubpbmxqvtkcdhq` ya existe y tiene historial, datos y funciones desplegadas. No trates sus migraciones como si fueran una base vacía.

## Exportar el esquema actual (sin datos)

Con Supabase CLI v3 y una URL PostgreSQL privada del proyecto, desde un entorno seguro:

```bash
supabase db dump --remote="$NR_SCHEMA_SOURCE_DATABASE_URL" --schema public --file supabase/schema/remote-public.sql
```

El dump estándar exporta el esquema, no los datos ni los roles personalizados, y excluye esquemas administrados por Supabase y extensiones. Revisa el resultado y las ACL/default privileges antes de restaurarlo en un proyecto nuevo. No uses un dump de esquema como copia de datos.

## Generar archivos declarativos (alternativa)

```bash
supabase db schema declarative generate --remote --schema public --output-dir supabase/schema/declarative
```

La generación declarativa permite obtener una representación actual del esquema, pero no reconstruye los pasos históricos que llevaron a ese estado. Revisa `docs/DB_REBUILD.md` antes de restaurar o sincronizar.

No ejecutes `supabase db push --remote`, `supabase db reset --remote` ni una restauración sobre producción como parte de una auditoría.
