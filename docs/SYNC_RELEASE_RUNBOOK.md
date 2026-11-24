# Runbook de reconciliación y publicación Supabase


## Estado remoto v35 — comprobado el 24 de noviembre de 2026

| Elemento | Estado |
|---|---|
| Proyecto Supabase | `ACTIVE_HEALTHY`, PostgreSQL 17, región `us-west-2` |
| Edge Functions | `auth-api` v11 ACTIVE; `letters-api` v11 ACTIVE |
| Historial remoto | 25 migraciones |
| Inventario local | 28 archivos SQL locales: 17 timestamps comunes, tres legacy/no canónicos y ocho propuestas sin entrada homónima |
| Avatar | `public.user_profiles.avatar_path` y su constraint existen remotamente |
| Revocación global | `revoke_other_app_sessions` aplicado; ejecutable solo por `service_role`, SECURITY INVOKER |
| Rendimiento de revocación | Índice `push_subscriptions_session_id_idx` creado; operación encapsulada en una sola transacción SQL |
| Storage | `private-media` existe y quedó registrado con `20261124052017_ensure_private_media_bucket`; privado, 5 MiB, JPEG/PNG/WebP. Storage registró upload PUT 200 y HEAD 200; carta compartida en dos cuentas pendiente |

La migración `20261123205422_revoke_other_app_sessions_atomically.sql` está aplicada y registrada. La migración local `20261123193000_private_media_and_profile_avatars.sql` no se debe volver a ejecutar: sus objetos de perfil ya existían remotamente. La configuración del bucket se registra por separado en `20261124052017_ensure_private_media_bucket.sql`. Los ocho archivos propuestos se mantienen pendientes de diff/reconciliación; no ejecutes `supabase db push` para intentar resolver la deriva automáticamente. Las ocho entradas remotas sin archivo local homónimo también siguen requiriendo recuperación del SQL original.





### Ajustes locales de búsqueda y medios v38 (24 de noviembre de 2026)

El frontend actualiza exclusivamente `#letter-list-results` al escribir en los buscadores de las carpetas; no vuelve a montar el shell. Las búsquedas usan un identificador de petición para evitar resultados fuera de orden y el texto se mantiene solo durante la sección actual. No se agregan claves de búsqueda a la caché y el término se limpia al navegar. El lector de cartas mantiene `Cargando imagen…` cuando la URL firmada aún no está disponible, en vez de mostrar un error transitorio.

La función local `supabase/functions/letters-api/index.ts` conserva la generación de `firstImageUrl` para la primera imagen privada de cada carta. El frontend no puede firmar esas rutas. El último estado remoto registrado en este runbook es `letters-api` v11 ACTIVE; por lo tanto, la miniatura depende de desplegar la fuente local junto con el frontend. No se añade migración ni se modifica producción en esta entrega.

### Cambios locales de medios v36 (24 de noviembre de 2026)

Esta entrega no modifica el backend remoto ni el historial SQL. El proyecto remoto permanece con `letters-api` v11 ACTIVE. La fuente local de `letters-api` ahora devuelve `firstImageUrl` en las listas de cartas: firma exclusivamente la primera imagen del cuerpo y valida el ID base de la carta/hilo y el remitente antes de solicitar la URL privada. También limita a seis las firmas concurrentes por página. El cambio debe desplegarse antes de publicar el frontend v36; mientras solo se publique el frontend, las tarjetas conservarán su icono habitual porque el endpoint remoto todavía no devuelve `firstImageUrl`.

El avatar presenta un placeholder profesional durante la decodificación y las cargas se comprimen a un máximo de 512 px / 512 KiB para avatares y 1.600 px / 3 MiB para imágenes de carta. El procesador usa una cantidad acotada de exportaciones adaptativas. No hay nuevas migraciones, no hay cambios de políticas ni se modifica la configuración del bucket.

Pruebas de aceptación tras publicar ambas partes:

