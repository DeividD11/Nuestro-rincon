# Runbook de reconciliación y publicación Supabase

## Estado observado el 21 de noviembre de 2026

La comprobación de solo lectura se realizó sobre el proyecto `tiqbmuubpbmxqvtkcdhq` (PostgreSQL 17.11, estado `ACTIVE_HEALTHY`). No se ejecutaron migraciones, reparaciones del ledger, escrituras SQL ni despliegues.

| Elemento | Estado remoto observado | Código local |
|---|---|---|
| `auth-api` | ACTIVE, v11 | El código local incorpora el limitador por cuenta/IP y el paquete de diez códigos de recuperación |
| `letters-api` | ACTIVE, v8 | El código local usa `list_user_letters_cursor` y `rename_app_profile` |
| Historial remoto | 23 timestamps | 25 archivos SQL locales (inventario v25) |
| RPC de paquete de recuperación | `register_app_user_with_invite_idempotent_bundle` y `rotate_app_recovery_codes_bundle` existen | Se invocan desde el código local |
| Paginación | `list_user_letters_cursor` existe | Se invoca desde el código local |
| Renombrado de perfil | `rename_app_profile` existe | Se invoca desde el código local |

El cotejo de timestamps encontró 15 versiones comunes, diez archivos locales no registrados y ocho versiones remotas sin archivo homónimo en el inventario v25. Los diez archivos locales incluyen tres migraciones históricas/legacy de timestamps `20261116000000`, `20261116001000` y `20261116002000`, además de siete propuestas (`20261119064344`, `20261119090000`, `20261120173200`, `20261120235900`, `20261121200000`, `20261121210000` y `20261121220000`).

La inspección del esquema también encontró los RPC principales de varias de esas siete propuestas, los recibos de paquetes de recuperación, las columnas e índices de paginación y el trigger de protección de participantes/purga. Esto **no demuestra por sí solo** que cada sentencia de cada migración coincida con el estado remoto ni que todos sus efectos secundarios estén presentes. No se debe ejecutar ni marcar ninguna migración como aplicada sin un diff completo y una copia recuperable.

### Acceso y RLS

Las 21 tablas observadas en `public` tienen RLS activado. En el inventario de privilegios, `anon` y `authenticated` no tienen `SELECT` ni `INSERT` directo; el backend personalizado utiliza `service_role` desde las Edge Functions. El advisor informa tablas con RLS sin políticas, pero en este modelo de acceso directo revocado el aviso es informativo: no se deben crear políticas genéricas para silenciarlo. Revisa de nuevo grants, funciones y RLS cada vez que cambie la arquitectura.

La organización está en plan Free y no tiene ramas Supabase creadas. El flujo no presupone la disponibilidad de Branching ni crea una rama de coste variable.

## 1. Generar un informe de reconciliación estrictamente de solo lectura

Requiere `psql` y Node.js. Usa una conexión PostgreSQL del proyecto correcto; no incluyas la contraseña en el repositorio, la línea de comandos compartida ni un archivo versionado.

PowerShell:

```powershell
$env:NR_RECONCILE_PROJECT_REF = 'tiqbmuubpbmxqvtkcdhq'
$env:NR_RECONCILE_DATABASE_URL = '<URL PostgreSQL del proyecto>'
npm run supabase:reconcile:readonly
```

Bash:

```bash
export NR_RECONCILE_PROJECT_REF='tiqbmuubpbmxqvtkcdhq'
read -rsp 'URL PostgreSQL: ' NR_RECONCILE_DATABASE_URL; export NR_RECONCILE_DATABASE_URL; echo
npm run supabase:reconcile:readonly
unset NR_RECONCILE_DATABASE_URL
```

El script valida que la URL coincida con el ref, ejecuta `BEGIN READ ONLY`, fija límites de tiempo y consulta solo metadatos: historial, firmas/huellas de RPC, propietarios y grants, RLS, índices y triggers. No llama al Supabase CLI, no escribe un artefacto remoto, no cambia el historial y no despliega funciones.

Para listar las versiones de Edge Functions con autenticación CLI, ejecuta además `supabase functions list --remote=tiqbmuubpbmxqvtkcdhq`; es un comando de lectura. La lista debe mostrar `auth-api` v11 y `letters-api` v8 hasta que se apruebe una publicación.

El timestamp del ledger y la presencia de un RPC no prueban identidad de DDL. Compara sus firmas, `definitionMd5`, propietario, privilegios, dependencias, columnas, restricciones, índices y triggers con los archivos locales y el baseline conocido.

## 2. Reconciliar las migraciones

