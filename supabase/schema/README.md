# Instantánea del esquema remoto

Esta carpeta se reserva para un dump SQL del esquema existente. El proyecto `tiqbmuubpbmxqvtkcdhq` ya tiene un historial de migraciones y tablas de correspondencia/autenticación; no se debe tratar como una base Supabase vacía.

Para generar una instantánea desde un entorno con Supabase CLI autenticada:

```bash
supabase db dump --linked --schema public --file supabase/schema/remote-public.sql
```

Revisa el contenido antes de compartirlo. El dump puede contener detalles internos del proyecto. No lo ejecutes a ciegas contra producción ni lo uses como sustituto de una copia de seguridad.