1. Actualiza el avatar y confirma que durante la carga se ve el placeholder, no el texto alternativo, y que se mantiene el fallback de iniciales si la imagen falla.
2. Adjunta dos imágenes a un borrador, guárdalo y comprueba que la primera insertada es la que aparece en el `letter-stamp` de Borradores.
3. Envía la carta y comprueba la miniatura desde la cuenta destinataria; revisa que la segunda imagen siga dentro del cuerpo al abrir la carta, pero no sustituya la miniatura.
4. Prueba las tarjetas del inicio, Buzón, Enviados, Borradores, Favoritos y Archivo; verifica también el fallback si una URL firmada expira o falla.

### Correcciones de arranque y medios v35 (24 de noviembre de 2026)

Los logs históricos de producción identificaron un `BOOT_ERROR` en `letters-api` v9: la versión `web-push@4.0.0` migró a ESM y no expone un `default`. La v10 corrigió la importación con `import { sendNotification, setVapidDetails } from 'web-push'`. La v11 conserva ese arreglo y añade diagnósticos seguros para errores del almacenamiento privado. El gateway responde correctamente al preflight; no se modificó CORS ni el modelo de autenticación. No volver a desplegar v9 ni sustituir el paquete por una versión antigua.

## Snapshot histórico — estado observado el 21 de noviembre de 2026

El siguiente bloque conserva la comprobación de solo lectura que se realizó sobre el proyecto `tiqbmuubpbmxqvtkcdhq` antes de la actualización v34. No describía el estado final del 23 de noviembre; la sección superior contiene el estado vigente y los cambios que se aplicaron después.

| Elemento | Estado remoto observado | Código local |
|---|---|---|
| `auth-api` | ACTIVE, v11 | El frontend mantiene el contrato de alta legado `recoveryCode`; el backend local incluye además rutas de paquetes que aún requieren publicación coordinada |
| `letters-api` | ACTIVE, v8 | El código local usa `list_user_letters_cursor` y `rename_app_profile` |
| Historial remoto (instantánea histórica) | 23 timestamps | 26 archivos SQL locales (inventario v32) |
| RPC de paquete de recuperación | `register_app_user_with_invite_idempotent_bundle` y `rotate_app_recovery_codes_bundle` existen | Se mantienen como funciones de la versión local; no se invocan desde el formulario público mientras `auth-api` siga en v11 |
| Paginación | `list_user_letters_cursor` existe | Se invoca desde el código local |
| Renombrado de perfil | `rename_app_profile` existe | Se invoca desde el código local |

El cotejo histórico del 21 de noviembre encontró 15 versiones comunes, once archivos locales no registrados y ocho versiones remotas sin archivo homónimo en el inventario v32. El estado actual v35 figura en el bloque superior. Los once archivos locales no registrados incluyen tres migraciones históricas/legacy de timestamps `20261116000000`, `20261116001000` y `20261116002000`, además de ocho propuestas (`20261119064344`, `20261119090000`, `20261120173200`, `20261120235900`, `20261121200000`, `20261121210000`, `20261121220000` y `20261123193000`).

La inspección del esquema también encontró los RPC principales de varias de esas ocho propuestas, los recibos de paquetes de recuperación, las columnas e índices de paginación y el trigger de protección de participantes/purga. Esto **no demuestra por sí solo** que cada sentencia de cada migración coincida con el estado remoto ni que todos sus efectos secundarios estén presentes. No se debe ejecutar ni marcar ninguna migración como aplicada sin un diff completo y una copia recuperable.

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

Para volver a verificar las versiones de Edge Functions con autenticación CLI, ejecuta `supabase functions list --remote=tiqbmuubpbmxqvtkcdhq`; es un comando de lectura. La lista verificada por el conector Supabase para v35 muestra `auth-api` v11 y `letters-api` v11 ACTIVE.

El timestamp del ledger y la presencia de un RPC no prueban identidad de DDL. Compara sus firmas, `definitionMd5`, propietario, privilegios, dependencias, columnas, restricciones, índices y triggers con los archivos locales y el baseline conocido.

## 2. Reconciliar las migraciones

