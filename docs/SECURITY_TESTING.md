# Pruebas de seguridad de dos cuentas

Estas pruebas deben usar un proyecto Supabase aislado, sin datos personales. La prueba HTTP consume una invitación de alta, crea las cuentas A y B, crea/contesta cartas, rota/consume recuperación y elimina B para comprobar que las cartas compartidas permanecen en A. También prueba parsing HTTP, límites de tamaño, sesiones renovadas/revocadas, escrituras concurrentes de dos dispositivos, reintentos de envío y rate limits autenticados. No es una prueba de solo lectura.

## Matriz de comprobaciones

| Caso | Resultado esperado |
|---|---|
| B lista borradores de A | No aparece ninguno |
| B obtiene, edita, envía, archiva, elimina o marca favorito un borrador de A | Rechazo; no se modifica el borrador |
| A obtiene o edita borradores de B | Rechazo |
| A enumera o revoca una sesión de B | A no puede ver ni revocar la sesión de B; la prueba se repite en sentido inverso |
| B revoca una segunda sesión propia | La sesión revocada deja de funcionar |
| Repetir un alta confirmada con la misma clave idempotente | Devuelve el mismo identificador de cuenta, sin consumir una segunda invitación |
| Reutilizar una invitación con otra clave | Rechazo |
| Repetir un autosave después de perder la respuesta | Mismo borrador/contenido, sin duplicado ni conflicto falso |
| Dos dispositivos guardan con la misma revisión al mismo tiempo | Una escritura gana; la otra recibe conflicto y no sobreescribe |
| Renovar refresh token | Nuevo access/refresh token; el access token anterior deja de funcionar |
| Revocar la segunda sesión de la misma cuenta | La sesión deja de funcionar y se eliminan sus suscripciones Push |
| Repetir el envío tras perder la respuesta | El segundo intento devuelve `already_sent`, sin duplicar la carta ni el aviso |
| Rotar diez códigos y repetir la misma solicitud | La primera activa el conjunto; el reintento idempotente confirma el mismo conjunto |
| Solicitar `push:subscribe` con endpoint HTTP/no admitido | Rechazo HTTP 400; solo endpoints HTTPS de proveedores admitidos |
| Superar el límite de lecturas autenticadas | HTTP 429 con `Retry-After`/`retryAfterSeconds` |
| JSON inválido, media type incorrecto y stream sobredimensionado | HTTP 400, 415 y 413, respectivamente |
| A intenta marcar leída una carta dirigida a B | No cambia el estado de lectura de B |
| B responde una carta de A | Permitido; A puede consultar la conversación |
| B archiva la carta compartida en su buzón | Solo cambia el estado personal de B; A conserva su carta en Enviadas |
| B intenta recuperar A usando su propio código | Rechazo; el código no sirve para otra identidad |
| Reutilizar el código de recuperación consumido | Rechazo |
| Eliminar B | Se eliminan sus datos privados y borradores; las cartas compartidas y respuestas siguen visibles para A con el nombre anonimizado |
| Ráfaga de intentos desde el mismo origen | Se aplica enfriamiento progresivo y queda auditoría |
| Intentos distribuidos sobre una cuenta desde distintas IP | Se registra actividad sospechosa sin bloquear globalmente a la persona |

## 1. Preparar un proyecto/branch desechable

No uses el proyecto de producción `tiqbmuubpbmxqvtkcdhq`. Crea un proyecto Supabase separado y desechable (recomendado en este caso) o una branch si tu plan la admite. La organización revisada no tenía branches creadas y está en Free; no supongas que la función Branching está disponible. Comprueba que el `project_ref` de pruebas es distinto al de producción y no uses datos reales.

Aplica primero las migraciones necesarias en el entorno aislado y valida la divergencia de historial descrita en `DB_REBUILD.md`. Para probar las cuotas autenticadas y Web Push, debe estar aplicada `20261121220000_authenticated_api_rate_limits_and_web_push.sql`; para la recuperación por diez códigos también debe existir `20261121200000_recovery_code_bundles.sql`. Despliega allí `auth-api` y `letters-api` del mismo paquete probado. No despliegues funciones si sus RPC/tablas requeridas no están instaladas.

En una instalación vacía, genera la invitación inicial desde SQL Editor de la branch usando el procedimiento de `INVITATIONS.md`. La invitación debe quedar solo en variables de entorno locales/secretos de CI; no la subas al repositorio.

