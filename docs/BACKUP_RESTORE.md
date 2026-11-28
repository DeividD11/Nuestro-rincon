# Copias de seguridad y restauración

## Situación del proyecto

La organización Supabase asociada a Nuestro Rincón figura actualmente en el plan **Free**. En ese plan no se debe asumir que existe una copia administrada diaria del proyecto. El workflow `/.github/workflows/backup-database.yml` ahora genera un backup v2 que reúne el dump lógico de `public` y los bytes del bucket privado `private-media`, añade hashes por objeto, cifra el paquete con `age` y lo envía a un bucket S3-compatible privado. **No queda operativo hasta que el propietario configure todos los secretos y variables indicados abajo y ejecute una primera copia manual.** No se ha creado un bucket externo ni se ha transferido información de producción desde este paquete.

## Qué contiene y qué no contiene

Cada copia cifrada contiene:

- `roles.sql`: roles personalizados incluidos por Supabase CLI. Los respaldos administrados de Supabase no incluyen contraseñas de roles personalizados; si se restaura alguno, habrá que restablecerlas.
- `schema.sql`: objetos del esquema `public`, incluidas tablas, funciones, índices, restricciones y triggers que la herramienta exporte.
- `data.sql`: datos del esquema `public`, incluidas cuentas propias, sesiones, códigos de recuperación, invitaciones, cartas y estados.
- `manifest.json`: referencia del proyecto, fecha, versión del formato, alcance `public+private-media`, recuentos de control, historial de migraciones como metadato y recuento/tamaño de Storage. El historial no se restaura ni se marca como aplicado en el destino.
- `storage-manifest.json`: inventario del bucket privado `private-media`, con ruta, MIME, tamaño y SHA-256 individual de cada objeto.
- `storage/objects/`: bytes de los avatares e imágenes de cartas descargados por Storage API. Se aceptan únicamente las rutas canónicas del proyecto, JPEG/PNG/WebP y objetos de hasta 5 MiB; se limita cada ejecución a 100.000 objetos y 10 GiB.

La exportación de Supabase CLI excluye esquemas administrados por Supabase y extensiones. El script comprueba que el dump de `public`, seis recuentos de tablas y el historial de migraciones permanecen estables durante la exportación. Storage se enumera antes y después de descargar todos los objetos; si el conjunto de rutas cambia, el backup se cancela. Son controles de consistencia, **no una instantánea transaccional única de PostgreSQL y Storage**: conviene ejecutar una copia cuando no haya operaciones masivas de medios o correspondencia.

No se almacenan volcados de producción en el repositorio, en el ZIP del proyecto ni en los artefactos de GitHub Actions. El TAR, incluidos los bytes de Storage, se cifra con `age` antes de cargarlo al bucket. El hash SHA-256 del archivo cifrado y el hash por objeto detectan corrupción, pero no sustituyen la prueba de restauración en un proyecto aislado.

## Configuración de GitHub

Crea un Environment llamado `database-backups` en **Repository → Settings → Environments**. Añade allí estas variables y secretos. No las añadas al código ni a un archivo `.env` comprometido.

| Nombre | Tipo | Contenido |
|---|---|---|
| `NR_BACKUP_PROJECT_REF` | Variable | `tiqbmuubpbmxqvtkcdhq` |
| `NR_BACKUP_AGE_RECIPIENT` | Variable | Clave pública `age1...` generada fuera del repositorio |
| `NR_BACKUP_S3_BUCKET` | Variable | Nombre del bucket privado |
| `NR_BACKUP_S3_REGION` | Variable | Región del proveedor; para R2 suele ser `auto` |
| `NR_BACKUP_DATABASE_URL` | Secreto | URL PostgreSQL directa de Supabase con contraseña |
| `NR_BACKUP_STORAGE_SERVICE_KEY` | Secreto | Clave service_role/secret del proyecto para enumerar y descargar Storage; nunca usar la publishable key |
| `NR_BACKUP_S3_ENDPOINT` | Secreto | Endpoint HTTPS del almacenamiento compatible con S3 |
| `NR_BACKUP_S3_ACCESS_KEY_ID` | Secreto | Credencial de escritura restringida al bucket de respaldos |
| `NR_BACKUP_S3_SECRET_ACCESS_KEY` | Secreto | Secreto de esa credencial |

