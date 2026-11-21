# Cartas: consistencia, carpetas y eliminación compartida

## Semántica de carpetas

Las carpetas representan estados personales de cada participante; no crean copias de una carta:

- **Buzón / Enviadas:** cartas recibidas o enviadas que no están en Papelera ni archivadas para esa cuenta.
- **Favoritos:** una marca personal. Una carta favorita puede seguir apareciendo en Buzón o Enviadas y también en Favoritos. Esa aparición entre secciones es intencional; no es una segunda carta.
- **Archivo:** marca personal que la oculta de Buzón o Enviadas para esa persona. No afecta la vista del otro participante.
- **Papelera:** estado personal. Una carta enviada puede estar en Papelera para una persona y seguir visible para la otra. Al mover una carta a Papelera se oculta de las demás secciones de ese usuario.
- **Borradores:** solo son visibles y editables por su remitente. No se comparten antes del envío.

Las respuestas son cartas individuales relacionadas mediante `reply_to_letter_id` y el mismo `thread_id`. La vista de conversación deduplica por UUID y la lista de cada carpeta también. El inicio elimina duplicados cuando combina recibidas y enviadas. El backend aplica otra deduplicación defensiva por UUID.

## Acciones repetidas

El frontend mantiene un bloqueo temporal por ID de carta mientras se ejecuta una acción de estado (favorito, archivo, papelera, restauración, purga, respuesta o edición). Los botones de esa carta se deshabilitan durante la operación. PostgreSQL sigue siendo la autoridad: las funciones de estado comprueban el usuario, el estado actual y devuelven resultados idempotentes cuando la carta ya está en el estado solicitado.

Favorito, Archivo, restaurar y confirmar eliminación actualizan primero el estado visible de forma optimista; la petición se ejecuta después. Si el backend rechaza el cambio, la interfaz restaura la instantánea anterior. Esto evita que la persona espere la recarga completa de la carpeta para ver el resultado. Descartar también retira la tarjeta antes de esperar la respuesta y la revierte ante un error. Las vistas se invalidan para que una navegación posterior vuelva a consultar el estado real, pero no se vuelve a descargar la lista como parte del mismo clic.

Una respuesta antigua o una precarga iniciada antes del cambio de cuenta no puede volver a poblar el estado actual porque la caché está limitada por el ID de usuario y la generación de caché.

## Apertura de una carta

Cuando una tarjeta ya incluye título y cuerpo, esos datos se muestran de inmediato mientras se consulta la conversación completa. La operación de marcar como leída y la actualización de contadores se ejecutan en segundo plano; no bloquean la lectura inicial. Si la consulta del hilo falla, el resumen disponible permanece en pantalla y se ofrece actualizar.

Una vez cargado el hilo, los botones «Abrir carta» reutilizan las cartas que ya están en memoria. El controlador cambia la carta seleccionada y la vista actualiza únicamente `#letter-detail-content`; no reconstruye el menú, la cabecera ni el shell de la aplicación y no vuelve a ejecutar `get` contra Supabase para otra carta del mismo `thread_id`. La lista de correspondencia permanece visible para poder saltar de una respuesta a otra sin esperar una segunda carga.

## Eliminación compartida

Mover una carta enviada a Papelera es una acción personal y reversible. La eliminación del contenido se completa solo cuando ambos participantes:

1. han movido su propia copia a Papelera; y
2. han confirmado la eliminación definitiva.

Los estados que devuelve `confirm_letter_permanent_deletion` son:

- `pending_other_participant`: se guardó la primera confirmación.
- `already_confirmed_waiting`: esa misma persona ya había confirmado; no se registra una acción adicional.
- `purged`: la segunda confirmación completó la eliminación del contenido.
- `already_purged`: otra petición ya completó el proceso.

La interfaz muestra quién falta por confirmar y deshabilita la acción repetida después de registrar la confirmación propia. La carta permanece en Papelera hasta completar las dos confirmaciones. Los borradores se purgan únicamente por su propietario.

