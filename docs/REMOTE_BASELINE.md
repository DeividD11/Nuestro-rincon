# Estado del proyecto Supabase

Proyecto inspeccionado y actualizado el 17 de noviembre de 2026 mediante la conexión de administración Supabase.

## Proyecto

- Ref: `tiqbmuubpbmxqvtkcdhq`
- URL: `https://tiqbmuubpbmxqvtkcdhq.supabase.co`
- Nombre en Dashboard: `Book`
- Estado: `ACTIVE_HEALTHY`
- PostgreSQL 17
- Región: `us-west-2`
- Clave `publishable` activa y coincidente con `assets/js/config/app-config.js`.

## Edge Functions

| Función | Estado | Versión | Verificación JWT del gateway |
|---|---:|---:|---:|
| `auth-api` | ACTIVE | 8 | false |
| `letters-api` | ACTIVE | 8 | false |

Las dos funciones validan la sesión propia en el cuerpo del backend. `verify_jwt=false` no significa que las operaciones privadas queden sin autenticación. En `auth-api` v3 y `letters-api` v3 se corrigió el preflight CORS: `OPTIONS` devuelve `204` con cuerpo nulo. Las versiones anteriores intentaban responder `204` con el texto `ok`, lo que producía HTTP 500 y se manifestaba en el navegador como un error genérico de red.

## Migraciones remotas

El historial remoto tiene 20 entradas. Las últimas registradas son:

- `20261116045159_lock_down_direct_data_api`
- `20261116045242_self_service_accounts_and_email_recovery` (histórica; las rutas de email fueron sustituidas por registro sin email/código de recuperación)
- `20261116055118_opaque_sessions_local_recovery`
- `20261116164909_drafts_without_second_account`
- `20261117025358_unicode_usernames_and_system_theme`
- `20261117030115_secure_profile_and_password_updates`
- `20261117033226_secure_account_deletion`
- `20261117033323_account_deletion_uuid_fallback`
- `20261117035219_allow_provisional_draft_recipient_binding`
- `20261117041103_idempotent_recovery_for_purged_drafts`
- `20261117041205_reuse_account_slot_after_deletion`
- `20261117051628_idempotent_draft_revision_conflicts`

Ocho migraciones anteriores establecen el dominio original de autenticación/correspondencia. El conector devolvió sus versiones/nombres e inventario de esquema, pero no expuso los ocho archivos SQL fuente completos. Este paquete no inventa esos archivos históricos.

## Esquema y operaciones

Se verificó la existencia de `app_users`, `user_sessions`, `user_session_refresh_tokens`, `user_recovery_codes`, `letters`, `letter_threads`, `letter_user_state`, `notifications`, `user_profiles`, `user_settings` y tablas de soporte. RLS está activado en las tablas privadas; los roles públicos no acceden directamente a ellas. Las Edge Functions usan la credencial de servicio que Supabase inyecta automáticamente.

Las migraciones remotas se verificaron mediante el historial de Supabase y consultas de catálogo. Añade `access_token_hash`, `access_expires_at` y el RPC `register_app_user_without_email`. Este RPC es invocable por `service_role`, crea cuentas activas sin email y limita el espacio a dos cuentas.

Las funciones SQL relevantes comprobadas incluyen `register_app_user_without_email`, `start_app_login_attempt`, `complete_app_login_attempt`, `create_app_session_with_refresh`, `rotate_app_refresh_token`, `consume_app_recovery_code` y las operaciones de cartas/borradores/respuestas.

## Límites

El baseline es para continuar trabajando con este proyecto existente, no para restaurar un Supabase vacío. Para una restauración completa en otro proyecto hay que recuperar los SQL históricos, respaldar y revisar el esquema, roles, grants, extensiones, triggers, políticas y datos antes de aplicar migraciones.

## Incidente de conexión corregido el 16 de noviembre de 2026

Los registros de `auth-api` mostraron respuestas `OPTIONS | 500` y el error del runtime `Response with null body status cannot have body`. El navegador no podía continuar con el `POST`, por lo que el frontend mostraba “No fue posible conectar con el servicio”, aunque el proyecto y la función estaban activos. Se corrigió el preflight en la versión 3 de ambas funciones con `new Response(null, { status: 204, headers })`; después, `letters-api` pasó a versión 4 para incorporar los cambios de borradores y preferencias; el 17 de noviembre de 2026 ambas funciones pasaron a `auth-api` v4 y `letters-api` v5 para optimizar la validación y renovación de sesión. También se incorporó una prueba de contrato para impedir que se vuelva a introducir un cuerpo en respuestas 204.


## Borradores provisionales y preferencias de tema (16 de noviembre de 2026)