## 2. Prueba HTTP real de dos cuentas

Configura estas variables en una terminal privada:

```bash
NR_TEST_SUPABASE_URL=https://<BRANCH_REF>.supabase.co
NR_TEST_PROJECT_REF=<BRANCH_REF>
NR_TEST_PUBLISHABLE_KEY=<PUBLISHABLE_KEY_DE_LA_BRANCH>
NR_TEST_CONFIRM_ISOLATED=YES
NR_TEST_BOOTSTRAP_INVITATION=<INVITACION_INICIAL_DE_LA_BRANCH>
NR_TEST_ACCOUNT_A_USERNAME=<usuario_a_temporal>
NR_TEST_ACCOUNT_A_PASSWORD=<contraseña_temporal_larga>
NR_TEST_ACCOUNT_A_DISPLAY_NAME=Cuenta A de pruebas
NR_TEST_ACCOUNT_B_USERNAME=<usuario_b_temporal>
NR_TEST_ACCOUNT_B_PASSWORD=<contraseña_temporal_larga>
NR_TEST_ACCOUNT_B_DISPLAY_NAME=Cuenta B de pruebas
```

En PowerShell utiliza `$env:NOMBRE='valor'`; en Bash utiliza `export NOMBRE='valor'`. No guardes contraseñas ni invitaciones en `.env` que se vaya a subir al repositorio.

Ejecuta:

```bash
npm run test:integration
```

El test contiene una barrera doble: exige `NR_TEST_CONFIRM_ISOLATED=YES` y bloquea expresamente el ref de producción. Al terminar, B se elimina deliberadamente y A queda en la branch. Para repetir el escenario completo usa una branch/base de prueba nueva y una invitación bootstrap nueva.

## 3. Prueba pgTAP en la branch aislada

La reconstrucción local completa todavía está pendiente porque faltan ocho fuentes SQL históricas. Por eso, este conjunto de pruebas no debe ejecutarse contra un stack local reconstruido desde el historial incompleto.

Configura en una terminal privada:

```bash
NR_TEST_CONFIRM_ISOLATED=YES
NR_DB_TEST_PROJECT_REF=<BRANCH_REF>
NR_TEST_DATABASE_URL=<URL_POSTGRESQL_DE_LA_BRANCH>
```

En PowerShell usa `$env:NR_TEST_CONFIRM_ISOLATED='YES'`, `$env:NR_DB_TEST_PROJECT_REF='<BRANCH_REF>'` y `$env:NR_TEST_DATABASE_URL='<URL_POSTGRESQL_DE_LA_BRANCH>'`. Ejecuta:

```bash
npm run test:db
```

El wrapper usa `psql` directamente y comprueba que la URL corresponda al host `db.<PROJECT_REF>.supabase.co` o al Session Pooler del mismo proyecto (`postgres.<PROJECT_REF>`). Bloquea expresamente el ref de producción. Instala `postgresql-client` antes de ejecutar el comando. La extensión pgTAP se crea si falta y queda instalada en el proyecto aislado; las pruebas SQL abren transacciones y revierten sus fixtures. Esta suite valida ACL/RLS, permisos de RPC, índices e idempotencia; no sustituye la prueba HTTP de dos cuentas.

## 4. Pruebas Playwright escritorio y móvil

Prepara dos cuentas temporales existentes en el proyecto aislado y configura:

```bash
NR_E2E_PROJECT_REF=<BRANCH_REF>
NR_E2E_SUPABASE_URL=https://<BRANCH_REF>.supabase.co
NR_E2E_PUBLISHABLE_KEY=<PUBLISHABLE_KEY_DE_LA_BRANCH>
NR_E2E_ACCOUNT_A_USERNAME=<usuario_a_temporal>
NR_E2E_ACCOUNT_A_PASSWORD=<contraseña_temporal_larga>
NR_E2E_ACCOUNT_A_DISPLAY_NAME=Cuenta A de pruebas
NR_E2E_ACCOUNT_B_USERNAME=<usuario_b_temporal>
NR_E2E_ACCOUNT_B_PASSWORD=<contraseña_temporal_larga>
NR_E2E_ACCOUNT_B_DISPLAY_NAME=Cuenta B de pruebas
```

Después:

```bash
npm install
npx playwright install chromium
npm run test:e2e
```

