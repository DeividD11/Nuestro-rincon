# Estado del proyecto Supabase

> **Estado remoto vigente:** consulta la actualización de reconciliación v23 al final de este documento. Las secciones intermedias documentan revisiones previas; cuando difieran, prevalece v23 para el estado remoto. El inventario del código fuente local se actualizó por separado con el paquete v25 del 22 de noviembre de 2026.

Baseline histórico iniciado el 19 de noviembre de 2026 y ampliado con lecturas de solo consulta posteriores. La última actualización consolidada es la sección “Actualización de reconciliación de solo lectura — 21 de noviembre de 2026 (v23)”.

## Proyecto

- Ref: `tiqbmuubpbmxqvtkcdhq`
- URL: `https://tiqbmuubpbmxqvtkcdhq.supabase.co`
- Nombre en Dashboard: `Nuestro Rincón`
- Estado: `ACTIVE_HEALTHY`
- PostgreSQL 17
- Región: `us-west-2`
- Clave `publishable` activa y coincidente con `assets/js/config/app-config.js`.

## Edge Functions

| Función | Estado | Versión | Verificación JWT del gateway |
|---|---:|---:|---:|
| `auth-api` | ACTIVE | 11 | false |
| `letters-api` | ACTIVE | 8 | false |

Las dos funciones validan la sesión propia en el cuerpo del backend. `verify_jwt=false` no significa que las operaciones privadas queden sin autenticación. En `auth-api` v3 y `letters-api` v3 se corrigió el preflight CORS: `OPTIONS` devuelve `204` con cuerpo nulo. Las versiones anteriores intentaban responder `204` con el texto `ok`, lo que producía HTTP 500 y se manifestaba en el navegador como un error genérico de red.

## Migraciones remotas

El historial remoto consultado tenía 23 entradas en la lectura del 21 de noviembre. En el inventario local v25 hay siete propuestas SQL posteriores que no aparecen en el ledger; la inspección remota del 21 de noviembre encontró objetos relacionados con propuestas anteriores, sin certificar equivalencia completa de cada archivo. Las últimas registradas son:

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
- `20261118203751_private_registration_invitations`
- `20261118204339_registration_invitation_fk_indexes`
- `20261119050910_idempotent_registration_recovery_handoff`

Ocho migraciones anteriores establecen el dominio original de autenticación/correspondencia. El conector devolvió sus versiones/nombres e inventario de esquema, pero no expuso los ocho archivos SQL fuente completos. Este paquete no inventa esos archivos históricos.

## Esquema y operaciones

Se verificó la existencia de `app_users`, `user_sessions`, `user_session_refresh_tokens`, `user_recovery_codes`, `letters`, `letter_threads`, `letter_user_state`, `notifications`, `user_profiles`, `user_settings` y tablas de soporte. RLS está activado en las tablas privadas; los roles públicos no acceden directamente a ellas. Las Edge Functions usan la credencial de servicio que Supabase inyecta automáticamente.

Las migraciones históricas de sesiones y cuentas añadieron `access_token_hash`, `access_expires_at` y `register_app_user_without_email`. La ruta sin invitación era el mecanismo de alta anterior y quedó deshabilitada en la migración `20261118203751_private_registration_invitations`: su permiso de ejecución fue revocado también a `service_role`. El único alta vigente es `register_app_user_with_invite_idempotent`, que exige un token de invitación, una clave idempotente y el hash del código de recuperación; crea la cuenta, el perfil, las preferencias, el hash de recuperación, el recibo y consume la invitación dentro de la misma transacción. El RPC anterior `register_app_user_with_invite` quedó revocado también a `service_role`.

Las funciones SQL relevantes comprobadas incluyen `register_app_user_with_invite_idempotent`, `rotate_app_recovery_code`, `check_app_registration_invite`, `create_app_registration_invite`, `revoke_app_registration_invite`, `start_app_registration_invite_attempt`, `complete_app_registration_invite_attempt`, `get_app_registration_invitation_status`, `start_app_login_attempt`, `complete_app_login_attempt`, `create_app_session_with_refresh`, `rotate_app_refresh_token`, `consume_app_recovery_code` y las operaciones de cartas/borradores/respuestas.

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


## Estado remoto anterior a las invitaciones (17 de noviembre de 2026)

El inventario remoto de esa fecha confirmó `auth-api` v8 y `letters-api` v8 en estado `ACTIVE`, con 20 migraciones aplicadas. `auth-api` v8 incluye `sessionId` en creación, renovación y consulta de sesión para la detección de revocación. La interfaz verifica la sesión actual cada 10 segundos cuando la pestaña está visible y en línea; entre pestañas del mismo navegador el evento de revocación se comunica de inmediato con `BroadcastChannel`.

La recuperación de borradores se comprobó en una transacción reversible usando una clave de creación real que pertenecía a una carta purgada. `create_letter_draft` derivó un identificador sustituto y devolvió un borrador activo; la transacción se revirtió para no dejar datos de prueba. La eliminación de cuenta se comprobó para el borrado de borradores privados, sesiones, preferencias y perfil de una cuenta temporal. La combinación de envío de una carta compartida y eliminación posterior de su remitente no se pudo completar como prueba dinámica en esta revisión; la lógica de preservación se revisó en el SQL y el trigger de inmutabilidad permite la vinculación inicial de destinatario una sola vez.


