# Arquitectura de controladores y actualización adaptativa

## Objetivo

Reducir el acoplamiento del controlador de entrada sin crear instancias paralelas que dupliquen el estado, las cachés, la sesión o las colas de escritura. `AppController` sigue siendo la única instancia coordinadora; cada módulo especializado agrupa métodos relacionados y se compone sobre el mismo prototipo.

## Controladores

| Archivo | Responsabilidad |
|---|---|
| `app-controller.js` | Construcción del estado y la vista, inicialización, listeners globales, cambio de identidad, dispatch general de formularios/acciones y composición de módulos |
| `auth-controller.js` | Traspaso seguro del código de recuperación, continuidad de registro/rotación, recuperación pendiente y cierre forzado de sesión |
| `navigation-controller.js` | Resolución de rutas, precarga, caché de rutas, renderizado, paginación de carpetas, notificaciones y carga de mensajes anteriores |
| `letter-controller.js` | Caché de hilos, apertura inmediata de cartas, marcado de lectura en segundo plano, edición, respuestas, envío, formato, vista previa y descargas |
| `draft-controller.js` | Edición, validación de cuerpo, coordinación del autoguardado, cola de sincronización y descarte de borradores |
| `settings-controller.js` | Preferencias, temas, sesiones de dispositivos, verificación y renovación de la sesión propia |
| `notification-controller.js` | Lectura y sincronización de la bandeja de notificaciones |

Los módulos son clases sin constructor y no poseen estado duplicado. Sus métodos se instalan en `AppController.prototype` usando `Object.getOwnPropertyDescriptors`; esto es necesario porque los métodos de clase son no enumerables y un `Object.assign` simple no los copiaría. La prueba `controller-modularization.test.mjs` importa el controlador real y comprueba que los métodos compuestos están disponibles.

En este snapshot, `app-controller.js` tiene 863 líneas; conserva el estado compartido, los listeners generales, el dispatch de acciones y el montaje de módulos. `draft-controller.js` se redujo a 286 líneas. La persistencia local se extrajo a `assets/js/services/draft-persistence-service.js` (109 líneas), que centraliza copias de emergencia, lectura/restauración de IndexedDB, hidratación del editor y persistencia al salir. La sincronización remota permanece en su servicio/cola independiente. La modularización es progresiva: no se considera terminado el controlador principal.

## Servicios independientes

### `DraftPersistenceService`

`draft-persistence-service.js` recibe el contexto compartido de `AppController` y ejecuta operaciones de persistencia sin crear una segunda instancia de estado. Expone funciones para guardar/leer la copia de emergencia, recuperar IndexedDB, hidratar el editor y persistir al salir. `DraftController` conserva la coordinación de acciones y delega esas responsabilidades.

### `DraftSyncQueue`

Mantiene una cola serializada por cuenta. Un guardado posterior espera a que termine el anterior; si una escritura falla, el siguiente trabajo puede ejecutarse. Así se evitan actualizaciones simultáneas de revisión y conflictos artificiales. La cola se utiliza desde `DraftController` y no depende del DOM.

### `AdaptivePoller`

Gestiona una tarea asíncrona con una sola ejecución simultánea. Escucha `visibilitychange`, `focus`, `online` y eventos de actividad (`pointerdown`, `keydown`, `touchstart`, `scroll`). No mantiene temporizadores mientras la pestaña está oculta o sin conexión. Al volver, despierta la tarea si el último éxito ya quedó fuera de la ventana mínima; evita peticiones repetidas si el sondeo sigue fresco o está en curso.

Configuración actual:

| Tarea | Actividad | Inactividad | Inactividad tras | Backoff máximo |
|---|---:|---:|---:|---:|
| Validación de sesión | 5 min | 15 min | 2 min | 30 min |
| Notificaciones | 2 min | 10 min | 2 min | 15 min |

El backoff duplica el intervalo de base después de cada error, hasta su máximo. La próxima actividad puede adelantar un sondeo al intervalo activo, pero no elimina la protección del backoff. Los sondeos se suspenden al cerrar sesión y se recrean con la nueva identidad. La actualización de notificaciones fusiona los registros nuevos con las páginas ya cargadas y actualiza solo el indicador cuando la persona está en otra sección: no reconstruye el editor o la página que está utilizando.

No se añadió Supabase Realtime en esta iteración. La aplicación no utiliza Supabase Auth: valida una sesión opaca propia en sus Edge Functions. El polling adaptativo reduce llamadas cuando la persona está inactiva y limita el cambio al modelo de identidad actual. Realtime puede evaluarse por separado para notificaciones cuando se diseñe y pruebe su autenticación/aislamiento con estas sesiones propias.

## Cambio de nombre visible transaccional

`letters-api` ya no envía dos escrituras independientes a `app_users` y `user_profiles`. Llama una sola vez al RPC `rename_app_profile`. PostgreSQL ejecuta ambos cambios dentro de la transacción asociada a la llamada RPC: si falla cualquiera de las operaciones, se revierte toda la función.

El parámetro `p_user_id` se obtiene del resultado de `requireSession(req)` en la Edge Function. Nunca se toma del cliente. El RPC bloquea la fila activa de `app_users`, valida el nombre visible, actualiza `app_users` e inserta/actualiza `user_profiles`. Los permisos `EXECUTE` se revocan a `public`, `anon` y `authenticated`, y solo `service_role` puede invocarlo desde el backend.

La migración `20261120235900_transactional_profile_rename.sql` es local y está pendiente de validarse en una branch aislada antes de desplegarse en producción.

## Verificaciones

- `npm run check`: comprueba estructura, sintaxis ES Modules, imports locales y contratos estáticos.
- `npm test`: incluye pruebas del descriptor composition, serialización de la cola, visibilidad/actividad/backoff del poller y uso del RPC de perfil.
- `npm run build:pages`: genera la web estática para GitHub Pages.
- `npm run check:contrast`: revisa 22 pares de color seleccionados en ambos temas.
- `npm run test:a11y`: ejecuta axe-core y geometría del pie del editor en Chromium, después de `npm ci` y de instalar Chromium.
- `npm run check:edge`: ejecuta `deno check` en el workflow de GitHub Actions; el entorno local que produjo este paquete no tenía Deno instalado, así que se ejecutó además una comprobación estricta equivalente con `tsc` sobre las Edge Functions.

Estas pruebas no sustituyen una prueba con dos sesiones reales ni la aplicación de la migración sobre una branch aislada de Supabase.