La URL PostgreSQL puede ser la conexión directa (`db.<PROJECT_REF>.supabase.co`) o la **Session Pooler** del mismo proyecto, siempre con usuario `postgres.<PROJECT_REF>`. El script comprueba el ref, el host/usuario y el protocolo, y no imprime la URL con contraseña. Copia la cadena exacta desde **Connect** en Supabase y comprueba que coincida con la región y el usuario del proyecto; no desactives la validación de proyecto ni reemplaces la URL por la de otro entorno.

### Clave age

Genera una identidad `age` en un dispositivo seguro:

```bash
age-keygen -o nuestro-rincon-backup-identity.txt
```

Guarda la identidad privada fuera del repositorio, preferiblemente en un gestor de contraseñas y una copia offline separada. Copia únicamente la clave pública `age1...` a la variable `NR_BACKUP_AGE_RECIPIENT`. **No guardes la identidad privada en GitHub, el repositorio, el ZIP, el bucket junto al archivo ni en el mismo lugar que la copia.** Sin ella, las copias cifradas son irrecuperables. La clave `NR_BACKUP_STORAGE_SERVICE_KEY` debe ser una credencial privilegiada del proyecto; guárdala solo como secreto del Environment `database-backups`, no la uses desde el navegador y rótala si llega a exponerse.

### Bucket externo

Crea un bucket privado en AWS S3, Cloudflare R2, Backblaze B2 u otro proveedor compatible. Configura:

- Acceso público desactivado.
- Versionado de objetos activado.
- Credencial de acceso limitada al prefijo `nuestro-rincon/` y sin permisos de borrado si el proveedor lo permite.
- Regla de ciclo de vida sugerida: conservar respaldos diarios durante 35 días y las copias mensuales durante 12 meses. Ajusta la regla a tu política y coste.
- MFA/segundo factor en la cuenta del proveedor.

No uses un bucket compartido públicamente. El cifrado `age` protege el contenido incluso si el objeto o el bucket quedan expuestos, pero los permisos y el versionado siguen siendo necesarios.

## Ejecución automática

El workflow está programado para ejecutarse diariamente a las 07:25 UTC (02:25 en Bogotá). También puedes iniciarlo desde **Actions → Backup encrypted Supabase database → Run workflow**.

GitHub ejecuta los workflows `schedule` desde la rama predeterminada. En repositorios públicos, GitHub puede desactivar los workflows programados después de 60 días sin actividad del repositorio. Revisa la página Actions periódicamente y conserva una alerta de fallos; no asumas que el cron se ejecuta si el workflow está desactivado.

El workflow captura recuentos de control de seis tablas de dominio, genera `roles.sql`, `schema.sql` y `data.sql`, exporta todos los objetos de `private-media` mediante Storage API, valida cada objeto y escribe `storage-manifest.json` con SHA-256 individual. Vuelve a exportar el esquema, los recuentos y el inventario de Storage para detectar cambios durante la operación; después crea un TAR v2 que contiene los SQL, ambos manifiestos y `storage/objects`, y cifra el archivo con la clave pública `age`. Sube únicamente el archivo cifrado y el checksum al bucket, descarga el objeto de nuevo y compara SHA-256; el primer día de cada mes deposita además una copia en `monthly/YYYY-MM/` para permitir una retención mensual distinta. `roles.sql` puede estar vacío si no hay roles personalizados exportables; el resto de los componentes debe existir. Los archivos temporales se eliminan al terminar el job. Si la credencial de Storage falta, la API no permite enumerar/descargar o encuentra un objeto fuera de la allowlist, el job falla completo en lugar de producir una copia incompleta.

El objetivo del esquema actual es un punto de recuperación máximo de aproximadamente 24 horas (RPO 24 h), siempre que el job diario se complete y GitHub Actions no haya desactivado el cron. La comprobación de descarga valida la transferencia cifrada; solo una restauración posterior en un proyecto aislado valida de verdad el contenido recuperable. El workflow **no equivale a PITR** ni garantiza recuperación a segundos. Si el proyecto cambia a un plan que incluye backups diarios, conserva también el respaldo independiente externo.