## Corrección de borradores y papelera (17 de noviembre de 2026)

La migración `20261117051628_idempotent_draft_revision_conflicts` cambia `save_letter_draft` para comparar primero el contenido recibido con el contenido persistido. Si ambos coinciden, un reintento responde `saved` con la revisión vigente, aunque el cliente conserve una revisión anterior. Si el contenido sí difiere y la revisión quedó obsoleta, mantiene el control de conflicto y devuelve el borrador remoto. El RPC continúa reservado a `service_role`; las comprobaciones de privilegios confirmaron que `anon` y `authenticated` no tienen permiso de ejecución. Una prueba transaccional con el borrador activo y una revisión obsoleta, pero contenido idéntico, respondió correctamente y se revirtió sin modificar datos.

`letters-api` v8 no restaura borradores al ejecutar guardados automáticos ni permite enviar un borrador cuyo estado personal esté en Papelera. La única salida de Papelera es la acción explícita `restore`. En la versión local v14 el descarte aguardaba la cola de borradores; la versión local v15 sustituye esa espera por una retirada optimista inmediata y deja que PostgreSQL serialice el guardado y el descarte bloqueando la carta y el estado personal en el mismo orden. Una escritura tardía recibe `discarded`; no puede modificar ni sacar de Papelera el borrador. `letters-api` también rechaza la creación de un borrador nuevo cuyo cuerpo esté vacío. Descartar desde Borradores no pide una segunda confirmación.

Las pruebas automatizadas incluyen regresiones para descarte de un solo clic, protección contra el autoguardado tardío en Papelera, no restauración automática desde Papelera, guardados repetidos con contenido idéntico y renovación simultánea de sesión. Un único refresh token no se rota en paralelo por varios `401`; las peticiones antiguas vuelven a intentar con el token vigente y una renovación pendiente no puede reactivar una sesión cerrada. El backend remoto y la migración quedaron activos; al publicar la aplicación solo se requiere sustituir el frontend estático.


## Incidencia de renovación simultánea de sesión

Los registros de auditoría remotos mostraron varias entradas `session.refresh_reuse_detected` para una misma sesión con diferencias de milisegundos (por ejemplo, el 17 de noviembre de 2026 a las 04:56:16 UTC y 05:12:14 UTC). Esto concuerda con varias peticiones que intentaron rotar el mismo refresh token; el RPC de seguridad detectó el replay y revocó la sesión. El frontend centraliza ahora `refreshSession()` en `SessionService`: las peticiones concurrentes esperan la misma promesa de renovación, `checkCurrentSession()` utiliza ese mismo camino, y una petición que recibe tarde un `401` vuelve a intentar con el access token ya renovado en vez de rotar de nuevo el refresh token antiguo. Las escrituras no se reintentan por fallos de transporte/timeout/5xx; el único reintento de escritura permitido es ante `401` luego de renovar sesión, porque el backend rechaza esa petición antes de ejecutar la operación. Un contador de generación impide que una respuesta tardía restaure la sesión después de un cierre de sesión o un nuevo inicio. Esta protección se verifica con pruebas de concurrencia y no debilita la detección de reutilización en el backend.


## Primera implementación del registro mediante invitaciones privadas (18 de noviembre de 2026; estado histórico)

La primera etapa aplicó `20261118203751_private_registration_invitations` y posteriormente `20261118204339_registration_invitation_fk_indexes`. En ese momento el historial remoto quedó en **22 migraciones** y `auth-api` pasó a **v9 ACTIVE**; `letters-api` permanece en **v8 ACTIVE**.

La migración crea `registration_invites` y `registration_invite_attempts`, ambas con RLS habilitado y permisos de tabla reservados a `service_role`. Se comprobó que `anon` y `authenticated` no tienen permiso `SELECT` sobre ninguna de ellas. Las RPC nuevas son `SECURITY INVOKER` y solo `service_role` puede ejecutarlas; el procedimiento `bootstrap_app_registration_invite()` queda autorizado exclusivamente al rol PostgreSQL `postgres`. Las rutas históricas `register_app_user_without_email`, `register_app_user`, `accept_app_invitation` y `create_app_invitation` fueron revocadas también a `service_role`.

La invitación se genera con 32 bytes aleatorios, se representa como `NR1-` más ocho grupos hexadecimales, vence a los siete días y solo se muestra en la respuesta de creación. La base de datos guarda el hash SHA-256 con separación de dominio, nunca el código en claro. `register_app_user_with_invite` valida el token bajo `SELECT ... FOR UPDATE` y consume la invitación en la misma transacción que la creación de usuario, perfil, preferencias y código de recuperación. El rate limit usa huellas HMAC de IP y hash de código: 10 intentos por IP y 5 por código en 15 minutos.

El conteo remoto consultado después de la migración conserva **una cuenta activa y una fila total**. No se generó una invitación real ni se creó una segunda cuenta durante la implementación. La primera cuenta podrá generar la invitación desde **Configuración → Invitación privada**, una vez que el frontend actualizado se publique en GitHub Pages. No se debe ejecutar el procedimiento de bootstrap en este proyecto existente; es solo para una base nueva sin cuentas.

La validación remota comprobó la versión activa de `auth-api`, el registro de ambas migraciones, los permisos de tablas y RPC, y que las rutas antiguas ya no son ejecutables. No se declara una prueba end-to-end de registro con una segunda cuenta real, para no consumir una invitación ni alterar los datos de producción.