1. Generar un respaldo cifrado verificable y restaurarlo en un proyecto desechable antes de tocar el esquema remoto.
2. Revisar cada una de las ocho propuestas locales no registradas. Clasificar cada sentencia como: ya aplicada y equivalente, aplicada con diferencias, ausente o obsoleta.
3. Revisar por separado los ocho timestamps remotos sin archivo local. Recuperar los archivos fuente históricos desde un snapshot fiable o construir y revisar un baseline; no inventarlos a partir de nombres.
4. Para cualquier migración local no registrada, solo usar `supabase migration repair --status applied <timestamp>` si se demostró que **todo** su efecto SQL ya existe y coincide. `migration repair` solo edita el ledger; no ejecuta SQL.
5. Si faltan efectos, crear una migración nueva, aditiva e idempotente con nombre/timestamp nuevo, probarla en un clon aislado y documentar cualquier diferencia. No reescribir un archivo histórico ya aplicado.
6. Ejecutar `npm run test:db`, pruebas pgTAP, pruebas de integración con dos cuentas y smoke tests antes de liberar funciones.

Nunca usar `supabase db reset --remote` en producción. No ejecutar `db push` hasta resolver los ocho timestamps remotos sin archivo, los once archivos locales sin registro (tres legacy y ocho propuestas) y el diff real del esquema.

## 3. Preparar Storage privado y migración de avatar

La actualización v35 ya desplegó `letters-api` v11 y aplicó `20261123205422_revoke_other_app_sessions_atomically.sql`. `user_profiles.avatar_path` ya existía en producción; no vuelvas a aplicar `20261123193000_private_media_and_profile_avatars.sql`. El bucket privado `private-media` se crea/configura desde Storage API al primer upload autenticado; no insertes ni actualices `storage.buckets` mediante SQL. Los pasos de comprobación y las pruebas de dos cuentas están en [`MEDIA_AND_AVATARS.md`](MEDIA_AND_AVATARS.md).

## 4. Estado de publicación de Edge Functions en v35

`letters-api` v11 se desplegó en el proyecto `tiqbmuubpbmxqvtkcdhq` desde el código v35, con `verify_jwt=false` porque su handler valida la sesión opaca mediante `requireSession`. `auth-api` permanece en v11; no se modificó ni desplegó durante esta actualización.

La migración `20261123205422_revoke_other_app_sessions_atomically.sql` está aplicada y el RPC quedó restringido a `service_role`. El deploy confirmó `letters-api` v11 ACTIVE y el inventario de migraciones confirmó 25 entradas.

Pruebas dinámicas que todavía deben realizarse desde cuentas reales: carga/lectura/eliminación del avatar, envío y recepción de imágenes de cartas entre dos cuentas, prueba IDOR de rutas ajenas y revocación real de una sesión secundaria manteniendo la actual. La prueba de humo SQL usó UUID no existentes y devolvió cero; no revocó sesiones de usuarios.


## 5. Backups y recuperación: puerta obligatoria antes de publicar

La organización figura en plan Free; no hay backups diarios administrados en ese plan. El workflow externo `backup-database.yml` no quedará operativo hasta configurar el Environment `database-backups`, el bucket privado, el destinatario `age` y las credenciales de carga. La ejecución programada tampoco se considera evidencia de recuperación.

Antes del despliegue:

1. Configurar secretos/variables conforme a `docs/BACKUP_RESTORE.md`.
2. Ejecutar un backup manual y verificar el objeto cifrado descargándolo, comparando SHA-256 y descifrando una copia de prueba.
3. Restaurar en un proyecto Supabase nuevo y aislado, nunca en `tiqbmuubpbmxqvtkcdhq`.
4. Comprobar esquema, seis recuentos, login de prueba, letras/respuestas y permisos de dos cuentas.
5. Registrar RPO/RTO observados, duración, checksum y resultado.

El manifiesto incluye ahora una instantánea de `supabase_migrations.schema_migrations` solo como metadato de referencia. La restauración no inserta ese ledger en el destino: una base restaurada desde un dump lógico no equivale a reconstruir de manera validada su historial de migraciones.

## 6. E2EE es una puerta de protocolo separada

`docs/E2EE_ARCHITECTURE.md` sigue siendo una propuesta: hoy las cartas y los borradores se almacenan/transmiten en texto legible y no existen claves ni ciphertext E2EE. No se ha añadido criptografía parcial ni se afirma que esté activada.

