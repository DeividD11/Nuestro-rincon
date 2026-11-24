# Imágenes de cartas y avatares

## Alcance de la implementación

La versión local v36 permite insertar hasta **seis imágenes** en el cuerpo de una carta o respuesta y elegir un avatar desde el dispositivo. El frontend no publica archivos ni construye URLs públicas: las operaciones se autorizan en `letters-api` después de validar la sesión opaca propia.

| Tipo | Límite del archivo original | Resultado optimizado | Límite por elemento |
|---|---:|---:|---:|
| Imagen de carta/respuesta | 20 MiB | Máximo 1.600 px en el lado mayor | 3 MiB; hasta seis por carta |
| Avatar | 20 MiB | Máximo 512 px en el lado mayor | 512 KiB |

Se aceptan JPG/JPEG, PNG y WebP. El navegador decodifica y rasteriza la imagen antes de subirla, elimina metadatos y usa un proceso adaptativo con un máximo de cinco tamaños de exportación WebP; JPEG solo se prueba como alternativa cuando el navegador no produce WebP o cuando se necesita una salida más compacta. Así se evita el ciclo anterior de decenas de exportaciones encadenadas. Si el motor devuelve PNG como formato alternativo, se acepta ese MIME real cuando cabe en el límite y el servidor conserva la extensión coherente con el MIME recibido. También se limita la resolución decodificada para evitar imágenes desproporcionadamente grandes. `profile-avatar-preview` muestra iniciales y un placeholder animado mientras la foto se decodifica, sin exponer el texto alternativo del navegador; el avatar local se muestra antes de iniciar la subida y se sustituye por la URL privada firmada cuando el servidor confirma el cambio.

## Miniaturas de cartas

La versión local v36 añade `firstImageUrl` a los resúmenes de las cartas. `letters-api` busca la primera etiqueta `img` en el contenido sanitizado, valida que su ruta corresponda al ID de la carta o a su carta padre (en respuestas) y que el segundo segmento de la ruta sea el remitente. Solo entonces genera una URL privada de lectura por 24 horas. Se genera una miniatura por carta, aunque tenga varias imágenes; el orden del HTML conserva el orden en que fueron insertadas. La firma se limita a seis cartas concurrentes por petición para no lanzar una ráfaga de llamadas a Storage. El frontend valida origen y ruta antes de insertar la imagen en `letter-stamp`; ante un error, queda visible el icono normal.

