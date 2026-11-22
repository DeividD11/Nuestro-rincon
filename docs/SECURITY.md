# Modelo de seguridad de Nuestro Rincón

## Límites de confianza

1. El frontend es público y modificable por cualquier visitante. Ningún UUID o nombre de usuario enviado por el navegador prueba identidad.
2. `sb_publishable_...` es la clave pública Supabase del frontend; su presencia en JavaScript es intencional.
3. Las Edge Functions reciben automáticamente la credencial privada del proyecto mediante `SUPABASE_SECRET_KEYS`. Esta credencial omite RLS, no se configura manualmente para esta app y nunca puede incluirse en `assets/`, GitHub Pages, HTML, JavaScript, CSS o logs.
4. El backend crea tokens aleatorios de acceso y almacena sus hashes SHA-256 en `user_sessions`. No firma JWT propios y no necesita `APP_JWT_SECRET`.
5. `letters-api` consulta el hash del token, su expiración, la expiración de sesión, el estado de revocación y la cuenta asociada antes de cada operación. El actor se obtiene de esa fila de sesión.
6. Los RPC de dominio siguen verificando las reglas de negocio y los Edge Functions comprueban la pertenencia a cartas/hilos antes de las operaciones.

## Controles implementados

- No se utiliza Supabase Auth ni `auth.users` como identidad de la aplicación.
- Registro por nombre de usuario/contraseña con invitación privada obligatoria; máximo de dos cuentas activas.
- Códigos de invitación aleatorios de 256 bits, prefijo/versionado `NR1`, caducidad de siete días y un solo uso. Solo su hash SHA-256 con separación de dominio se almacena en PostgreSQL.
- El consumo de la invitación y la creación de `app_users`, perfil, preferencias, hashes del conjunto de recuperación y recibos idempotentes suceden dentro de una única función/transacción PostgreSQL. Una excepción revierte todo el conjunto. Los reintentos posteriores verifican la misma contraseña, invitación, usuario, clave de petición y código; pasan también por el limitador de intentos y no crean otra cuenta ni consumen otra invitación.
- La primera cuenta activa puede crear o revocar la única invitación pendiente desde Configuración. En una base vacía, el primer código se genera desde SQL Editor mediante una función restringida al rol `postgres`.
- Las cuentas se crean activas sin email, verificación por correo ni proveedor transaccional.
- PBKDF2-HMAC-SHA256 mediante Web Crypto, 600.000 iteraciones y sal aleatoria individual.
- Token de acceso aleatorio de 32 bytes, 15 minutos de vida; solo su hash queda persistido.
- Refresh tokens aleatorios y hasheados en PostgreSQL, rotación y detección de reutilización.
- Sesiones con expiración por inactividad (7 días), expiración absoluta (30 días), cierre y revocación.
- El diseño pendiente `20261119064344_auth_attempt_rate_limits.sql` amplía la limitación de intentos a cuenta+IP (5 intentos fallidos en 15 minutos antes de iniciar enfriamiento progresivo) y a IP (25 fallos en 15 minutos). Los hashes de identificador e IP se calculan con HMAC y no se guarda el texto del nombre de usuario ni la dirección IP. Los intentos distribuidos contra una misma cuenta se auditan con deduplicación temporal. Desde el décimo fallo distribuido, se añade fricción progresiva únicamente a las respuestas fallidas (100 ms hasta un máximo de 1,6 s); una contraseña o código correcto no se ralentiza ni se bloquea. Así se eleva el coste de probar credenciales desde distintas IP sin permitir que un tercero provoque un bloqueo de cuenta. El enfriamiento progresivo se aplica solo a la combinación cuenta+IP y al volumen de una IP. La migración aún no está aplicada ni la nueva Edge Function desplegada en producción; primero deben validarse juntas en una rama aislada. Los intentos de invitación conservan su límite independiente de 10 por IP anonimizada y 5 por huella de código en 15 minutos.
- El navegador genera diez códigos de respaldo antes del registro y los conserva temporalmente en `localStorage` hasta que la persona confirma que los guardó; la contraseña nunca se almacena allí. PostgreSQL solo conserva los hashes de los diez códigos y huellas de idempotencia del conjunto. La creación de cuenta, códigos y recibos sucede en una sola transacción. Si la respuesta HTTP se pierde después del `COMMIT`, el mismo intento puede reanudarse tras volver a verificar la contraseña y la huella completa del conjunto. Mientras el resultado sea incierto, la interfaz conserva los códigos, pero los presenta como pendientes y no afirma que estén activos.
- El código de recuperación puede regenerarse desde Configuración tras confirmar la contraseña actual y una sesión válida. La rotación invalida los códigos anteriores y guarda el nuevo hash en una transacción idempotente.
- RLS activo y tablas privadas no accesibles directamente desde roles públicos; las operaciones de datos pasan por Edge Functions.
- CORS abierto para el origen, sin cookies ni credenciales de navegador. CORS no sustituye autenticación.
- Los borradores nuevos usan un hilo provisional privado sin destinatario; al enviar, el backend vincula la otra cuenta activa. Los borradores no se comparten con la segunda cuenta hasta el envío.
- Preferencias de apariencia limitadas a `light`, `dark` y `system`; el tema se valida en backend y se persiste por cuenta.
- Sanitización HTML del contenido de cartas mediante lista permitida en navegador y servidor.
- Respuestas API con `no-store`, `nosniff` y `no-referrer`.

## Limitaciones explícitas