1. Generar un respaldo cifrado verificable y restaurarlo en un proyecto desechable antes de tocar el esquema remoto.
2. Revisar cada una de las siete propuestas locales no registradas. Clasificar cada sentencia como: ya aplicada y equivalente, aplicada con diferencias, ausente o obsoleta.
3. Revisar por separado los ocho timestamps remotos sin archivo local. Recuperar los archivos fuente históricos desde un snapshot fiable o construir y revisar un baseline; no inventarlos a partir de nombres.
4. Para cualquier migración local no registrada, solo usar `supabase migration repair --status applied <timestamp>` si se demostró que **todo** su efecto SQL ya existe y coincide. `migration repair` solo edita el ledger; no ejecuta SQL.
5. Si faltan efectos, crear una migración nueva, aditiva e idempotente con nombre/timestamp nuevo, probarla en un clon aislado y documentar cualquier diferencia. No reescribir un archivo histórico ya aplicado.
6. Ejecutar `npm run test:db`, pruebas pgTAP, pruebas de integración con dos cuentas y smoke tests antes de liberar funciones.

Nunca usar `supabase db reset --remote` en producción. No ejecutar `db push` hasta resolver los ocho timestamps remotos sin archivo, los diez archivos locales sin registro (tres legacy y siete propuestas) y el diff real del esquema.

## 3. Publicar las Edge Functions como una sola versión compatible

El código remoto actual está por detrás del ZIP local: `auth-api` v11 usa el flujo anterior de un solo código y `letters-api` v8 todavía hace el renombrado con dos PATCH y no usa la RPC de cursor. La base de datos observada ya contiene las RPC que invoca el código local y sus permisos SQL están reservados a `service_role`, pero falta comprobar equivalencia completa de sus definiciones y ejecutar pruebas dinámicas.

Una vez completados los pasos anteriores:

1. Desplegar ambas funciones desde el mismo commit revisado, incluyendo `core.ts`, `auth-api/deno.json`, `letters-api/deno.json` y sus dependencias relativas. Las configuraciones Deno son específicas por función y están declaradas también en `supabase/config.toml`.
2. Comprobar que las dos funciones conservan `verify_jwt=false` solo porque validan su propia sesión opaca dentro del handler; no desactivar `requireSession` ni exponer el secreto de servidor.
3. Probar registro con diez códigos, reintento idempotente, rotación completa, invalidación del paquete anterior, login, refresh, renombrado transaccional, paginación con empate de timestamps y aislamiento entre dos cuentas.
4. Comprobar logs y códigos HTTP sin registrar contraseñas, tokens, códigos de recuperación ni contenido de cartas.

No se ha desplegado ninguna Edge Function ni aplicado DDL en esta revisión.

## 4. Backups y recuperación: puerta obligatoria antes de publicar

La organización figura en plan Free; no hay backups diarios administrados en ese plan. El workflow externo `backup-database.yml` no quedará operativo hasta configurar el Environment `database-backups`, el bucket privado, el destinatario `age` y las credenciales de carga. La ejecución programada tampoco se considera evidencia de recuperación.

Antes del despliegue:

1. Configurar secretos/variables conforme a `docs/BACKUP_RESTORE.md`.
2. Ejecutar un backup manual y verificar el objeto cifrado descargándolo, comparando SHA-256 y descifrando una copia de prueba.
3. Restaurar en un proyecto Supabase nuevo y aislado, nunca en `tiqbmuubpbmxqvtkcdhq`.
4. Comprobar esquema, seis recuentos, login de prueba, letras/respuestas y permisos de dos cuentas.
5. Registrar RPO/RTO observados, duración, checksum y resultado.

El manifiesto incluye ahora una instantánea de `supabase_migrations.schema_migrations` solo como metadato de referencia. La restauración no inserta ese ledger en el destino: una base restaurada desde un dump lógico no equivale a reconstruir de manera validada su historial de migraciones.

## 5. E2EE es una puerta de protocolo separada

`docs/E2EE_ARCHITECTURE.md` sigue siendo una propuesta: hoy las cartas y los borradores se almacenan/transmiten en texto legible y no existen claves ni ciphertext E2EE. No se ha añadido criptografía parcial ni se afirma que esté activada.

Antes de una implementación se necesita un protocolo versionado, revisión criptográfica independiente, biblioteca HPKE/Argon2id fijada, huellas verificadas entre las dos cuentas, respaldo/restauración de claves probado en dispositivos limpios, cifrado de borradores y pruebas contra XSS/alteración/replay. La migración de cartas históricas y la eliminación del plaintext necesitan confirmación de descifrado de ambos participantes. La recuperación normal de contraseña no puede recuperar claves E2EE.

**Prohibido activar una bandera E2EE o cambiar la interfaz para afirmar privacidad de extremo a extremo mientras el backend siga recibiendo texto legible.** Esta entrega prepara las puertas de reconciliación y respaldo; no implementa E2EE de producción.