La migración remota `20261116164909_drafts_without_second_account` permite que `letter_threads.participant_b_id` y `letters.recipient_id` sean nulos únicamente durante la etapa de borrador provisional. `create_letter_draft` crea un hilo privado con la persona remitente y no requiere una segunda cuenta. `send_letter_draft` asigna la cuenta activa restante al destinatario y completa el par canónico antes de marcar la carta como enviada. Los RPC siguen reservados a `service_role`. Una prueba transaccional reversible confirmó que la creación de un borrador provisional funciona y que el rollback no deja cartas de prueba.

La migración `20261117041103_idempotent_recovery_for_purged_drafts` evita que una clave de creación histórica devuelva un borrador purgado como si siguiera activo. Si una clave ya apunta a una carta purgada, se deriva de forma determinista otra UUID bajo el mismo bloqueo idempotente; un reintento obtiene el mismo reemplazo y no duplica cartas. Se probó en una transacción reversible con una de las claves purgadas existentes: la función devolvió una nueva carta `draft` y el rollback eliminó el registro temporal.

La migración `20261117041205_reuse_account_slot_after_deletion` limita el conteo de registro a cuentas `active` o `pending_email`. Las cuentas anonimizadas y deshabilitadas dejan de consumir una de las dos plazas.

`letters-api` v6 sincronizó el nombre visible con `app_users` y `user_profiles`, además de mantener el tema `system` como valor predeterminado; la versión activa posterior es v8. Además de tolerar destinatarios nulos en consultas y nombres, `settings:update` valida y persiste `theme` (`light`, `dark`, `system`) junto con zona horaria y notificaciones. El frontend aplica el tema y lo guarda también como caché local, usando la preferencia de la cuenta como persistencia entre dispositivos.


## Optimización de la validación de sesiones (17 de noviembre de 2026)

Se actualizó el módulo compartido de `auth-api` y `letters-api`. La validación de la sesión sigue comprobando cada token, estado, expiración y cuenta activa en cada operación. La escritura de `last_seen_at` e `idle_expires_at` se limita a una vez por minuto y se ejecuta en paralelo con la consulta de la cuenta, reduciendo una ida y vuelta secuencial a Postgres por petición. En la actualización más reciente, `auth-api` v6 y `letters-api` v6 quedaron `ACTIVE`. Se verificaron peticiones `OPTIONS | 204` y `POST | 200` posteriores al despliegue.


El historial remoto incluye las migraciones `20261117025358_unicode_usernames_and_system_theme` (normalización Unicode de nombres de usuario y valor de tema `system`) y `20261117030115_secure_profile_and_password_updates` (RPC de cambio de contraseña con revocación de otras sesiones). `auth-api` versión 6 incorpora actualización autenticada del nombre de usuario/correo de contacto y cambio de contraseña con verificación de contraseña actual. El correo es informativo; no se envían mensajes ni se utiliza para acceso o recuperación.


## Cambios del 17 de noviembre de 2026: borradores, cuenta y sesiones

`auth-api` v7 incorporó `account:delete`, que revalida la contraseña actual y exige la confirmación literal `ELIMINAR` antes de llamar a `delete_app_account`. La operación borra datos privados, sesiones y borradores; las cartas enviadas se conservan para el otro participante y el autor queda representado por un registro deshabilitado/anónimo para mantener las referencias de integridad. La función SQL solo es ejecutable por `service_role`. Una prueba transaccional con cuenta temporal confirmó la eliminación de perfil/preferencias/sesiones y la revocación de la identidad de acceso; el test se revirtió sin dejar datos de prueba.

`letters-api` v7 había restaurado automáticamente un borrador al guardarlo; ese comportamiento se retiró en v8 para evitar que una sincronización atrasada lo sacara de Papelera. `auth-api` v8 devuelve el identificador de sesión en el inicio de sesión, refresh y consulta de sesión para que las pestañas reconozcan qué sesión fue revocada sin depender de una recarga manual. La migración `20261117035219_allow_provisional_draft_recipient_binding` permite que el destinatario se vincule una sola vez al enviar un borrador provisional sin segunda cuenta; cualquier otro cambio de identidad sigue bloqueado. Se detectó este defecto al revisar el trigger de inmutabilidad; la regla fue endurecida para permitir exclusivamente ese enlace inicial. La transacción end-to-end de envío más conservación compartida fue bloqueada por el control del ejecutor durante esta revisión, por lo que no se afirma que esa prueba dinámica haya pasado.

El frontend mantiene una copia urgente en `localStorage` más la persistencia de IndexedDB, serializa los guardados, reanuda sincronización al recuperar conexión o abrir de nuevo la app, y recrea una copia remota cuando el ID anterior ya no existe. El navegador no garantiza que una solicitud de red se complete al cerrar una pestaña; la recuperación local es la garantía prioritaria.


## Recuperación de borradores y eliminación de cuenta (17 de noviembre de 2026)

La migración `20261117041103_idempotent_recovery_for_purged_drafts` se comprobó contra una clave real que ya apuntaba a una carta purgada. La función creó un reemplazo con estado `draft`, usando una UUID derivada de forma determinista; la prueba se ejecutó en una transacción y se revirtió, sin dejar datos de prueba. Esto corrige el camino que antes devolvía un registro purgado y causaba el `404` al guardar el borrador.