## Entrega recuperable del código de recuperación (19 de noviembre de 2026)

Se aplicó la migración `20261119050910_idempotent_registration_recovery_handoff`; el historial remoto quedó en **23 migraciones** y `auth-api` pasó a **v10 ACTIVE**. La actualización posterior de `auth-api` a **v11 ACTIVE** no requirió otra migración: endureció el límite de intentos en la ruta de reanudación idempotente. `letters-api` permanece en **v8 ACTIVE**.

El navegador genera el código de recuperación antes de enviar el alta y conserva temporalmente el código, la clave idempotente y los datos mínimos del intento en `localStorage`. No almacena la contraseña. El uso de `localStorage` permite recuperar el código después de recargar o cerrar accidentalmente la pestaña/navegador; no permite recuperarlo si se borra el almacenamiento del sitio o se cambia a otro navegador/dispositivo antes de guardarlo externamente. El código pendiente se elimina cuando la persona confirma que lo guardó.

`register_app_user_with_invite_idempotent` valida una clave de petición, el hash de la invitación, el nombre de usuario y el hash del código; bajo bloqueos transaccionales crea cuenta, perfil, preferencias, código y recibo, y consume la invitación en la misma transacción. El recibo permite reanudar un alta confirmada aunque se haya perdido la respuesta HTTP. El backend vuelve a verificar la contraseña antes de crear una nueva sesión; la clave idempotente no es un mecanismo para iniciar sesión por sí sola.

`auth-api` v10 separa el resultado de creación de cuenta del resultado de autenticación. Si el alta se confirmó y fallan la lectura posterior del usuario o la creación de sesión, responde `accountCreated: true` y `authenticated: false`; el frontend conserva el código y permite iniciar sesión o repetir la misma petición con la misma clave idempotente. Los errores definitivos se distinguen de los fallos de red/5xx para no mostrar un código que nunca fue activado.

La acción `recovery-code:rotate` permite regenerar un código desde Configuración después de verificar la contraseña actual y la sesión vigente. La transacción invalida todos los códigos anteriores, inserta el nuevo hash y deja un recibo idempotente para que un reintento devuelva el mismo resultado. El nuevo código se conserva localmente hasta que la persona confirme que lo guardó.

La verificación remota confirmó que ambas tablas nuevas (`registration_request_receipts` y `recovery_code_rotation_receipts`) tienen RLS habilitado, no otorgan acceso a `anon` ni `authenticated` y reservan privilegios a `service_role`. Las RPC nuevas son `SECURITY INVOKER`, solo `service_role` puede ejecutarlas y el RPC de alta anterior quedó revocado. El inventario remoto continúa con **una cuenta activa y una invitación pendiente**; no se consumió la invitación ni se creó una segunda cuenta durante esta modificación.

La suite automatizada local incorpora pruebas de reintento tras `503`, respuesta de alta confirmada sin sesión y clasificación de errores definitivos. No se ejecutó un registro end-to-end con una segunda cuenta real para no consumir la invitación de producción.


### Endurecimiento del reintento y estado del código (19 de noviembre de 2026)

`auth-api` v11 mueve la consulta del recibo idempotente detrás del limitador de intentos por huella de IP y código. Así, una persona no puede usar la ruta de reanudación para probar contraseñas sin que esos intentos cuenten contra los límites de 10 por IP y 5 por código en 15 minutos. Los intentos de reanudación se completan en auditoría como aceptados o rechazados.

La interfaz distingue ahora un código confirmado de un código pendiente de confirmación. Si el resultado HTTP es incierto, muestra el código conservado localmente, pero no afirma que ya esté activo; pide reintentar la misma operación. Si se produce un conflicto de contraseña al reanudar, tampoco afirma que el código siga vigente: indica que debe iniciarse sesión con la contraseña actual y, de ser necesario, regenerarlo desde Configuración → Código de recuperación.

Se volvió a consultar el proyecto remoto: `auth-api` está `ACTIVE` en v11; `letters-api` continúa `ACTIVE` en v8; el historial conserva 23 migraciones. Las tablas de recibos mantienen RLS, sin permisos de tabla para `anon` ni `authenticated`, y las RPC nuevas siguen reservadas a `service_role`. No se generó ni consumió otra invitación; la cuenta existente y la invitación pendiente permanecen sin cambios.


## Revisión de seguridad y reconstrucción (19 de noviembre de 2026)

La lectura directa del proyecto remoto volvió a confirmar 23 migraciones en historial, `auth-api` v11 ACTIVE y `letters-api` v8 ACTIVE. No se aplicó la migración de rate limiting de esta entrega ni se desplegó código a producción.

El ZIP recibido tenía 18 archivos SQL antes de esta propuesta. De ellos, 15 coinciden con migraciones del historial remoto, faltan las ocho primeras migraciones remotas y hay tres archivos locales heredados/no canónicos (`20261116000000_lock_down_direct_data_api`, `20261116001000_first_account_bootstrap` y `20261116002000_self_service_accounts_and_email_recovery`). Esta entrega añade una nueva migración propuesta `20261119064344_auth_attempt_rate_limits.sql`, que **no** forma parte de las 23 migraciones aplicadas.

