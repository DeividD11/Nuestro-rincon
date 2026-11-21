# Hoja de ruta: notificaciones externas

## Estado

**Pospuesto; no implementado en esta versión.** La aplicación mantiene únicamente sus avisos y notificaciones dentro de la web y sus comprobaciones periódicas mientras está abierta.

## Objetivo futuro

Permitir que una persona reciba una notificación del sistema operativo cuando llegue una carta o una respuesta, incluso si la pestaña no está abierta. La entrega dependerá de que el navegador, el dispositivo y el sistema operativo admitan Web Push y de que la persona haya concedido permiso.

## Diseño propuesto

1. **Consentimiento explícito.** Solicitar permiso únicamente después de que la persona active la opción de notificaciones externas en Configuración. No mostrar el diálogo de permiso al cargar la página.
2. **Service Worker.** Registrar un service worker con alcance correcto bajo el subdirectorio de GitHub Pages y probar instalación, actualización y cierre de sesión.
3. **Suscripciones Web Push.** Crear y revocar suscripciones desde una Edge Function autenticada. Asociar cada suscripción a la cuenta propietaria y almacenar solo los datos necesarios para poder enviar y revocar.
4. **Claves VAPID.** Generar y custodiar la clave privada exclusivamente en el backend. La clave pública puede distribuirse al navegador para crear la suscripción; ningún secreto privado debe aparecer en los assets ni en el repositorio.
5. **Eventos permitidos.** Enviar avisos únicamente para eventos autorizados por las preferencias: nueva carta o respuesta. No enviar contenido, título de la carta, remitente ni fragmentos privados en el payload; usar un texto genérico y recuperar detalles después de abrir la sesión.
6. **Revocación.** Desactivar suscripciones al cerrar sesión cuando corresponda, al revocar un dispositivo, al eliminar una cuenta o cuando el proveedor informe que una suscripción dejó de existir.
7. **Protección frente a duplicados.** Añadir idempotencia por evento, control de reintentos, caducidad y métricas de entrega. La notificación push es de mejor esfuerzo y no puede considerarse un canal garantizado.
8. **Pruebas multiplataforma.** Probar Safari/iOS, Chrome/Android, Chrome/Edge/Firefox de escritorio y las restricciones de instalación/permiso de cada plataforma antes de activar el envío general.

## Compatibilidad con la autenticación actual

Nuestro Rincón usa sesiones propias opacas y no Supabase Auth. La futura integración debe validar la sesión propia en la Edge Function que registra, consulta o revoca una suscripción. No debe confiar en un `user_id` enviado por el navegador ni usar la clave `service_role` en el cliente.

## Criterios para considerarlo listo

- El consentimiento puede activarse y revocarse desde la configuración.
- No se filtra contenido de cartas en payloads, logs ni pantallas bloqueadas.
- Un dispositivo no recibe avisos de otra cuenta después de cerrar sesión o revocar su sesión.
- Los eventos duplicados no generan avisos repetidos.
- La experiencia dentro de la web continúa funcionando aunque Web Push no esté disponible o se deniegue el permiso.
- El README documenta que la entrega externa depende de permisos, conectividad y soporte del navegador; no promete recepción garantizada.
