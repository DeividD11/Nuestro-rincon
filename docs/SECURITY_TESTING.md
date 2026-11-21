# Pruebas de seguridad de dos cuentas

Estas pruebas deben usar un proyecto Supabase aislado, sin datos personales. La prueba HTTP consume una invitación de alta, crea las cuentas A y B, crea/contesta cartas, rota/consume recuperación y elimina B para comprobar que las cartas compartidas permanecen en A. No es una prueba de solo lectura.

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
| A intenta marcar leída una carta dirigida a B | No cambia el estado de lectura de B |
| B responde una carta de A | Permitido; A puede consultar la conversación |
| B archiva la carta compartida en su buzón | Solo cambia el estado personal de B; A conserva su carta en Enviadas |
| B intenta recuperar A usando su propio código | Rechazo; el código no sirve para otra identidad |
| Reutilizar el código de recuperación consumido | Rechazo |
| Eliminar B | Se eliminan sus datos privados y borradores; las cartas compartidas y respuestas siguen visibles para A con el nombre anonimizado |
| Ráfaga de intentos desde el mismo origen | Se aplica enfriamiento progresivo y queda auditoría |
| Intentos distribuidos sobre una cuenta desde distintas IP | Se registra actividad sospechosa sin bloquear globalmente a la persona |

## 1. Preparar un proyecto/branch desechable

No uses el proyecto de producción `tiqbmuubpbmxqvtkcdhq`. Crea una branch de desarrollo vacía de datos o un proyecto separado. Una branch de Supabase puede generar cargos por hora; en la consulta de precios de esta revisión se indicó USD 0,01344/h. Confirma el precio actual antes de crearla y apágala/elíminala cuando termines. Comprueba que el `project_ref` de pruebas es distinto al de producción.

Aplica primero el esquema/migraciones disponibles y valida la divergencia de historial descrita en `DB_REBUILD.md`. Para probar exactamente el flujo nuevo de limitación, aplica `20261119064344_auth_attempt_rate_limits.sql` solo en el entorno aislado. Despliega allí `auth-api` del paquete y `letters-api` de la línea desplegada que se desea verificar. No despliegues la nueva `auth-api` si la migración no está aplicada.

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

El wrapper comprueba que el host sea exactamente `db.<BRANCH_REF>.supabase.co` y bloquea la referencia de producción. Supabase CLI v3 ejecuta pgTAP contra el destino `--remote` y pide confirmación de los cambios al usar una base hospedada; el wrapper añade `--yes` únicamente después de superar la barrera explícita y las comprobaciones de destino. La extensión pgTAP se habilita y se elimina durante el comando; hazlo solo en la branch desechable. La prueba abre una transacción y revierte sus datos. Esta suite valida ACL/RLS, umbrales, enfriamiento, auditoría y ausencia de bloqueo global por intentos distribuidos; no sustituye la prueba HTTP de dos cuentas.

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