`supabase/schema/` no contenía un dump. Se añaden instrucciones en `docs/DB_REBUILD.md`, pero no se afirma que el esquema haya quedado reconstruido desde cero: para obtener el dump oficial es necesario ejecutar Supabase CLI v3 contra el proyecto remoto o una rama de desarrollo. No inventar ni renumerar las ocho migraciones históricas ausentes.

La nueva prueba `supabase/tests/auth_rate_limits.test.sql` y la prueba HTTP `tests/integration/two-account-security.test.mjs` se añadieron al repositorio, pero no se ejecutaron contra PostgreSQL ni contra dos cuentas reales en un proyecto aislado. No hay una branch de desarrollo creada. `auth-api` sigue v11 y `letters-api` sigue v8 en producción.


### Continuación local: pantalla de recuperación y protección de intentos (19 de noviembre de 2026)

La versión de trabajo de este paquete refuerza el traspaso del código: al arrancar, la aplicación detecta y muestra el handoff persistido antes de intentar restaurar la sesión. Se detienen las actualizaciones periódicas de notificaciones y sincronización mientras el código esté visible; el código puede copiarse mediante Clipboard API o una selección manual compatible con navegadores móviles. La confirmación de guardado requiere una acción explícita. Si otra pestaña revoca la sesión durante ese intervalo, la pantalla del código no se sustituye; después de confirmarlo, se limpia la sesión revocada y se solicita un nuevo inicio de sesión. Estas modificaciones son locales al ZIP y todavía no se han publicado en GitHub Pages.

Se añade la migración propuesta `20261119064344_auth_attempt_rate_limits.sql`: limita por combinación cuenta+IP y por IP, con enfriamiento progresivo; los intentos distribuidos contra un nombre de usuario se auditan y, desde el décimo fallo, activan fricción progresiva solo en respuestas fallidas (100 ms a un máximo de 1,6 s). Una contraseña correcta no se ralentiza ni se bloquea la cuenta globalmente. El identificador y la dirección IP se almacenan como HMAC. `auth-api` del paquete llama a la RPC nueva `start_app_auth_attempt`; por tanto, la migración y esa Edge Function deben desplegarse juntas en la branch de pruebas. No se debe desplegar esta versión de la función en producción antes de aplicar y validar la migración en un entorno aislado.

La suite local final de esta entrega contiene **94 pruebas**; `npm run check`, `npm run build:pages` y la comprobación TypeScript de `auth-api`, `letters-api` y el módulo compartido pasan. La prueba HTTP de dos cuentas se ha empaquetado, pero se omite de forma segura si no recibe las variables del entorno aislado. pgTAP exige `NR_TEST_CONFIRM_ISOLATED=YES`, un project ref distinto de producción y una URL PostgreSQL cuyo host coincida exactamente. Ni pgTAP ni la prueba HTTP se han ejecutado contra una branch remota real; tampoco se ejecutó Playwright en navegador real en este entorno.


## Mejoras locales de consistencia de cartas (19 de noviembre de 2026)

El paquete local incorpora la migración pendiente `20261119090000_shared_letter_purge_and_reply_guard.sql`. Ajusta `guard_letter_participants_and_immutability` para permitir purgar una respuesta ya existente aunque su carta padre tenga `status = 'purged'`, sin permitir crear una respuesta nueva sobre un padre purgado ni modificar la identidad/hilo. También hace idempotente la confirmación de purga compartida y diferencia una primera confirmación de una repetición. La prueba `supabase/tests/shared_letter_purge.test.sql` contiene once aserciones para validar el flujo de confirmación, purga de respuestas y rechazo de un autoguardado sobre un borrador en Papelera, dentro de una transacción reversible; está incorporada al ejecutor pgTAP, pero no se ha ejecutado contra un proyecto aislado en esta entrega.

La interfaz y `letters-api` incluyen deduplicación por UUID en listas y conversaciones, caché de lista acotada por cuenta, limpieza completa del estado privado al cambiar de sesión, apertura inmediata a partir del resumen de tarjeta y marcado de lectura en segundo plano. La actualización v15 reutiliza el hilo ya cargado para cambiar entre cartas sin reconstruir el shell ni consultar otra vez el detalle de la misma conversación; usa actualizaciones optimistas con reversión para favorito, archivo, descarte, restauración y eliminación; y no crea borradores vacíos al entrar al editor. La misma migración pendiente hace que `save_letter_draft` compruebe y bloquee el estado de Papelera para impedir una reaparición por autoguardado tardío. Estos cambios están en el paquete local: la migración no está aplicada en producción y `letters-api` continúa en versión remota 8 hasta ejecutar la validación y despliegue.


## Actualización local: purga tras eliminación de cuenta, tipado y paginación (20 de noviembre de 2026)

Una consulta de solo lectura del proyecto remoto encontró una cuenta activa, una cuenta deshabilitada y tres cartas compartidas en `sent` que estaban en Papelera con confirmación registrada por la cuenta activa. El participante deshabilitado ya no conserva su `letter_user_state`, por lo que la función remota anterior (`confirm_letter_permanent_deletion`) exigía una confirmación que no podía llegar. Este diagnóstico coincide con el aviso que muestra la interfaz.

