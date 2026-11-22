# Notificaciones externas y Web Push

## Estado de implementación en esta versión

**Implementación preparada en el código; todavía no activada en Supabase.** La interfaz permite solicitar consentimiento desde Configuración, hay un service worker con alcance relativo al subdirectorio de GitHub Pages y el backend tiene rutas para registrar/revocar suscripciones y enviar avisos genéricos. Para activarlo en un entorno se requiere aplicar `20261121220000_authenticated_api_rate_limits_and_web_push.sql`, desplegar `letters-api` y configurar secretos VAPID. No se han enviado avisos reales desde esta sesión.

## Flujo

1. La persona pulsa **Activar avisos externos** en Configuración. No se solicita permiso al cargar la página.
2. El service worker se registra con alcance `./`, compatible con un repositorio desplegado bajo `/nombre-del-repo/` en GitHub Pages.
3. El navegador crea una suscripción con la clave VAPID pública obtenida de `letters-api`.
4. La Edge Function valida la sesión opaca propia, comprueba el endpoint HTTPS contra la lista de proveedores admitidos y guarda endpoint/keys asociados a `user_id` y `session_id`.
5. Al enviar una carta o crear una respuesta, `letters-api` busca la notificación persistida y programa el envío genérico en una tarea de fondo (`EdgeRuntime.waitUntil`) para no retrasar la respuesta HTTP. Solo se consideran dispositivos con sesión vigente. El contenido de la carta nunca entra en el payload push.
6. Un recibo único por `notification_id` + `subscription_id` evita duplicados. Las entregas fallidas pueden reintentarse tras una ventana de cinco minutos cuando se repite la operación; 404/410 elimina la suscripción caducada.
7. Al cerrar sesión, revocar dispositivo, cambiar contraseña o eliminar cuenta, el backend elimina las suscripciones asociadas a las sesiones que pierden acceso.

## Secretos VAPID

Genera un par VAPID en un equipo de confianza con `web-push@4.0.0` o una herramienta compatible. Configura estas variables como **secrets de la Edge Function** en el proyecto/branch que se esté probando:

- `VAPID_PUBLIC_KEY`: clave pública para que el navegador cree la suscripción.
- `VAPID_PRIVATE_KEY`: clave privada para firmar solicitudes de envío. Nunca debe estar en el frontend, en Git ni en el ZIP.
- `VAPID_SUBJECT`: identificador de contacto `mailto:` o una URL HTTPS.

En `letters-api` la librería `web-push@4.0.0` envía el mensaje cifrado por Web Push. El navegador recibe únicamente el texto genérico “Tienes una nueva carta / Abre Nuestro Rincón para leerla”. No se debe añadir el título, remitente, cuerpo, HTML, `thread_id` ni `letter_id` al payload.

## Límites y operación

- Push es best effort: el navegador, el SO o el proveedor pueden retrasar o descartar el aviso. No sustituye la bandeja de notificaciones.
- Safari/iOS puede exigir que la web esté instalada y que se otorgue permiso; la compatibilidad depende de la versión del sistema. Probar en cada plataforma antes de activar.
- El servicio limita a 20 suscripciones por destinatario por despacho. Revisar entregas fallidas sin registrar endpoints ni claves.
- No habilitar hasta que la migración, `letters-api` y secretos VAPID estén sincronizados en un entorno aislado.
- La configuración VAPID ausente mantiene Push deshabilitado y no rompe las notificaciones dentro de la web.

## Realtime dentro de la página

La notificación dentro de una pestaña sigue usando `AdaptivePoller` (30 s activo, 2 min en reposo). No se activa Supabase Realtime porque las sesiones actuales son tokens opacos, no JWT verificables por `realtime.messages`. No se crea ningún canal público como alternativa. Lee [`REALTIME_AUTH_BRIDGE.md`](REALTIME_AUTH_BRIDGE.md) para el puente OIDC/JWKS asimétrico requerido para Realtime privado.

## Criterios pendientes antes de activar

- Aplicar y revisar la migración en una branch aislada.
- Desplegar `auth-api` y `letters-api` desde el mismo release probado.
- Configurar y rotar VAPID como secretos de Edge Functions.
- Verificar el flujo extremo a extremo en Android/Chrome, iOS/Safari instalado y navegadores de escritorio.
- Confirmar que logout/revocación elimina la suscripción y que cuenta A nunca recibe notificaciones de B.
- Observar tasas 201/404/410/429 sin registrar datos privados.