Un borrador nuevo no se crea al entrar en «Escribir carta» ni al escribir solamente un título. La primera sincronización requiere texto no vacío en el cuerpo de la carta. La misma condición se comprueba en el controlador y en `letters-api`. Los borradores existentes sí pueden guardarse mientras se editan, incluso si se elimina temporalmente su texto. La función SQL `save_letter_draft` bloquea primero la carta y después el estado del usuario, en el mismo orden que el descarte; si la carta ya está en Papelera, devuelve `discarded` y no modifica el contenido. Esto impide que un autoguardado retrasado la haga reaparecer.

## Respuestas cuyo original ya fue purgado

La relación entre una respuesta y su carta original se valida al crear la respuesta o cambiar su referencia. La transición de una respuesta ya existente a `status = 'purged'` no debe volver a exigir que su carta original siga en estado `sent`. La migración `20261119090000_shared_letter_purge_and_reply_guard.sql` ajusta el trigger de inmutabilidad para permitir esta transición sin permitir crear nuevas respuestas a un original purgado ni cambiar la identidad/hilo de una carta.

La prueba `supabase/tests/shared_letter_purge.test.sql` crea una carta y una respuesta temporales, confirma la eliminación de la original por ambos participantes y después comprueba que la respuesta también se puede purgar. El archivo termina con `ROLLBACK`.

## Sistema visual común

Las secciones privadas comparten una escala de títulos, subtítulos, texto y metadatos; un mismo radio y separación para tarjetas; alturas comunes para botones y campos; y una curva/duración de transición coherente. Los paneles de Configuración, las tarjetas de las listas, las notificaciones, las sesiones y el panel de conversación reutilizan los mismos tokens. Los temas claro y oscuro conservan contraste y las transiciones se desactivan cuando el sistema solicita movimiento reducido. La carta impresa mantiene su tratamiento editorial como superficie distinta.

## Cambio de cuenta

Al restaurar, iniciar sesión, cerrar sesión o detectar una sesión revocada, el controlador invalida las solicitudes y la caché privadas, vacía cartas, conversación, notificaciones, sesiones, dashboard y editor, y vuelve a establecer el usuario activo. Las claves de caché de listas incluyen el ID de cuenta. Las copias locales de borradores también se identifican por usuario.

## Despliegue pendiente

Esta versión amplía la migración pendiente `20261119090000_shared_letter_purge_and_reply_guard.sql` con la protección transaccional del autoguardado contra el descarte, y modifica `letters-api` para rechazar la creación de borradores nuevos vacíos. La migración no se ha aplicado al proyecto de producción y `letters-api` no se ha desplegado con estos cambios. La prueba pgTAP contiene once aserciones y sigue pendiente de ejecutar en una rama aislada. Antes de ponerlos en producción, valida esa migración, ejecuta integración HTTP de dos cuentas, verifica la interfaz con Playwright y después promueve los cambios mediante el procedimiento habitual.


## Seguimiento local (20 de noviembre de 2026)

La migración `20261120173200_fix_orphaned_purge_and_list_pagination.sql` modifica la purga compartida para contar solo participantes activos y reevalúa las cartas al deshabilitar una cuenta. También incluye la reparación transaccional de cartas cuya otra cuenta ya no existe, y una RPC para listado y búsqueda paginados desde PostgreSQL. La prueba pgTAP pasa de 11 a 14 aserciones para cubrir una cuenta eliminada y la purga del contenido tras la confirmación de la persona que permanece.

La interfaz carga 40 cartas por página, 30 notificaciones y 40 cartas de conversación; añade páginas al desplazarse y ofrece controles manuales. El orden de cada conjunto es estable por fecha e ID. La búsqueda textual actual se realiza en PostgreSQL sobre el contenido legible; cuando E2EE se implemente, la búsqueda del contenido tendrá que desplazarse al cliente y solo los metadatos podrán filtrarse en el servidor.

`letters-api` define y valida contratos para RPC y GitHub Actions añade `deno check` mediante `npm run check:edge` antes de publicar Pages. La migración y el nuevo código son locales y requieren pruebas en una branch aislada. Producción no ha sido modificada.
