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
- Registro por nombre de usuario/contraseña; máximo de dos cuentas.
- Las cuentas se crean activas sin email, verificación por correo ni proveedor transaccional.
- PBKDF2-HMAC-SHA256 mediante Web Crypto, 600.000 iteraciones y sal aleatoria individual.
- Token de acceso aleatorio de 32 bytes, 15 minutos de vida; solo su hash queda persistido.
- Refresh tokens aleatorios y hasheados en PostgreSQL, rotación y detección de reutilización.
- Sesiones con expiración por inactividad (7 días), expiración absoluta (30 días), cierre y revocación.
- Intentos de login/registro/recuperación limitados por hash de identificador y ventanas controladas en PostgreSQL.
- Un código de recuperación de un solo uso por cuenta, guardado como hash y mostrado únicamente durante el registro.
- RLS activo y tablas privadas no accesibles directamente desde roles públicos; las operaciones de datos pasan por Edge Functions.
- CORS abierto para el origen, sin cookies ni credenciales de navegador. CORS no sustituye autenticación.
- Los borradores nuevos usan un hilo provisional privado sin destinatario; al enviar, el backend vincula la otra cuenta activa. Los borradores no se comparten con la segunda cuenta hasta el envío.
- Preferencias de apariencia limitadas a `light`, `dark` y `system`; el tema se valida en backend y se persiste por cuenta.
- Sanitización HTML del contenido de cartas mediante lista permitida en navegador y servidor.
- Respuestas API con `no-store`, `nosniff` y `no-referrer`.

## Limitaciones explícitas

- El registro público está disponible hasta completar las dos cuentas. Sin un código inicial o invitación, una persona que encuentre la URL podría ocupar una de las dos plazas. Comparte la URL solo con las personas previstas durante la creación de cuentas.
- No hay recuperación por email. Si se pierde el código de recuperación, no existe restablecimiento automático.
- No hay correo transaccional, CAPTCHA, segundo factor, notificaciones push ni cifrado de extremo a extremo.
- `sessionStorage` mantiene el refresh token en el origen de la aplicación. Un XSS persistente podría comprometer la sesión; por eso se mantiene la CSP y la sanitización.
- La credencial privada inyectada por Supabase permite acceso de servicio; una vulnerabilidad de autorización en una Edge Function sería crítica.
- PBKDF2 es una alternativa compatible con Web Crypto, no Argon2id.
- No se han ejecutado pruebas de penetración ni una auditoría dinámica IDOR/XSS completa.

## Operación

- No crees ni pegues secretos de aplicación en el repositorio, frontend, SQL Editor ni GitHub Pages.
- No consultes ni copies la clave `SUPABASE_SECRET_KEYS`; Supabase la inyecta automáticamente en el runtime.
- Guarda el código de recuperación fuera del sitio web y no lo compartas con terceros.
- Revoca sesiones que no reconozcas y conserva respaldos de base de datos.
- Ante una sospecha de compromiso, revoca las sesiones activas desde la base de datos y cambia las contraseñas afectadas.