El nuevo archivo local `20261120173200_fix_orphaned_purge_and_list_pagination.sql` cambia la condición: solo cuentan participantes cuyo `app_users.status = 'active'`. Al pasar una cuenta de `active` a `disabled`, un trigger vuelve a evaluar sus cartas. Si cada cuenta que sigue activa ya confirmó su eliminación, el contenido se purga; si queda otra cuenta activa sin confirmar, la carta se conserva para ella. La migración incluye un barrido que purgaría las tres cartas huérfanas observadas porque la cuenta activa ya había confirmado. **Este comportamiento aún no se ha aplicado a producción**: hasta aplicar y verificar la migración, el proyecto remoto conserva la función antigua y el aviso puede repetirse.

La misma migración propone `list_user_letters`, una consulta del lado de PostgreSQL con filtro por carpeta, búsqueda de texto, total, no leídas, offset/limit y orden determinista por fecha e ID. `letters-api` utiliza esa RPC para evitar buscar solo dentro de los primeros 100 registros. Hilos y notificaciones usan rangos REST de PostgreSQL con `Range` y `Prefer: count=exact`; el frontend carga páginas progresivamente al desplazarse y conserva un botón accesible como alternativa. Se añaden índices compuestos para los órdenes de carpeta, hilo y notificaciones.

El código TypeScript define contratos explícitos y validadores en tiempo de ejecución para las respuestas de creación de borrador y listado paginado. El workflow de Pages instala Deno y ejecuta `npm run check:edge` (`deno check`) antes de las pruebas, la compilación y el despliegue; un error de tipos detendrá ese job antes de publicar. El entorno local de esta entrega no tiene Deno instalado, por lo que no se declara una ejecución local de `deno check`; se ejecuta una comprobación equivalente con `tsc` sobre los módulos Edge y GitHub Actions repetirá la verificación nativa de Deno.

La arquitectura E2EE se documenta en `docs/E2EE_ARCHITECTURE.md`. No se implementa criptografía parcial ni se cambia el almacenamiento de las cartas en esta versión: el contenido sigue en claro y el documento describe las claves, sobres, respaldo, recuperación, límites de búsqueda y migración histórica que deben resolverse antes de activar E2EE.

El paquete v20 contiene 23 SQL: 15 que coinciden con entradas remotas, tres archivos heredados/no canónicos y cinco propuestas locales (`20261119064344`, `20261119090000`, `20261120173200`, `20261120235900` y `20261121200000`). Producción sigue con 23 migraciones, `auth-api` v11 ACTIVE y `letters-api` v8 ACTIVE. Las ocho RPC/estructuras declaradas por las primeras cuatro propuestas ya estaban presentes en el esquema real, aunque sus timestamps no aparecen en el ledger; la quinta propuesta crea recibos y el nuevo RPC de registro con diez códigos y sigue pendiente. No se aplicó SQL ni se desplegaron Edge Functions durante esta revisión.


## Modularización de controladores y perfil transaccional (20 de noviembre de 2026)

La distribución de frontend separa el controlador original en `AppController` (coordinación), `AuthController`, `NavigationController`, `LetterController`, `DraftController`, `SettingsController` y `NotificationController`. El coordinador conserva la inicialización y la delegación de eventos compartidos; los módulos especializados aportan métodos al mismo contexto de aplicación mediante descriptores de prototipo, de modo que comparten estado sin introducir una segunda instancia ni duplicar cachés. La cola de sincronización de borradores se aisló en `DraftSyncQueue`.

Los sondeos periódicos se gestionan con `AdaptivePoller`: suspende temporizadores cuando la pestaña está oculta o no hay conexión, se despierta al volver a la pestaña o recuperar conectividad, usa intervalos activos/inactivos y aplica backoff exponencial al fallar. La sesión pasa a 5 minutos activa y 15 minutos inactiva; las notificaciones a 2 y 10 minutos respectivamente. No se activó Supabase Realtime: la aplicación usa sesiones opacas propias y esta entrega prioriza el polling adaptativo y controlable sin introducir un canal Realtime que no forme parte de la autenticación actual.

El flujo `profile:rename` usa ahora un único RPC `rename_app_profile`, que actualiza `app_users` y realiza `INSERT ... ON CONFLICT ... DO UPDATE` en `user_profiles` dentro de una sola transacción PostgreSQL. El RPC está reservado a `service_role`; la Edge Function deriva `p_user_id` de la sesión validada, no del cuerpo enviado por el navegador. Se comprobó en el esquema remoto que `user_profiles.user_id` es su clave primaria y que el perfil restringe la longitud del nombre visible a 80 caracteres.

La migración local `20261120235900_transactional_profile_rename.sql` **no se ha aplicado a producción**. El último baseline remoto confirmado permanece en 23 migraciones, `auth-api` v11 y `letters-api` v8; esta entrega solo modifica el paquete local. El archivo SQL local suma una cuarta migración propuesta pendiente.


## Accesibilidad y distribución de código fuente (21 de noviembre de 2026)

La capa principal `#app` ya no es una región `aria-live`: las actualizaciones de vistas no deben anunciar de forma masiva su contenido. Las confirmaciones y los errores usan dos regiones pequeñas y estables (`status`/`alert`). La navegación autenticada añade enlace para saltar al contenido, nombre de navegación, ruta activa y encabezado enfocable; el menú móvil alterna `inert` y `aria-hidden` para que el panel cerrado no reciba foco. Los diálogos de vista previa retienen el foco, cierran con Escape y lo devuelven al disparador. Los campos del editor y los formularios tienen nombres y tipos de botón explícitos.