`20261117041205_reuse_account_slot_after_deletion` hace que una cuenta deshabilitada y anonimizada ya no cuente contra el límite de dos registros. La eliminación de cuenta borra los datos privados y sesiones, elimina los borradores personales activos y conserva las cartas ya enviadas para el otro participante. El registro mínimo del usuario se conserva deshabilitado/anonimizado por integridad referencial. Una prueba reversible de borrado con cuenta temporal verificó que desaparecen borradores, sesiones, perfil y preferencias; la prueba de extremo a extremo de enviar una carta compartida y luego eliminar su remitente no se pudo completar durante esta revisión, por lo que esa combinación no se declara validada dinámicamente.


## Estado remoto vigente después de esta revisión (17 de noviembre de 2026)

El inventario remoto confirmó `auth-api` v8 y `letters-api` v8 en estado `ACTIVE`, con 20 migraciones aplicadas. `auth-api` v8 incluye `sessionId` en creación, renovación y consulta de sesión para la detección de revocación. La interfaz verifica la sesión actual cada 10 segundos cuando la pestaña está visible y en línea; entre pestañas del mismo navegador el evento de revocación se comunica de inmediato con `BroadcastChannel`.

La recuperación de borradores se comprobó en una transacción reversible usando una clave de creación real que pertenecía a una carta purgada. `create_letter_draft` derivó un identificador sustituto y devolvió un borrador activo; la transacción se revirtió para no dejar datos de prueba. La eliminación de cuenta se comprobó para el borrado de borradores privados, sesiones, preferencias y perfil de una cuenta temporal. La combinación de envío de una carta compartida y eliminación posterior de su remitente no se pudo completar como prueba dinámica en esta revisión; la lógica de preservación se revisó en el SQL y el trigger de inmutabilidad permite la vinculación inicial de destinatario una sola vez.


## Corrección de borradores y papelera (17 de noviembre de 2026)

La migración `20261117051628_idempotent_draft_revision_conflicts` cambia `save_letter_draft` para comparar primero el contenido recibido con el contenido persistido. Si ambos coinciden, un reintento responde `saved` con la revisión vigente, aunque el cliente conserve una revisión anterior. Si el contenido sí difiere y la revisión quedó obsoleta, mantiene el control de conflicto y devuelve el borrador remoto. El RPC continúa reservado a `service_role`; las comprobaciones de privilegios confirmaron que `anon` y `authenticated` no tienen permiso de ejecución. Una prueba transaccional con el borrador activo y una revisión obsoleta, pero contenido idéntico, respondió correctamente y se revirtió sin modificar datos.

`letters-api` v8 no restaura borradores al ejecutar guardados automáticos ni permite enviar un borrador cuyo estado personal esté en Papelera. La única salida de Papelera es la acción explícita `restore`. El frontend serializa la sincronización de borradores en un único carril por cuenta, marca el ID como descartado antes de esperar tareas pendientes, espera la cola y mueve la carta a Papelera; luego elimina las copias locales y actualiza la lista/caché inmediatamente, mientras refresca los datos en segundo plano. Descartar desde Borradores no pide una segunda confirmación.

Las pruebas automatizadas incluyen regresiones para descarte de un solo clic, espera de la cola de sincronización, no restauración automática desde Papelera, guardados repetidos con contenido idéntico y renovación simultánea de sesión. Un único refresh token no se rota en paralelo por varios `401`; las peticiones antiguas vuelven a intentar con el token vigente y una renovación pendiente no puede reactivar una sesión cerrada. El backend remoto y la migración quedaron activos; al publicar la aplicación solo se requiere sustituir el frontend estático.


## Incidencia de renovación simultánea de sesión

Los registros de auditoría remotos mostraron varias entradas `session.refresh_reuse_detected` para una misma sesión con diferencias de milisegundos (por ejemplo, el 17 de noviembre de 2026 a las 04:56:16 UTC y 05:12:14 UTC). Esto concuerda con varias peticiones que intentaron rotar el mismo refresh token; el RPC de seguridad detectó el replay y revocó la sesión. El frontend centraliza ahora `refreshSession()` en `SessionService`: las peticiones concurrentes esperan la misma promesa de renovación, `checkCurrentSession()` utiliza ese mismo camino, y una petición que recibe tarde un `401` vuelve a intentar con el access token ya renovado en vez de rotar de nuevo el refresh token antiguo. Las escrituras no se reintentan por fallos de transporte/timeout/5xx; el único reintento de escritura permitido es ante `401` luego de renovar sesión, porque el backend rechaza esa petición antes de ejecutar la operación. Un contador de generación impide que una respuesta tardía restaure la sesión después de un cierre de sesión o un nuevo inicio. Esta protección se verifica con pruebas de concurrencia y no debilita la detección de reutilización en el backend.
