# Invitaciones privadas de registro

Este proyecto admite dos cuentas activas. Todo registro nuevo necesita un código de invitación de un solo uso. La URL pública de GitHub Pages, por sí sola, no permite ocupar una plaza.

## Cómo invitar a la segunda persona

En el proyecto existente hay una cuenta activa, que se conserva como cuenta inicial autorizada. Para crear la invitación: 

1. Inicia sesión con la cuenta existente.
2. Abre **Configuración → Invitación privada**.
3. Pulsa **Generar invitación privada**.
4. Copia el código que se muestra. Es la única respuesta que contiene el código en claro.
5. Compártelo directamente con la segunda persona por un canal privado.
6. La segunda persona abre la aplicación, selecciona **Crear cuenta**, introduce el código y completa sus datos.

El código contiene 32 bytes generados con un generador criptográfico seguro (256 bits), comienza por `NR1-`, vence a los siete días y se consume una sola vez. La operación final valida y consume la invitación en la misma transacción que crea la cuenta, el perfil, las preferencias, el hash del código de recuperación y un recibo idempotente. Si falla una de esas inserciones, la invitación no queda consumida.

## Si el código se pierde

El backend no conserva el código original, sino únicamente su hash. Por ello no existe una función para volver a mostrarlo. En **Configuración → Invitación privada**, revoca la invitación pendiente y genera otra. Revocar un código lo invalida inmediatamente.

Si el código ya se utilizó, no puede volver a emplearse. Una invitación consumida queda marcada como tal incluso si después se elimina la cuenta registrada.


## Entrega recuperable del código de recuperación

El navegador genera el código de recuperación antes de enviar el registro. Antes de iniciar la petición, conserva temporalmente en `localStorage` el código, una clave de idempotencia aleatoria y los datos no secretos necesarios para reintentar (invitación, nombre visible y usuario). **Nunca guarda la contraseña.** El código permanece en el almacenamiento local de ese navegador hasta que la persona pulsa **Ya lo guardé**; por eso puede recuperarse tras recargar o cerrar y volver a abrir el navegador. El registro y la rotación no guardan contraseñas en ese almacenamiento. Como cualquier dato del navegador, el código puede perderse si se borra el almacenamiento del sitio o se usa otro navegador/dispositivo.

El servidor recibe el código por HTTPS, calcula su hash y PostgreSQL conserva solo el hash. La operación también guarda un recibo con la huella de la petición, la invitación, el usuario y el hash del código. Si el navegador pierde la respuesta después del `COMMIT`, el siguiente intento con la misma clave, el mismo código, la misma invitación, el mismo usuario y la contraseña original recupera la cuenta creada y permite abrir una sesión sin consumir otra invitación ni crear una segunda cuenta.

Si la creación de sesión falla después de crear la cuenta, la API devuelve un resultado separado: `accountCreated: true` y `authenticated: false`. El navegador muestra el código que ya conservaba y permite reintentar el mismo intento o ir al inicio de sesión. Una petición de reintento vuelve a verificar la contraseña y pasa por el mismo límite de intentos de la invitación, incluso cuando el servidor ya encuentra un recibo idempotente. Si el navegador se cierra antes de guardar el código, `localStorage` permite recuperar el código después de cerrar la pestaña o el navegador, pero puede perderse si se borra el almacenamiento del sitio o se cambia de dispositivo; por eso debe copiarse o guardarse fuera del dispositivo antes de continuar.

## Regenerar un código de recuperación

Una persona que ya inició sesión puede reemplazar su código desde **Configuración → Código de recuperación**. Debe confirmar su contraseña actual. El backend valida además la sesión activa y realiza en una transacción:

1. Invalidar todos los códigos de recuperación anteriores.
2. Guardar únicamente el hash del código nuevo.
3. Actualizar el recibo del registro para que no se pueda recuperar como válido el código anterior.
4. Registrar el evento de auditoría.

La renovación también utiliza una clave idempotente y un código generado en el navegador, conservado temporalmente en `localStorage`. Si se pierde la respuesta, repetir la misma operación devuelve el mismo resultado, no genera un código distinto y no invalida dos veces. Una operación posterior de renovación deja sin efecto el código anterior.

## Límites de intentos y auditoría

Los intentos válidos de formato se registran con el hash del código y una huella HMAC de la IP obtenida del proxy de Supabase. No se guarda la IP en claro ni se registra el código original.

- Máximo de 10 intentos por huella de IP en una ventana de 15 minutos.
- Máximo de 5 intentos por huella de código en una ventana de 15 minutos.
- Los intentos inválidos, aceptados, reanudados y bloqueados producen eventos de auditoría sin incluir el código. El lookup idempotente se ejecuta después del rate limit para impedir ensayos de contraseña ilimitados.
- Los rechazos devuelven un mensaje genérico para no revelar si un código fue inexistente, caducó, se revocó o ya se consumió.

## Primera invitación en una instalación Supabase vacía

Este paso solo corresponde a una base de datos nueva que todavía no tiene ninguna cuenta activa ni pendiente. **No lo ejecutes en el proyecto existente**, donde la primera cuenta ya está registrada.

Un operador con acceso de administrador abre **Supabase → SQL Editor** y ejecuta:

```sql
select public.bootstrap_app_registration_invite();
```

La función solo permite `current_user = 'postgres'`, usa `extensions.gen_random_bytes(32)`, y solo funciona mientras no exista ninguna cuenta activa o pendiente y crea una invitación con validez de siete días. El resultado contiene el código en claro una única vez. Compártelo en privado y no lo pegues en GitHub, incidencias, capturas públicas, logs ni documentación del repositorio.

Después de que la primera persona cree su cuenta, las siguientes invitaciones se gestionan desde Configuración.

## Detalles de implementación

- El código consta de 32 bytes generados con `crypto.getRandomValues` en Edge Functions (o `extensions.gen_random_bytes(32)` durante el bootstrap SQL) y se representa como `NR1-` seguido de ocho grupos hexadecimales.
- El hash se calcula como SHA-256 de `registration-invite:v1:` más el código hexadecimal normalizado. El prefijo separa este uso de otros hashes del sistema.
- `registration_invites` solo almacena `token_hash`, emisor, fechas de ciclo de vida y usuario que lo consumió. RLS está habilitado y los permisos de tabla se reservan a `service_role`.
- `register_app_user_with_invite_idempotent` vuelve a comprobar la vigencia bajo bloqueo transaccional, usa `SELECT ... FOR UPDATE` y registra una clave de idempotencia antes de consumir el código. El RPC anterior queda revocado.
- Las antiguas RPC de registro público y de invitación por correo quedan sin permiso de ejecución para `service_role`, de modo que no existe un camino alternativo para omitir la invitación.
- `bootstrap_app_registration_invite()` está revocada para `public`, `anon`, `authenticated` y `service_role`; solo el rol `postgres` puede ejecutarla.

La aplicación no usa Supabase Auth. El código de invitación solo autoriza el alta; después, la persona inicia sesión mediante el sistema de sesiones propio del proyecto.