Se documentó una matriz de validación de teclado y lectores de pantalla en `docs/ACCESSIBILITY.md`. La comprobación automática cubre el contrato HTML/CSS y la gestión del foco simulada, pero en esta entrega no se ejecutaron NVDA, VoiceOver ni TalkBack; la conformidad WCAG no se declara certificada.

El README y este baseline identifican `auth-api` v11 y `letters-api` v8 para la última inspección remota conocida. En el paquete v17 recibido no se encontraron referencias de README a `auth-api` v10; esta entrega añade una comprobación automatizada para evitar que reaparezca esa discrepancia.

El ZIP v17 de partida ya no contenía la carpeta `.git/`; por tanto, el historial de commits no estaba disponible para inspeccionarlo desde ese archivo. El nuevo `scripts/package-zip.mjs` excluye `.git/`, `node_modules/`, `.env` y artefactos de build/pruebas al generar futuras distribuciones. Esto no equivale a una auditoría del historial del repositorio GitHub: para revisar commits antiguos por secretos se necesita escanear el repositorio remoto o un clon íntegro con herramientas como un detector de secretos. No se modificó ni se reescribió el historial.

Las notificaciones push externas se mantienen fuera del alcance de esta entrega. `docs/PUSH_NOTIFICATIONS_ROADMAP.md` describe un diseño futuro compatible con las sesiones opacas propias, con consentimiento explícito, claves VAPID privadas solo en backend, payloads sin contenido de cartas y revocación por dispositivo.


## Reconciliación remota en vivo: esquema y Edge Functions (21 de noviembre de 2026)

Se realizó una lectura de solo consulta del proyecto `tiqbmuubpbmxqvtkcdhq` mediante la conexión administrativa disponible. El proyecto aparece `ACTIVE_HEALTHY`, con PostgreSQL `17.11.0.019`. El historial remoto sigue mostrando 23 migraciones, con última entrada `20261119050910_idempotent_registration_recovery_handoff`; las Edge Functions activas siguen siendo `auth-api` v11 y `letters-api` v8. No se ejecutaron escrituras, migraciones, despliegues ni cambios de datos.

En la instantánea de esta sección (21 de noviembre, anterior a la séptima propuesta local), la inspección detectó que algunas estructuras incluidas en seis migraciones no registradas ya existían en la base de datos: la RPC `start_app_auth_attempt(p_identifier_hash text, p_ip_digest text, p_action text, p_now timestamptz)`, `list_user_letters(p_user_id uuid, p_folder text, p_search text, p_offset integer, p_limit integer)`, `rename_app_profile(p_user_id uuid, p_display_name text, p_now timestamptz)` y `confirm_letter_permanent_deletion(p_user_id uuid, p_letter_id uuid)`. También se encontraron la columna `login_attempts.ip_digest`, la columna `login_attempts.action`, el trigger `app_user_purge_shared_letters_after_disable` y los índices de paginación de cartas, estado personal y notificaciones. Una consulta de existencia confirmó además `guard_letter_participants_and_immutability`, `save_letter_draft`, `purge_shared_letters_without_active_confirmation` y `purge_shared_letters_after_account_disabled`. Las ocho funciones inspeccionadas son propiedad de `postgres`; `anon` y `authenticated` no tienen `EXECUTE`, mientras `service_role` sí.

Sin embargo, el código remoto de las funciones no está sincronizado con el código local del ZIP: `auth-api` v11 continúa llamando a `start_app_login_attempt`, mientras el código local usa `start_app_auth_attempt`; `letters-api` v8 sigue actualizando `app_users` y `user_profiles` con dos peticiones separadas en `profile:rename`, y no llama a `rename_app_profile` ni a `list_user_letters`. Por tanto, la base contiene algunas funciones y estructuras más recientes que las versiones de Edge Functions activas, mientras el registro de migraciones no contiene las cuatro versiones locales que parecen describirlas.

Esta diferencia debe tratarse como **deriva entre esquema real, historial de migraciones y código desplegado**, no como prueba de que las migraciones faltan por completo. No ejecutar `supabase db push --remote`, no aplicar a ciegas los seis candidatos que existían en esa instantánea (el inventario v25 ya contiene siete propuestas) y no desplegar las Edge Functions locales todavía. Primero se deben comparar las definiciones completas y los permisos (`EXECUTE`, ownership y grants) de cada RPC remota con los archivos SQL locales; comprobar el estado de los triggers e índices; preparar una restauración de respaldo; y reproducir la secuencia en un proyecto o branch aislado. La historia puede necesitar una reconciliación controlada de migraciones, sin volver a ejecutar DDL que ya exista.

En el ZIP de aquella revisión se documentó la presencia de `.git/` y cambios locales no comprometidos (24 archivos modificados y 41 nuevos respecto al único commit `5a071371cde5dcc22a5bbfa675f3c2e98ca54560` incluido). Esa observación describe ese archivo histórico, no el paquete actual. La distribución limpia debe generarse con `npm run package:zip`; para sincronizar GitHub se debe primero confirmar el snapshot fuente completo, revisar los cambios y secretos, y enviar un commit o pull request desde una copia Git coherente. Este paquete no se ha empujado a `main` y no se ha actualizado GitHub desde esta revisión.

El cifrado E2EE permanece **solo como propuesta** en `docs/E2EE_ARCHITECTURE.md`. No se han creado claves criptográficas, ciphertext ni migración del texto histórico. La aplicación continúa transmitiendo y almacenando el contenido conforme al modelo actual; no debe presentarse como E2EE ni utilizarse bajo esa expectativa de privacidad.