Este cambio requiere publicar la nueva fuente de `letters-api` que viene dentro del ZIP. La función remota comprobada en la línea base sigue siendo v11; no se desplegó automáticamente durante esta entrega. No requiere cambio SQL ni hacer público el bucket. Supabase documenta que los archivos en buckets privados solo deben servirse mediante URLs firmadas temporales o peticiones autenticadas ([Serving assets from Storage](https://supabase.com/docs/guides/storage/serving/downloads)).

## Preparación automática de Supabase Storage

`letters-api` v11 utiliza el bucket privado `private-media`, creado y registrado por `20261124052017_ensure_private_media_bucket`. La función utiliza URLs firmadas de Storage con credencial de servidor; el navegador recibe solo una URL temporal de carga y nunca la clave privilegiada. La migración declara el límite de 5 MiB y los MIME JPEG/PNG/WebP.

Configuración exigida y verificada por la función:

1. Nombre/ID: `private-media`.
2. Acceso: **Private** (`public: false`).
3. Límite por objeto: 5 MiB (5.242.880 bytes).
4. MIME permitidos: `image/jpeg`, `image/png` y `image/webp`.

El bucket ya se creó y quedó registrado en la migración `20261124052017_ensure_private_media_bucket`; `letters-api` v11 confirma la configuración antes de emitir URLs firmadas. El frontend no tiene permisos administrativos ni una clave de Storage. No se crean políticas públicas ni se concede acceso directo a `storage.objects`. Documentación: [Creating Buckets](https://supabase.com/docs/guides/storage/buckets/creating-buckets) y [Storage Buckets](https://supabase.com/docs/guides/storage/buckets/fundamentals).

## Estado real y orden de publicación

Comprobado el 24 de noviembre de 2026 en el proyecto `tiqbmuubpbmxqvtkcdhq`:

- `letters-api` está desplegada en versión **v11** (`ACTIVE`, `verify_jwt=false` con validación propia mediante `requireSession`). `auth-api` permanece en v11.
- `public.user_profiles.avatar_path` y la restricción `user_profiles_avatar_path_owner_ck` ya estaban presentes en producción. La migración local `20261123193000_private_media_and_profile_avatars.sql` no se volvió a ejecutar y no debe tratarse como pendiente de DDL.
- `private-media` existe y quedó registrado por `20261124052017_ensure_private_media_bucket`. Los registros del navegador confirman URL firmada POST 200, upload PUT 200 y comprobación HEAD 200, además de escritura 200 en `user_profiles`. La inserción/lectura de imágenes dentro de una carta y la validación cruzada entre dos cuentas siguen pendientes de prueba manual.
- La migración `20261123205422_revoke_other_app_sessions_atomically.sql` figura en el ledger remoto como versión 24; la configuración de medios se agregó después como la versión 25. Su RPC fue comprobado como `SECURITY INVOKER`, sin `EXECUTE` para `anon` ni `authenticated`, y con permiso para `service_role`.

Orden recomendado:

1. Publica la nueva fuente de `letters-api` incluida en este ZIP y, después, publica el frontend v36 en GitHub Pages.
2. Inicia sesión y cambia el avatar con una imagen de prueba pequeña. El bucket ya existe; la función emitirá una URL firmada y cargará el objeto en almacenamiento privado.
3. Verifica en Supabase Dashboard → Storage que `private-media` sigue privado, con 5 MiB y solo los tres MIME especificados.
4. Comprueba que la imagen se muestra tras recargar y abrir una segunda sesión/dispositivo; prueba también eliminar/cambiar el avatar.
5. Prueba adjuntos desde la cuenta A y lectura desde la cuenta B; intenta una ruta de otro usuario y confirma que el servidor la rechaza.
6. En Sesiones y dispositivos, crea otra sesión de prueba. Revoca las demás y verifica que la sesión actual sigue activa, las otras quedan invalidas y la lista se actualiza sin saltar ni esperar múltiples llamadas.

No es necesario desplegar `auth-api` para este cambio. La publicación remota de `letters-api` v11 corresponde a la versión anterior; la nueva lógica de miniaturas de v36 todavía debe desplegarse.

## Modelo de almacenamiento y autorización

- Imágenes de cartas: `letters/{letterId}/{uploaderUserId}/{randomUuid}.{ext}`. En las respuestas, `letterId` corresponde a la carta padre.
- Avatares: `{userId}/avatars/{randomUuid}.{ext}`.
- PostgreSQL conserva la ruta de cada imagen dentro del HTML sanitizado y `avatar_path` en `user_profiles`; no conserva URLs firmadas.
- `letters-api` valida la sesión de la aplicación, la pertenencia de la persona a la carta o conversación, el estado de borrador/respuesta y el prefijo asociado al usuario antes de emitir una URL de subida o lectura.
- Las URLs de subida son firmadas y de duración limitada. Las URLs de lectura se firman por 24 horas cuando la carta/perfil se recupera.
- La clave de servicio solo se utiliza dentro de la Edge Function. Las claves nuevas `sb_secret_*` se envían únicamente en `apikey`; solo la clave JWT `service_role` heredada se usa también como `Authorization: Bearer`. No se incluye ninguna clave de servidor en HTML, JavaScript, GitHub Actions ni en el ZIP del frontend.
- El bucket es privado. No se crean políticas públicas de Storage ni se exponen rutas `/object/public/`.
- Al cambiar un avatar, el backend guarda primero la nueva ruta y luego intenta eliminar el objeto anterior. Si falla la limpieza, la imagen antigua permanece privada y no se muestra en el perfil.

## Verificación después del despliegue

Con dos cuentas distintas, comprueba como mínimo:

- La cuenta A puede adjuntar imágenes a un borrador y volver a abrirlo; la imagen se muestra sin desbordar el ancho en 320, 375, 768 y 1.440 px. En la tarjeta de la carta aparece únicamente la primera imagen insertada en `letter-stamp`.
- La cuenta B puede ver las imágenes al recibir la carta y al abrir cada respuesta.
- La cuenta A no puede solicitar una URL firmada para una imagen de otra cuenta/carta, ni modificar el prefijo de una ruta para saltar a otro propietario.
- Un HTML que contenga `img` externo, `data:` o un path que no corresponda a la carta/usuario es descartado por la sanitización del servidor.
- Un séptimo adjunto, un MIME no permitido o un archivo por encima del límite se rechaza.
- Cada cuenta puede cambiar y quitar su avatar; el perfil de la otra cuenta no puede modificarse.
- La revocación masiva cierra todas las otras sesiones y sus refresh tokens y suscripciones push, pero la sesión que ordenó la operación continúa activa. El botón está en el extremo derecho del encabezado y la lista se actualiza sin reconstruir la página ni modificar la posición de desplazamiento.

## Límites conocidos

- El código local no incluye un recolector periódico de objetos huérfanos. Si se obtiene una URL de subida y la operación se abandona antes de asociar la imagen al contenido, el objeto puede permanecer en el bucket privado sin mostrarse en la aplicación. Debe programarse una política de limpieza después de auditar los tiempos de vida de borradores y respuestas locales.
- Los URLs firmados de lectura son credenciales temporales: cualquier persona que reciba uno puede utilizarlo mientras siga vigente. No los copies ni los publiques. La rotación de la clave de firma puede invalidar URLs firmadas, pero no se revocan individualmente.
- Las imágenes se almacenan como archivos privados separados; no están cifradas de extremo a extremo. El servidor de Supabase puede procesarlas y servirlas mediante URL firmada.
- La exportación HTML de una carta puede contener URLs firmadas que expiran; el archivo exportado no es un paquete autónomo de imágenes.


## Cambios locales v36 (24 de noviembre de 2026)

- Avatar: placeholder profesional, sin texto alternativo visible durante la carga; prioridad de descarga alta y fallback de iniciales si el recurso falla.
- Compresión: avatar hasta 512 px / 512 KiB; adjuntos hasta 1.600 px / 3 MiB. El procesador limita las codificaciones de prueba.
- Cartas: la función local añade una URL firmada para la primera imagen del contenido, con validación de carta/hilo y remitente. El frontend la representa en `letter-stamp`.
- Publicación: estas modificaciones son locales. El proyecto remoto permanece en `letters-api` v11 hasta que se despliegue la fuente incluida en el ZIP. No se modificó el esquema ni el bucket.

## Verificación remota (24 de noviembre de 2026)

Los registros de Storage confirman una solicitud de URL firmada (`POST 200`), la carga del objeto (`PUT 200`) y su comprobación (`HEAD 200`). La escritura de la ruta de avatar en `public.user_profiles` también respondió `200`. Estas pruebas verifican la ruta de carga de avatar; la inserción/lectura de imágenes de carta con dos cuentas sigue pendiente de comprobación manual.


## Correcciones de lectura v37

- `letter-paper` tiene una medida de línea de hasta 68 caracteres tipográficos, tipografía serif legible, interlineado amplio, márgenes de párrafo y estilos definidos para títulos, énfasis, listas y citas. El contenedor permite que las cartas largas crezcan sin recortar el contenido; hay ajustes específicos para pantallas pequeñas y para el modal de revisión.
- El sanitizador de cliente y servidor reemplaza el `alt` del nombre del archivo por `Imagen adjunta`. Así los nombres locales no se muestran al abrir cartas o borradores ni quedan persistidos en nuevos guardados.
- `renderLetterBodyHtml` crea un marco con placeholder mientras la imagen firmada se decodifica; el editor muestra un esqueleto animado en el propio espacio de la imagen. La primera imagen usa prioridad alta; las siguientes mantienen carga diferida. Si un archivo falla, se deja un estado neutral en vez de mostrar el texto del archivo o el icono roto.
- `letter-stamp` conserva el icono del sello durante la carga y revela la primera miniatura firmada cuando termina. Solo hay una miniatura por carta, aunque existan hasta seis adjuntos.

**Requisito de producción:** el frontend no puede firmar por sí mismo las rutas privadas. `letters-api` debe entregar `firstImageUrl` en las respuestas de lista. La última versión remota comprobada sigue siendo v11, por lo que se debe desplegar la fuente local actualizada de `supabase/functions/letters-api` antes de esperar la miniatura en GitHub Pages. Esta entrega no realizó ese despliegue ni ningún cambio SQL. Si solo se publica el frontend, el sello mantiene su icono alternativo, por diseño.


## Estados de carga de imágenes v38

Al representar el HTML de una carta, si la ruta de imagen aún no dispone de `src` firmado, el marco permanece en estado `is-loading` y anuncia `Cargando imagen…`. No se muestra `Imagen no disponible` antes de que exista un intento real de descargar la imagen. Si una imagen con URL firmada genera un evento `error`, se cambia al estado de fallo y se deja el mensaje neutral. La miniatura del sello continúa utilizando solo `firstImageUrl`, que firma el servidor para la primera imagen del HTML.

La parte visual del sello ya estaba incluida en el frontend anterior; si una carta aún muestra `✎`, comprobar que la respuesta de `letters-api` incluya `firstImageUrl`. El último estado remoto comprobado en este conjunto de documentación sigue siendo v11; publicar solo GitHub Pages no es suficiente para obtener miniaturas de un bucket privado.

## Miniaturas de borradores y carga de adjuntos v39

`letterCard` extrae la primera ruta `data-image-path` del cuerpo cuando `firstImageUrl` no está disponible. La tarjeta se representa inicialmente con el estilo de carga y `hydrateLetterStampPreviews` obtiene la URL por `media:sign-letter-image`; el servidor valida la sesión y comprueba que la ruta corresponde a la carta y al propietario. La URL se comprueba en el navegador contra el origen HTTPS configurado y la ruta `/storage/v1/object/sign/private-media/`. La caché es temporal y el trabajo se limita a seis solicitudes concurrentes. Este fallback cubre el listado de Borradores con `letters-api` v11, donde la operación autenticada `media:sign-letter-image` ya estaba presente; `firstImageUrl` continúa siendo un campo opcional para evitar solicitudes adicionales cuando el servidor ya lo proporciona.

El editor inserta un contenedor `data-letter-image-uploading` con el mismo texto y shimmer `Cargando imagen…` antes de iniciar la compresión y carga. `sanitizeRichHtml` descarta el contenedor transitorio completo para que el mensaje no pueda persistirse ni contaminar el cuerpo. Cuando la carga termina, el contenedor se reemplaza por la imagen asociada a su ruta privada; el estado `.letter-editor-image.is-loading` continúa hasta que el navegador completa `load` o `error`. No requiere cambios de Storage, RLS ni SQL.



## Miniaturas privadas de `letter-stamp` (v40)

- Las miniaturas de las tarjetas usan una URL firmada con transformación de Storage: 96 × 96 px, recorte `cover` y calidad 72. El original de la carta no se modifica.
- La misma operación se usa al hidratar los borradores mediante `media:sign-letter-thumbnail`; la autorización sigue verificando sesión, propietario, estado de la carta y ruta del objeto.
- Si el proyecto no tiene habilitadas las transformaciones de imagen, la Edge Function detecta el fallo y devuelve la URL firmada del original. El fallback se memoriza durante la vida de la instancia para no repetir intentos fallidos.
- Las imágenes de las listas usan `loading=lazy`, `decoding=async` y prioridad baja. El placeholder de `letter-stamp` conserva el espacio, muestra brillo y un indicador animado, y no desaparece hasta que la imagen se decodifica correctamente. Respeta `prefers-reduced-motion`.
- Las transformaciones de Storage son una función de los planes que las incluyen. Comprueba su disponibilidad y el uso/cupo en Storage → Settings / Usage antes de habilitarlas; si no están disponibles, la aplicación continúa con el original.


## Carga global y reutilización de imágenes (v41)

- La vista conserva los nodos de avatar de la barra lateral y Configuración entre renders de ruta mediante `AvatarNodeCache`. La comprobación de Configuración se hace contra esa misma caché y no crea un `<img>` duplicado al volver al apartado.
- La barra lateral muestra el shimmer y el spinner circular mientras la foto aún no está decodificada; al cambiar avatar, mantiene la vista previa local hasta tener lista la URL privada remota.
- `letters-api` devuelve avatares con transformación 256 × 256, `cover`, calidad 78. Los adjuntos visibles dentro de cartas se transforman a 1.440 × 1.440, `contain`, calidad 78. El original no se modifica y el fallback firmado al original se mantiene.
- `createPrivateReadUrl` almacena las URL firmadas transformadas/no transformadas en una caché LRU acotada (máximo 2.048 entradas) durante menos tiempo que la expiración del token; se reutilizan entre peticiones dentro de la misma instancia Edge y las firmas concurrentes idénticas se agrupan en una sola petición.
- `letter-stamp` firma las miniaturas a medida que se acercan a pantalla, hasta cuatro firmas concurrentes; los navegadores sin `IntersectionObserver` siguen procesando todas las tarjetas mediante lotes acotados.
- El estado del sello no aplica un panel de fondo cuadrado durante la carga: el spinner se dibuja directamente sobre el contenedor transparente.
- `letter-paper` usa fondo sólido y `letter-body` normaliza color, relleno de texto, opacidad, filtros y sombras de los elementos internos para mantener una apariencia uniforme.

El código requiere publicar la nueva `letters-api` y el frontend. No se añade migración SQL, no se cambia el bucket y no se hace público Storage. La optimización mediante variantes de Storage requiere que Image Transformations esté habilitado; cuando no lo está, la función vuelve a la URL firmada original.

## Centrado estable del spinner de `letter-stamp` (v42)

El pseudo-elemento circular se posiciona en `left: 50%` y `top: 50%`, y utiliza `letter-stamp-centered-spin`. Tanto el fotograma inicial como el final animan la transformación completa `translate(-50%, -50%) rotate(...)`; por tanto, la rotación no elimina el desplazamiento que lo mantiene centrado. Se evita reutilizar `letter-stamp-spin`, que solo anima `rotate()` y era la causa del salto diagonal. La regla `prefers-reduced-motion` detiene el giro y conserva únicamente la traslación central. Es un cambio exclusivamente CSS: no requiere desplegar `letters-api`, modificar Supabase ni ejecutar migraciones.


## Fiabilidad de avatar lateral (v44)

- `AvatarNodeCache.hasSidebar()` no reutiliza un nodo sin `<img>` cuando el perfil sí tiene URL de imagen.
- `AppView` pasa explícitamente si el nodo lateral se puede reutilizar; al reconstruirlo, `restore()` adopta el nodo nuevo en lugar de reemplazarlo por el nodo cacheado anterior.
- Al reinsertar un nodo cacheado, `AvatarNodeCache` comprueba `complete` y `naturalWidth`; si la imagen ya estaba descargada y decodifica, retira `is-loading`, y si el error ocurrió mientras estaba desconectada, deja el fallback de iniciales.
- Si falla una URL privada, la vista solicita una URL firmada actualizada una vez por ruta del objeto. Si el path no cambió y el `<img>` sigue cargando o está decodificado, se conserva para evitar descargas y parpadeos.
- El spinner de `user-mini` utiliza `letter-stamp-centered-spin`, manteniendo `translate(-50%, -50%)` durante toda la rotación y respetando `prefers-reduced-motion`.

No hay cambios de esquema, permisos, Storage o Edge Functions en esta versión.