El mismo spec se ejecuta con los proyectos Chromium de escritorio y Pixel 7. También existe el workflow manual `Security UI tests (isolated Supabase)`, que toma los valores de secretos `NR_E2E_*`. Nunca configures secretos de producción. El `project_ref` queda comprobado en el test y debe coincidir con el host de la URL.

## 5. Qué no se debe interpretar como validado

Las pruebas incluidas son código preparado para ser ejecutado; añadir un test no equivale a que haya pasado. En esta entrega no se ejecutaron contra una branch real, porque todavía no existe una branch aislada autorizada. Tampoco se modificaron datos, migraciones ni funciones en producción.


## 3. Pruebas unitarias de validación de solicitudes Edge

`npm run test:edge-unit` ejecuta `supabase/functions/_shared/core.test.ts` con Deno. Verifica JSON UTF-8 válido, media type, JSON mal formado, `Content-Length` inválido, un stream mayor de 150 KB sin `Content-Length`, raíces JSON que no son objetos y los códigos HTTP asignados. GitHub Actions ejecuta esta suite en el workflow de Pages antes de publicar el frontend.

## 4. Cuotas de API autenticada y notificaciones externas

La migración `20261121220000_authenticated_api_rate_limits_and_web_push.sql` añade límites por usuario y minuto para los grupos de listados, lecturas, escrituras y operaciones de seguridad. Los buckets no son accesibles desde `anon` ni `authenticated`; solo los consulta el backend con `service_role`. Las cuotas son inicialmente 45/120/30/8 solicitudes por minuto por grupo y deben ajustarse con métricas reales.

Web Push se controla desde Configuración. El backend solo acepta endpoints HTTPS de proveedores reconocidos, asocia cada suscripción a `user_id` y `session_id`, y elimina suscripciones al cerrar/revocar sesión, cambiar contraseña o eliminar cuenta. Los payloads no contienen título, remitente, cuerpo ni identificador de carta. La entrega es de mejor esfuerzo y se deduplica por pareja notificación/dispositivo.

Para activarlo en una branch: aplica la migración, genera un par VAPID, configura `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY` y `VAPID_SUBJECT` como secretos de la Edge Function, y despliega `letters-api`. La clave privada nunca debe ir al frontend ni al repositorio. La interfaz no solicita el permiso del navegador hasta que la persona pulse el botón de activación.


El envío push asociado a cartas y respuestas se programa en segundo plano con `EdgeRuntime.waitUntil`; no debe retrasar ni condicionar la respuesta de la operación de envío. La entrega push es best effort y la bandeja interna sigue siendo la fuente persistente.


### Secretos opcionales para GitHub Actions

Los workflows manuales son deliberados: nunca se ejecutan automáticamente contra un destino que podría contener datos. Para **Two-account security integration (isolated Supabase)** configura estos secretos de repositorio o de un Environment dedicado: `NR_TEST_SUPABASE_URL`, `NR_TEST_PROJECT_REF`, `NR_TEST_PUBLISHABLE_KEY`, `NR_TEST_BOOTSTRAP_INVITATION`, `NR_TEST_ACCOUNT_A_USERNAME`, `NR_TEST_ACCOUNT_A_PASSWORD`, `NR_TEST_ACCOUNT_A_DISPLAY_NAME`, `NR_TEST_ACCOUNT_B_USERNAME`, `NR_TEST_ACCOUNT_B_PASSWORD` y `NR_TEST_ACCOUNT_B_DISPLAY_NAME`. El workflow ahora falla antes de ejecutar si falta cualquiera; no puede finalizar verde con la prueba omitida por falta de credenciales.

Para **Security database tests (isolated Supabase)** configura `NR_DB_TEST_PROJECT_REF` y `NR_TEST_DATABASE_URL`. El flujo valida el host/usuario de la conexión, instala `psql` y ejecuta pgTAP. Para **Security UI tests (isolated Supabase)** configura los nueve secretos `NR_E2E_*` de la URL, clave pública y dos cuentas; también falla si falta alguna credencial.

Usa contraseñas y cuentas temporales, y conserva una copia del entorno de pruebas o vuelve a crearlo antes de repetir la integración: el escenario elimina deliberadamente la cuenta B. No compartas ni registres URLs PostgreSQL con contraseña, invitaciones, claves publicables privadas de prueba ni contraseñas.
