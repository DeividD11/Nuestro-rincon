# Recuperación y protección de cuentas

## Códigos de respaldo

El registro de producción utiliza un **código individual aleatorio de un solo uso**. Se genera con 24 bytes de `crypto.getRandomValues` (192 bits) y se muestra una sola vez. Esta elección mantiene compatibilidad con `auth-api` v11, que es la versión remota observada y espera el campo `recoveryCode` en singular. El frontend no envía `recoveryCodes` durante el alta hasta que se publique la versión del backend que admite el paquete completo.

- PostgreSQL conserva únicamente SHA-256 del código, nunca el valor en claro.
- El código se muestra una sola vez y el intento de registro utiliza una clave idempotente.
- El código recupera la contraseña una sola vez; al utilizarlo, se revocan las sesiones y los refresh tokens existentes.
- El backend local contiene además una implementación de paquetes de diez códigos, pero no se activa desde el registro público mientras la Edge Function remota siga en v11.

La aplicación conserva temporalmente el código y el identificador idempotente en `localStorage` hasta que la persona confirma que lo guardó. Esto permite recuperarlo si se pierde la respuesta o se cierra accidentalmente la pestaña, pero un XSS ejecutado con el mismo origen podría leerlo. La contraseña nunca se almacena. La pantalla desaparece y el elemento se elimina cuando la persona confirma que guardó la copia externa. No es un sustituto del E2EE ni de una clave hardware.

## Copia local protegida

La pantalla de entrega permite descargar un archivo JSON cifrado en el propio navegador:

- Derivación de clave: PBKDF2-HMAC-SHA-256, 600.000 iteraciones y sal aleatoria de 16 bytes.
- Cifrado autenticado: AES-256-GCM con IV aleatorio de 12 bytes.
- La frase secreta debe tener al menos 14 caracteres y se solicita dos veces.
- La frase no se transmite a Supabase ni se almacena en el archivo; solo el sobre cifrado se descarga.
- El archivo se puede importar desde la pantalla de recuperación para seleccionar uno de los códigos.

**La frase secreta es imprescindible.** Si se pierde, no existe forma de descifrar el archivo. Guárdala separada del archivo; evita subir ambos al mismo almacenamiento. No guardes el archivo o la frase en el repositorio ni en GitHub Actions artifacts.

## Compatibilidad

- Los códigos individuales de versiones anteriores siguen siendo válidos hasta que se use uno o la cuenta genere el conjunto nuevo.
- Una rotación individual pendiente de una versión anterior se conserva y se puede terminar sin reemplazarla por un conjunto nuevo.
- Los códigos de respaldo recuperan la contraseña de la cuenta. **No recuperan las claves privadas de E2EE**, que aún no está implementado. Cuando se integre E2EE, se diseñará una ceremonia de recuperación distinta y coordinada para las claves criptográficas.

## Passkeys y MFA futuro

WebAuthn/passkeys no está implementado. Los códigos de respaldo son un mecanismo de recuperación de contraseña de un solo uso, no un segundo factor de autenticación para el inicio de sesión. Antes de incorporarlo se debe definir el RP ID estable (`deividd11.github.io` o un dominio propio), el challenge del servidor, la verificación criptográfica y la gestión de credenciales. El proyecto utiliza autenticación propia y no Supabase Auth; por tanto, no se debe copiar directamente `supabase.auth.signInWithPasskey()`.

La política futura debe permitir registrar más de un autenticador, ofrecer códigos de recuperación de un solo uso, notificar eventos de recuperación, revocar sesiones existentes y proteger la recuperación para que no sea más débil que el inicio de sesión. Consulta la guía de OWASP Passkey Security.

## Estado de despliegue

La migración `20261121200000_recovery_code_bundles.sql` y la versión local de `auth-api` que añade `register_app_user_with_invite_idempotent_bundle` y `recovery-codes:rotate` son cambios pendientes de publicación coordinada. El backend remoto observado sigue en `auth-api` v11; por eso el frontend de esta entrega envía `recoveryCode` (singular) durante el registro. No despliegues la Edge Function ni apliques la migración en producción sin reconciliar primero el esquema, probar ambos componentes en un entorno aislado y completar el runbook.