Antes de una implementación se necesita un protocolo versionado, revisión criptográfica independiente, biblioteca HPKE/Argon2id fijada, huellas verificadas entre las dos cuentas, respaldo/restauración de claves probado en dispositivos limpios, cifrado de borradores y pruebas contra XSS/alteración/replay. La migración de cartas históricas y la eliminación del plaintext necesitan confirmación de descifrado de ambos participantes. La recuperación normal de contraseña no puede recuperar claves E2EE.

**Prohibido activar una bandera E2EE o cambiar la interfaz para afirmar privacidad de extremo a extremo mientras el backend siga recibiendo texto legible.** Esta entrega prepara las puertas de reconciliación y respaldo; no implementa E2EE de producción.


### Correcciones de lectura y medios v37 (24 de noviembre de 2026)

La versión local v37 mejora la legibilidad de `letter-paper` y elimina los nombres de archivo de los textos alternativos de imágenes tanto en el sanitizador del navegador como en `letters-api`. Al abrir borradores, el editor muestra un placeholder visual mientras cada imagen se decodifica; el lector y la vista previa de envío usan marcos de carga con fallback. La tarjeta mantiene su sello/ícono hasta que aparece la primera miniatura privada firmada.

La lógica de firma `firstImageUrl` se introdujo en el código local v36 y se conserva en v37. La última comprobación remota registrada muestra `letters-api` v11 ACTIVE; el código no se ha desplegado mediante esta entrega. Para que las miniaturas aparezcan en producción, despliega la fuente local de `letters-api` y después publica el frontend v37. El bucket `private-media` permanece privado y no hay migración SQL nueva. No publiques solo el frontend esperando que aparezcan las miniaturas: si el API remoto no devuelve `firstImageUrl`, el fallback del sello es el comportamiento previsto.

Pruebas de aceptación adicionales:

1. Abre cartas largas y con formato en escritorio y en un teléfono estrecho; comprueba que título, remitente, fecha, cuerpo y firma no se solapan y que el final de la carta no queda recortado.
2. Abre un borrador con varias imágenes guardadas: durante la carga debe aparecer el esqueleto y nunca el nombre local del archivo; al finalizar deben aparecer las imágenes en el mismo orden.
3. En Borradores y en las demás listas, comprueba que `letter-stamp` muestra exclusivamente la primera imagen; la segunda y siguientes deben permanecer en el cuerpo de la carta.
4. Desde la cuenta destinataria, verifica la miniatura y el cuerpo de una carta recibida. Prueba también una imagen inexistente o una URL firmada caducada: el icono/placeholder debe sustituir al recurso roto.

### Corrección de miniaturas de Borradores y placeholder de carga v39 (24 de noviembre de 2026)

`letter-stamp` ahora tiene un fallback independiente de `firstImageUrl`: si el resumen no trae esa propiedad, el frontend extrae la primera ruta `data-image-path` del cuerpo (incluido el cuerpo del borrador) y solicita una URL firmada con `media:sign-letter-image`. El backend valida la sesión, la carta y la ruta; el cliente valida el origen HTTPS del proyecto y la ruta de firma privada. Las firmas se resuelven en grupos de hasta seis y se conservan en caché temporal. La versión remota v11 ya incluía `media:sign-letter-image`, de modo que esta corrección del frontend no exige desplegar una Edge Function nueva para miniaturas de borradores. `firstImageUrl` permanece como optimización adicional cuando la lista lo entrega.

Al seleccionar una imagen en el editor, el marco `Cargando imagen…` aparece antes de comprimir o subir. El HTML transitorio se excluye del sanitizador/persistencia y se sustituye por la imagen real cuando termina la subida. No se añade migración ni se modifica Supabase remoto.

Pruebas de aceptación: abrir Borradores con una carta que ya tenga imagen y confirmar que el icono temporal se sustituye por la primera miniatura; repetir con dos o más adjuntos y verificar que se conserva el primero. En el editor, seleccionar una imagen y comprobar que el marco de carga aparece inmediatamente, se reemplaza por la imagen al completar y no se guarda texto “Cargando imagen…” en la carta.