- La primera cuenta ya existente se considera autorizada y no necesita invitación para iniciar sesión. Los registros nuevos exigen un código válido. La invitación solo puede generarse por la primera cuenta activa cuando hay exactamente una cuenta ocupada; no se permite un alta pública sin código.
- En una instalación completamente vacía, un operador con rol `postgres` debe generar la primera invitación desde Supabase SQL Editor. La función `bootstrap_app_registration_invite()` devuelve el código una sola vez y se niega a ejecutarse si ya existe una cuenta activa o pendiente.
- La tabla `registration_invites` no guarda el código en claro. Si se pierde antes de utilizarse, revoca la invitación pendiente desde Configuración y genera otra. Si la persona ya lo utilizó, la invitación queda consumida y no puede reutilizarse. La invitación autoriza un registro; no sustituye al código de recuperación de una cuenta ya creada.
- No hay recuperación por email. Si se pierde los códigos de recuperación y no existe una sesión activa desde la que regenerarlo, no hay un restablecimiento automático; por eso debe guardarse fuera del navegador.
- No hay correo transaccional, CAPTCHA, segundo factor ni cifrado de extremo a extremo. Web Push está preparado en el código, pero permanece desactivado hasta desplegar la migración/Edge Function y configurar VAPID. Realtime privado permanece pendiente del puente OIDC/JWKS.
- `sessionStorage` mantiene el refresh token y, durante una operación de registro/rotación, `localStorage` conserva los códigos de recuperación en claro junto con la clave idempotente y los datos mínimos para reintentar (nunca la contraseña). Un XSS persistente podría leer ambos; por eso se mantiene la CSP y la sanitización, y el handoff elimina el código al confirmarlo. El dato también se pierde si la persona borra el almacenamiento del sitio o cambia de navegador/dispositivo antes de guardarlo externamente.
- La pantalla de entrega del código se restaura antes de cualquier comprobación remota de sesión. Mientras exista un código pendiente, se pausan la consulta de notificaciones, la sincronización de borradores y los eventos de ciclo de vida que pudieran reemplazar el contenido. Si otra pestaña revoca la sesión durante la entrega, el código permanece visible y, al confirmar que fue guardado, la aplicación pide iniciar sesión de nuevo en vez de reutilizar esa sesión.
- La credencial privada inyectada por Supabase permite acceso de servicio; una vulnerabilidad de autorización en una Edge Function sería crítica.
- PBKDF2 es una alternativa compatible con Web Crypto, no Argon2id.
- La suite dinámica ampliada de dos cuentas, pgTAP y Playwright debe ejecutarse contra un Supabase aislado; no se han ejecutado en producción ni en esta revisión, y el entorno local no dispone de Deno/psql ni credenciales de branch. El paquete incluye los escenarios y la configuración para realizarlas. No se han ejecutado pruebas de penetración ni una auditoría dinámica XSS completa.

## Operación

- No crees ni pegues secretos de aplicación en el repositorio, frontend ni GitHub Pages. El código de invitación sí se genera desde backend; solo el procedimiento de bootstrap administrativo se ejecuta en SQL Editor y su resultado debe compartirse por un canal privado.
- No consultes ni copies la clave `SUPABASE_SECRET_KEYS`; Supabase la inyecta automáticamente en el runtime.
- Guarda los códigos de recuperación fuera del sitio web y no lo compartas con terceros.
- Revoca sesiones que no reconozcas y conserva respaldos de base de datos.
- Ante una sospecha de compromiso, revoca las sesiones activas desde la base de datos y cambia las contraseñas afectadas.


Consulta [`INVITATIONS.md`](INVITATIONS.md) para el procedimiento operativo de creación, entrega, revocación y bootstrap de invitaciones.


## Privacidad entre sesiones y consistencia de cartas

La caché de rutas privadas está segmentada por ID de cuenta. Al cambiar de identidad se invalidan precargas y datos de pantalla, se cierra el editor previo y se reinicia la identidad de los borradores locales. La interfaz y `letters-api` deduplican cartas por UUID antes de renderizar listas, inicio y conversaciones.

La organización (favorito, archivo y papelera) es por participante; una carta puede figurar intencionalmente en Favoritos y en la bandeja principal si solo está marcada como favorita. Archivar la oculta de la bandeja principal de esa persona, y moverla a Papelera la oculta de las demás carpetas de esa persona. La purga del contenido de una carta enviada requiere confirmación de ambos participantes. Consulta [`LETTERS_CONSISTENCY.md`](LETTERS_CONSISTENCY.md) para los estados exactos y el procedimiento de pruebas.


## Solicitudes HTTP y cuotas

Las Edge Functions aceptan únicamente `application/json`/`application/*+json`, leen el stream de forma incremental y cancelan al superar 150 KB incluso si el cliente omite `Content-Length`. JSON inválido devuelve 400, media type no permitido 415 y exceso de tamaño 413. Las operaciones a PostgREST tienen un límite de 12 segundos y devuelven 504 al agotar el tiempo. `letters-api` consume cuotas por usuario/sesión desde PostgreSQL (no desde memoria efímera de una instancia Edge).

## Notificaciones externas

Las suscripciones Web Push quedan asociadas a la sesión autenticada. El cliente solo recibe la clave VAPID pública; la privada se mantiene en secrets del runtime. Los payloads son genéricos y no incluyen datos de cartas. Las rutas de suscripción validan host HTTPS/proveedor y la revocación de sesión elimina las suscripciones correspondientes.