## Exportar un snapshot del esquema sin datos

El workflow existente `Export Supabase public schema (read only)` crea un artefacto de esquema `public` sin datos. Configura `NR_SCHEMA_SOURCE_PROJECT_REF` y `NR_SCHEMA_SOURCE_DATABASE_URL` como secretos de GitHub y ejecútalo manualmente cuando necesites una instantánea revisable. No se hace commit automático del snapshot ni se incluye contenido de cartas.

La copia diaria cifrada incluye su propio `schema.sql`, por lo que no depende de que ese artefacto de corta retención siga disponible.

## Restaurar una copia en un proyecto aislado

**Nunca pruebes una restauración sobre producción.** El script rechaza la referencia de Nuestro Rincón (`tiqbmuubpbmxqvtkcdhq`) y también exige una base PostgreSQL de destino vacía.

1. Crea un proyecto Supabase aislado y registra su Project Ref. Crear proyectos puede generar costes dependiendo de la organización y el plan.
2. Descarga desde el bucket un archivo `.tar.gz.age` y su archivo lateral `.tar.gz.age.sha256` con el mismo nombre base. Conserva ambos archivos.
3. Comprueba el checksum del archivo cifrado antes de descifrar:

```bash
sha256sum -c nuestro-rincon-<ref>-<fecha>.tar.gz.age.sha256
```

4. Configura en un entorno local seguro (usa un proyecto aislado y una clave privilegiada del proyecto destino para Storage):

```bash
export NR_RESTORE_PROJECT_REF='<PROJECT_REF_AISLADO>'
export NR_RESTORE_DATABASE_URL='postgresql://...'
export NR_RESTORE_ENCRYPTED_FILE='./nuestro-rincon-<ref>-<fecha>.tar.gz.age'
export NR_RESTORE_AGE_IDENTITY="$(cat ./nuestro-rincon-backup-identity.txt)"
export NR_RESTORE_STORAGE_SERVICE_KEY='<service_role/secret del proyecto aislado>'
export NR_RESTORE_CONFIRM='RESTORE_TO_ISOLATED_PROJECT'
export NR_RESTORE_ALLOW_CROSS_PROJECT='YES'
```

5. Instala `age`, `psql` y `node`, y ejecuta:

```bash
bash scripts/backup/restore-to-isolated.sh
```

El script comprueba primero el archivo `.sha256`, descifra temporalmente, valida las rutas y tipos del TAR, exige los componentes SQL y manifiestos esperados junto con exactamente los objetos declarados, valida cada SHA-256, la referencia de origen y el destino, rechaza producción y exige una base de destino vacía. Ejecuta los SQL en una transacción, revoca todas las sesiones y refresh tokens importados (el resto de los registros se conserva) y compara los recuentos de seis tablas clave con los que se capturaron al hacer el respaldo.

6. Ejecuta `npm run test:db` con `NR_TEST_CONFIRM_ISOLATED=YES`, `NR_DB_TEST_PROJECT_REF` y `NR_TEST_DATABASE_URL` apuntando únicamente al proyecto aislado. Además, realiza las pruebas de integración con dos cuentas de prueba y comprueba acceso, cartas, respuestas, borradores, favoritos, papelera, recuperación y eliminación compartida.
7. Documenta fecha, checksum, duración, errores y resultados. Una copia solo se considera restaurable cuando esta prueba se completa correctamente.

La restauración prepara `extensions` y habilita `pgcrypto`, requerido por `extensions.gen_random_bytes` en el flujo de invitaciones. Revisa otras extensiones que tu esquema futuro pueda requerir antes de restaurar. La restauración SQL no despliega Edge Functions ni recupera variables/secretos de Edge Functions, configuración de GitHub ni el historial interno de migraciones. Los bytes de Storage sí se recuperan después de PostgreSQL desde `storage/objects`, siempre que el destino privado permita la subida y posterior descarga de verificación. El manifiesto conserva los timestamps/nombres observados como referencia, pero no se insertan en `supabase_migrations.schema_migrations` durante la restauración. Las sesiones se revocan deliberadamente en el destino aislado y las personas deberán volver a iniciar sesión allí. Los datos y el esquema `public` son una instantánea; no reconstruyen el camino de migraciones histórico ni sustituyen un baseline versionado revisado. Los roles personalizados no incluyen contraseñas; habrá que restablecerlas si se usan. Mantén el código fuente y `supabase/config.toml` versionados por separado, y vuelve a configurar los secretos del nuevo proyecto.