## Códigos de respaldo múltiples (21 de noviembre de 2026)

El paquete local incorpora `20261121200000_recovery_code_bundles.sql`. En la lectura remota más reciente se encontraron la tabla de recibos y los RPC asociados al conjunto de diez códigos, pero el timestamp no aparece en el ledger y no se ha verificado la equivalencia completa de todo el DDL. `auth-api` continúa desplegada en v11 y todavía no invoca el flujo local de registro/rotación con diez códigos. Se requiere comparación de definiciones y pruebas dinámicas antes de reconciliar el ledger o desplegar. Las cuentas existentes no se han modificado por esta revisión.

El plan de la organización observado durante esta revisión es Free. Supabase no incluye respaldos automáticos diarios en ese plan. El workflow local `backup-database.yml` prepara volcados lógicos `roles/schema/data`, cifrado `age` y carga a almacenamiento S3-compatible, pero no se ejecutará correctamente hasta configurar las credenciales del Environment `database-backups`. No se creó bucket, no se exportaron datos de producción y no se realizó restauración.


## Copias de seguridad y recuperación (21 de noviembre de 2026)

La organización Supabase conectada figura en el plan Free, que no incluye respaldos diarios administrados. El proyecto incorpora ahora un workflow diario que exporta roles, esquema y datos de `public`, cifra el paquete con `age` y lo envía a un bucket S3-compatible privado. El workflow no se encuentra operativo hasta que se creen/configuren el bucket, la identidad `age` y los secretos/variables de GitHub. No se ha generado una copia real ni se ha realizado una restauración. La herramienta de restauración rechaza explícitamente el ref de producción, exige un destino aislado vacío, verifica SHA-256, valida el manifiesto y compara seis recuentos de tablas. Los objetos de Storage API, variables de Edge Functions y el historial interno de migraciones no forman parte del dump lógico.

La migración local `20261121200000_recovery_code_bundles.sql` habilita diez códigos de recuperación independientes por cuenta y el RPC transaccional de registro que inserta sus hashes. El backend remoto `auth-api` v11 no se ha actualizado para invocar ese RPC. La activación requiere revisar la definición SQL ya presente, validar el estado en un proyecto aislado y desplegar `auth-api` compatible en el mismo release. No se ha consumido la invitación de producción ni se han modificado los usuarios existentes.


## Actualización local v21: accesibilidad, CI reproducible y cursor keyset (21 de noviembre de 2026)

La revisión parte de la misma referencia remota: 23 migraciones, `auth-api` v11 ACTIVE y `letters-api` v8 ACTIVE. En el corte v21 el ZIP local contenía 24 archivos SQL: 15 timestamps coincidían, tres eran legacy/no canónicos y seis candidatos no aparecían en el ledger. Esa cifra es histórica; el inventario v25 incorpora una séptima propuesta. La inspección más reciente encontró en el esquema el RPC `list_user_letters_cursor` y otros objetos de las seis migraciones, pero no se ha demostrado equivalencia completa de todo el SQL. Las Edge Functions todavía no invocan el conjunto local más reciente.

Las carpetas utilizan cursor keyset `(sort_at, id)` descendente y solicitan `limit + 1` filas para saber si existe otra página, en lugar de ejecutar `OFFSET` y `COUNT(*)` exacto por cada página. Hilos y notificaciones usan también cursor por fecha+UUID. El recuento exacto legado se conserva solamente para los agregados del dashboard. La búsqueda de título y contenido sigue siendo substring sobre HTML normalizado en la función; el cursor reduce el coste de paginar, pero no hace que la búsqueda sea automáticamente indexada. Antes de incorporar índices trigram o full-text se deben medir planes `EXPLAIN (ANALYZE, BUFFERS)` en un proyecto aislado y con volumen representativo.

El pie del editor se mantiene dentro de `.editor-shell`; sus reglas están aisladas en `assets/css/editor.css`, con columnas adaptativas y wrapping. Las reglas de foco visible residen en `assets/css/accessibility.css`. La auditoría estática calcula 24 combinaciones seleccionadas de contraste en ambos temas. En el corte v21, la suite Playwright `tests/e2e/accessibility.spec.mjs` ejecutaba axe-core para siete vistas y dos temas, además de comprobar la geometría del pie del editor en cinco anchos. El inventario v25 amplía la suite a nueve vistas e incluye errores, Papelera, recuperación, confirmación de cuenta, hover/disabled y reflow a 640/320 píxeles CSS. Las pruebas automáticas están incluidas en el workflow de Pages. En esta sesión no se ejecutó Playwright: Chromium está disponible en el entorno, pero `npm ci` no pudo completar la descarga de las dependencias fijadas (`playwright-core` no estaba en la caché y el registro npm agotó el tiempo); por tanto, no se instalaron Playwright/axe-core. Las pruebas manuales de NVDA, VoiceOver y TalkBack siguen pendientes.

La persistencia local del editor se movió de `DraftController` a `assets/js/services/draft-persistence-service.js`; el controlador conserva la coordinación de guardados, acciones y cola. `draft-controller.js` queda en 286 líneas y el servicio de persistencia en 109. El `AppController` de este snapshot tiene 863 líneas y todavía concentra listeners/dispatch compartidos; no se afirma que la modularización esté terminada.

