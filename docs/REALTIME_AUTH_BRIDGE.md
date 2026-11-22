# Realtime privado con autenticación propia

## Estado actual

La aplicación sigue usando sondeo adaptativo de notificaciones: 30 segundos mientras el usuario está activo y 2 minutos en reposo. **No hay una suscripción WebSocket Realtime activa.** No se abre un canal público como atajo.

Nuestro Rincón emite tokens opacos propios y no utiliza Supabase Auth. Las políticas de canales privados de Supabase Realtime se evalúan usando la identidad/JWT que presenta el cliente. Un token opaco de la aplicación no es un JWT reconocido por Realtime; por tanto, crear un canal privado con una cadena de tema `user:<uuid>` sin un puente de identidad no aporta autorización real. Un canal público filtraría potencialmente eventos privados.

## Requisito para habilitarlo

La vía soportada es integrar un proveedor JWT externo asimétrico mediante la función Third-Party Auth de Supabase (OIDC/JWKS), sin convertir la aplicación a Supabase Auth. La integración requiere:

1. Una clave de firma asimétrica privada almacenada exclusivamente como secreto de Edge Functions y un JWKS público con su clave pública.
2. Un emisor HTTPS y un documento OIDC de descubrimiento, con `jwks_uri` estable y `kid` en la cabecera JWT.
3. Una operación de la `auth-api` que emita un JWT corto para la sesión opaca actual, con `sub` igual al UUID verificado de `app_users`, `role: authenticated`, `iss`, `aud`, `iat` y `exp`. El servidor debe validar primero la sesión/revocación actual.
4. Configurar ese emisor como proveedor Third-Party Auth en el Dashboard de Supabase.
5. En el cliente, proporcionar el JWT corto a Realtime y conectar únicamente a canales privados.
6. Políticas `realtime.messages` de SELECT/INSERT que restrinjan el tema al UUID autenticado; por ejemplo, el patrón `user:<sub>:notifications`. No se debe conceder `USING (true)` ni habilitar acceso público.
7. Invalidar/renovar el token al renovar o revocar la sesión de la aplicación y probar que la conexión de una cuenta no puede unirse al tema de la otra.

Supabase documenta que la autorización privada utiliza RLS sobre `realtime.messages`, el tema y los claims de identidad; también recomienda Broadcast privado sobre Postgres Changes para casos escalables. La integración OIDC externa requiere JWT asimétrico con `kid`; no se puede reutilizar un token opaco como JWT.

Referencias oficiales:

- [Realtime Authorization](https://supabase.com/docs/guides/realtime/authorization)
- [Broadcast vs. Postgres Changes](https://supabase.com/docs/guides/realtime/subscribing-to-database-changes)
- [Custom OIDC provider / Third-Party Auth](https://supabase.com/docs/guides/auth/third-party/custom-oidc)

## Seguridad de los eventos

Cuando se habilite, el evento debe transportar solo un aviso genérico o un identificador de notificación ya autorizado; nunca el título, cuerpo, HTML o fragmentos de una carta. La aplicación consultará la bandeja mediante `letters-api` después de validar su sesión propia. La caída de WebSocket debe regresar al sondeo adaptativo, nunca abrir un canal público de respaldo.