## Reintentar únicamente la restauración de Storage

Si la restauración PostgreSQL ya terminó y falla únicamente la subida de objetos, no es necesario repetir el dump SQL. Usa `scripts/backup/restore-storage-only.sh`; el script verifica checksum, manifiestos, rutas del TAR y hashes de los archivos, y escribe únicamente en `private-media` del proyecto aislado. Exige `NR_RESTORE_PROJECT_REF` distinto de producción, `NR_RESTORE_STORAGE_CONFIRM=RESTORE_STORAGE_TO_ISOLATED_PROJECT` y `NR_RESTORE_ALLOW_CROSS_PROJECT=YES`. El comando también está disponible como `npm run restore:storage`. Es idempotente: si un objeto ya existe con el mismo SHA-256, lo omite; si la misma ruta contiene otros bytes, aborta sin sobrescribirlos.

La restauración de objetos no reconstruye registros SQL ni aplica funciones/migraciones. Para un backup v1 antiguo de solo base de datos, `restore-to-isolated.sh` lo rechaza por defecto; `NR_RESTORE_ALLOW_DB_ONLY_BACKUP=YES` permite aceptar expresamente esa recuperación incompleta, sin fotografías ni adjuntos.

## Política de respaldo y revisión

- Verificar el resultado del job después de cada ejecución y revisar fallos.
- Revisar el acceso del bucket y el almacenamiento de la identidad privada cada trimestre.
- Realizar una restauración de prueba al menos cada trimestre y antes de un cambio de esquema de alto riesgo.
- Conservar un registro de las versiones de Supabase CLI, el esquema restaurado y las pruebas pasadas.
- No adjuntar archivos de backup a issues, pull requests, mensajes ni repositorios públicos.
- Cuando se active E2EE, conservar las claves de recuperación criptográfica por separado: el backup SQL no podrá recuperar claves privadas que solo existan en los dispositivos.

## Referencias oficiales

- [Supabase Database Backups](https://supabase.com/docs/guides/platform/backups)
- [Supabase Backup and Restore using the CLI](https://supabase.com/docs/guides/platform/migrating-within-supabase/backup-restore)
- [Supabase CLI `db dump`](https://supabase.com/docs/reference/cli/supabase-db-dump)
- [GitHub Actions workflow syntax (`schedule`)](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax#onschedule)


## Versión de Supabase CLI y destino remoto

Los workflows fijan Supabase CLI `3.0.0` mediante `supabase/setup-cli` con la acción anclada al commit SHA verificado `689adcfb80d947100a1eab127289b97d1fb07b13` (etiqueta de la acción `v3.2.0`). En CLI v3, `--remote=<ref|branch|url>` acepta tanto una referencia como una URL PostgreSQL explícita. Los flags `--db-url`, `--linked` y `--project-ref` todavía funcionan en v3, pero están obsoletos y se retirarán en v4; por ello los scripts usan `--remote="$NR_BACKUP_DATABASE_URL"`. El comando `db dump` no escribe en la base remota. No uses un `db push`, `db reset` o `migration repair` como parte de un backup.

La metadata `migrationHistory` del manifiesto permite comparar el estado del ledger que se respaldó, pero no sustituye los archivos fuente ni debe aplicarse automáticamente en un proyecto restaurado. Para reconciliar el código y el historial ejecuta el procedimiento de [`docs/SYNC_RELEASE_RUNBOOK.md`](SYNC_RELEASE_RUNBOOK.md).

Referencia del cambio CLI v3: [Migrating to Supabase CLI v3](https://supabase.com/docs/guides/local-development/cli/migrating-to-v3).