El pipeline `pages.yml` usa `npm ci`, la auditoría de contraste y la suite Playwright/axe antes de subir un artefacto. `.nvmrc` fija Node 24.22.3; `package.json` y `package-lock.json` fijan npm 11.19.1, Playwright 1.65.1 y axe-core 4.14.1. Se añadió Dependabot para revisar semanalmente actualizaciones de npm y GitHub Actions. Los workflows de pgTAP, integración de dos cuentas y UI contra Supabase permanecen como ejecuciones manuales sobre secretos de entorno aislado; deben completarse antes de cualquier release que modifique SQL o funciones.

La exportación de esquema y el flujo de respaldo se actualizaron para CLI v3 y utilizan `supabase db dump --remote=<URL>`. No se generó un `remote-public.sql`, no se ejecutaron respaldos ni restauraciones reales, no se aplicó DDL y no se actualizaron funciones de producción.


## Actualización de reconciliación de solo lectura — 21 de noviembre de 2026 (v23)

Esta sección actualiza las afirmaciones históricas de este documento. Se inspeccionó el proyecto conectado `tiqbmuubpbmxqvtkcdhq` a las 20:09 UTC aproximadamente. La operación fue estrictamente de lectura: no se ejecutaron DDL, reparaciones de historial ni despliegues.

- PostgreSQL: `17.11.0.019`, proyecto `ACTIVE_HEALTHY`.
- Ledger remoto en la lectura v23: 23 migraciones. En ese corte el ZIP contenía 24 archivos SQL, de los cuales 15 timestamps coincidían; nueve eran locales sin entrada homónima y ocho entradas remotas no tenían archivo local homónimo. El inventario local v25 (22 de noviembre) contiene 25 archivos SQL: los mismos 15 timestamps comunes, tres ficheros legacy (`20261116000000`, `20261116001000`, `20261116002000`) y siete propuestas (`20261119064344`, `20261119090000`, `20261120173200`, `20261120235900`, `20261121200000`, `20261121210000`, `20261121220000`). La lectura remota del ledger no se ha repetido en esta actualización local.
- Edge Functions: `auth-api` v11 y `letters-api` v8 siguen activas. El código local posterior invoca `start_app_auth_attempt`, `register_app_user_with_invite_idempotent_bundle` y `rotate_app_recovery_codes_bundle`; `letters-api` local invoca `list_user_letters_cursor` y `rename_app_profile`. Las funciones remotas desplegadas aún no incorporan todos esos handlers/RPC calls.
- Esquema remoto: se encontraron las RPC anteriores, los recibos de paquete de recuperación, `list_user_letters_cursor`, `rename_app_profile`, índices de paginación y triggers relevantes. Sus firmas y grants se inspeccionaron; las funciones consultadas tienen propietario `postgres`, `SECURITY DEFINER=false`, `EXECUTE` denegado a `anon`/`authenticated` y concedido a `service_role`. Esto no equivale a confirmar equivalencia íntegra de cada migración local.
- Acceso a tablas: las 21 tablas públicas observadas tienen RLS activado y no conceden `SELECT`/`INSERT` directo a `anon` ni `authenticated`. El advisor `rls_enabled_no_policy` devuelve 21 avisos informativos; no crear políticas genéricas para silenciarlos porque el acceso directo está revocado en este modelo custom-auth. Revisar cada grant al modificar el modelo.
- Organización: plan Free; no se encontraron ramas Supabase. No hay un entorno de rama disponible para probar cambios sin configurar otra instancia/proyecto.

**Conclusión del estado remoto v23:** existe deriva entre ledger, código local y Edge Functions, pero varios objetos de las seis propuestas conocidas en esa lectura ya estaban en el esquema. No aplicar los siete archivos del inventario v25 sin diff; tampoco ejecutar `migration repair` solo por timestamps. Primero obtener respaldo restaurable, generar `npm run supabase:reconcile:readonly`, comparar definiciones completas y ejecutar pruebas de integración en un destino aislado.

El script `supabase/diagnostics/reconciliation-readonly.sql` consulta solo metadatos. `scripts/release/reconcile-readonly.sh` valida el ref de conexión, fuerza `default_transaction_read_only`, ejecuta la consulta y presenta diferencias de timestamp y privilegios sin cambiar el servidor.

## Corrección del inventario local v25 — 22 de noviembre de 2026

El paquete v25 contiene 25 archivos SQL: 15 timestamps comunes con las 23 entradas remotas observadas el 21 de noviembre, tres archivos legacy/no canónicos y siete propuestas locales sin entrada de ledger (`20261119064344`, `20261119090000`, `20261120173200`, `20261120235900`, `20261121200000`, `20261121210000` y `20261121220000`). Ocho timestamps remotos siguen sin homónimo local. Esta es una actualización del inventario local; no se volvió a consultar ni modificar la base de datos remota. Las menciones previas a cinco propuestas (corte v20) y seis (cortes posteriores previos a la propuesta `20261121220000`) son históricas, no recuentos vigentes.

El ZIP v25 que se revisó para esta entrega contiene 156 entradas y no incluye `.git/` ni archivos de metadatos Git. `scripts/package-zip.mjs` se reforzó para excluir `.git` tanto como directorio como archivo marcador de worktree, y una prueba de distribución genera un ZIP de prueba con ambos escenarios y comprueba que `.github/` y `.gitignore` se conservan.
