# Reconstrucción de Supabase desde cero

## Estado remoto observado el 21 de noviembre de 2026

La lectura del proyecto remoto `tiqbmuubpbmxqvtkcdhq` mostró **23 migraciones** aplicadas. El ZIP de entrada original contenía 18 archivos SQL; la distribución actual contiene 24. En ambos casos, solo 15 corresponden a la historia remota. Faltaban las ocho migraciones iniciales del historial:

```text
20261115071151_harden_rls_event_trigger_public_acl
20261115071601_custom_auth_core
20261115071646_create_letter_domain_tables
20261115071754_letter_drafts_persistence
20261115072054_secure_letter_send_receive_read_reply
20261115072214_personal_letter_organization
20261115072253_search_sync_notifications
20261115072415_final_security_index_cleanup
```

Además, el ZIP contenía tres archivos locales que no coinciden con una entrada canónica del historial remoto y no deben aplicarse como si fueran migraciones pendientes:

```text
20261116000000_lock_down_direct_data_api.sql
20261116001000_first_account_bootstrap.sql
20261116002000_self_service_accounts_and_email_recovery.sql
```

Las seis migraciones propuestas locales son `20261119064344_auth_attempt_rate_limits.sql`, `20261119090000_shared_letter_purge_and_reply_guard.sql`, `20261120173200_fix_orphaned_purge_and_list_pagination.sql`, `20261120235900_transactional_profile_rename.sql`, `20261121200000_recovery_code_bundles.sql` y `20261121210000_cursor_based_letter_pagination.sql`. Ninguna aparece en las 23 entradas del ledger remoto. La inspección de solo lectura sí encontró en producción los objetos declarados por las primeras cuatro; la quinta introduce la tabla `registration_recovery_bundle_receipts` y `register_app_user_with_invite_idempotent_bundle`, y la sexta introduce `list_user_letters_cursor`; estas dos últimas siguen pendientes.

**Consecuencia:** no ejecutes `supabase db push --remote` sobre producción con este directorio tal como está. Los nombres/timestamps antiguos no se deben inventar, renumerar ni marcar como aplicados sin verificar su contenido y su efecto.

## Diferencia entre historial y snapshot

Son dos cosas distintas:

- El historial de migraciones explica el camino y el orden de los cambios.
- Un snapshot del esquema describe el estado actual de tablas, funciones, triggers, índices, constraints, extensiones y permisos.

Un dump actual permite reconstruir el estado de esquema, pero no recuperar los ocho archivos históricos ni conocer exactamente cuándo/por qué se hizo cada cambio. La entrada remota de historial sí identifica esos nombres, pero no expone su contenido SQL original en el inventario que se pudo leer.

## Exportar desde Supabase CLI v3

También se incorpora el workflow manual **Export Supabase public schema (read only)**. Configura en GitHub los secretos `NR_SCHEMA_SOURCE_PROJECT_REF` y `NR_SCHEMA_SOURCE_DATABASE_URL`; deben identificar el mismo proyecto. El workflow valida que la URL corresponda al ref declarado, mediante conexión directa `db.<ref>.supabase.co` o Session Pooler con usuario `postgres.<ref>`, y genera un artefacto con `public` sin datos. Puede usarse para extraer el estado actual de producción sin aplicar cambios; trata el SQL como código interno y guárdalo en el repositorio solo después de revisarlo. El workflow no exporta credenciales ni datos de las cartas.

También puedes hacerlo desde un entorno seguro y autenticado, preferentemente apuntando a una branch aislada después de comprobar el proyecto objetivo:

```bash
supabase login
supabase link --project-ref <PROJECT_REF_DE_PRUEBAS>
supabase migration list --remote
supabase db dump --db-url "$NR_SCHEMA_SOURCE_DATABASE_URL" --schema public --file supabase/schema/remote-public.sql
```

Alternativa para representación declarativa del esquema:

```bash
supabase db schema declarative generate --remote --schema public --output-dir supabase/schema/declarative
```

Para pasar explícitamente una URL de conexión a `supabase db dump`, se utiliza `--db-url`. `--remote` identifica un proyecto/branch remoto en comandos que aceptan una referencia de plataforma; no debe confundirse con una URL PostgreSQL. La URL debe estar codificada conforme a RFC 3986. Comprueba siempre `supabase db dump --help` con la versión instalada antes de automatizar el comando.

El dump de esquema no contiene datos. `supabase db dump` excluye esquemas administrados por Supabase y esquemas de extensiones; los roles personalizados se exportan por separado con `--role-only`, y los datos con `--data-only --use-copy`. El historial interno de migraciones y los objetos de Storage API no se incluyen en el snapshot `public`. Al restaurar en otro proyecto, revisa con especial cuidado los privilegios por defecto del proyecto destino: las tablas pueden heredar grants amplios del nuevo entorno. Comprueba y revoca expresamente los grants para `anon` y `authenticated` antes de exponer el Data API.

## Restauración controlada

1. Conserva un respaldo independiente del esquema y, solo si el propietario lo solicita, de los datos. El archivo `remote-public.sql` debe permanecer libre de datos personales.
2. Crea una branch/proyecto nuevo; no reutilices producción como laboratorio.
3. Revisa extensiones, propietarios, funciones, `search_path`, `SECURITY DEFINER/INVOKER`, ACL, grants por defecto, RLS, triggers y funciones que dependen de schemas administrados.
4. Prepara un baseline de esquema para una base vacía en una rama de trabajo. No incluyas en ese baseline la tabla interna de historial como si todas las migraciones históricas se hubieran reproducido.
5. Restaura primero el esquema en el destino vacío y comprueba los objetos con `supabase db diff --remote` / `supabase db schema declarative generate --remote`.
6. Ejecuta las pruebas pgTAP, de integración de dos cuentas y de navegador. Comprueba también la configuración de Edge Functions y CORS.
7. Solo entonces convierte el snapshot revisado en el baseline versionado del repositorio y continúa con migraciones incrementales nuevas.

No insertes manualmente filas ficticias en `supabase_migrations.schema_migrations` para hacer que el CLI crea que el historial se ejecutó. Si se necesita reconciliar historial, usa un procedimiento `migration repair` documentado y revisado sobre un proyecto de pruebas, no sobre producción durante esta auditoría.

## Lo que falta para afirmar que puede reconstruirse

La instantánea oficial `remote-public.sql` no está incluida en este ZIP porque requiere la URL PostgreSQL secreta. El workflow manual `Export Supabase public schema (read only)` puede producirla como artefacto de 14 días después de configurar `NR_SCHEMA_SOURCE_PROJECT_REF` y `NR_SCHEMA_SOURCE_DATABASE_URL`. El paquete prepara también un respaldo diario de `roles.sql`, `schema.sql` y `data.sql`, cifrado con `age` y enviado a un bucket S3-compatible; no queda activo hasta configurar el Environment `database-backups`, crear el bucket privado, generar la identidad `age` y añadir las variables/secretos. No se generó ni restauró una copia real durante esta entrega. Por tanto, **no se afirma que la base de datos actual ya pueda reconstruirse de forma reproducible desde cero**.


## Códigos de recuperación incluidos en los datos

El dump de `public` incluye `user_recovery_codes` y las tablas de recibos de idempotencia, incluida `registration_recovery_bundle_receipts` cuando se aplique la migración local de conjuntos. Los valores de código en claro no se guardan en PostgreSQL, por lo que una restauración no puede volver a mostrar códigos ya entregados. La copia cifrada externa de códigos (`recovery-vault`) es un archivo separado que la persona debe conservar junto con su frase secreta; no se encuentra dentro del respaldo SQL.
