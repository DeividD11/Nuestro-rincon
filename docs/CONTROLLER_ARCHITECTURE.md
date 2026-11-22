# Arquitectura de controladores y actualización adaptativa

## Objetivo

Reducir el acoplamiento del controlador de entrada sin crear instancias paralelas que dupliquen el estado, las cachés, la sesión o las colas de escritura. `AppController` sigue siendo la única instancia coordinadora; cada módulo especializado agrupa métodos relacionados y se compone sobre el mismo prototipo.

## Controladores

| Archivo | Responsabilidad |
|---|---|
| `app-controller.js` | Construcción de estado/vista, dependencias compartidas y composición de módulos; no contiene el arranque ni los listeners globales |
| `app-initialization-controller.js` | Secuencia única de arranque: tema inicial, pantalla de carga, conexión de eventos y restauración de sesión |
| `app-event-coordinator-controller.js` | Registro de listeners globales, accesibilidad responsive y delegación de `submit`/`click` a handlers especializados |
| `session-lifecycle-controller.js` | Canal de revocación entre pestañas, restauración inicial y aislamiento/limpieza de estado privado al cambiar de identidad |
| `auth-controller.js` | Traspaso seguro del código de recuperación, continuidad de registro/rotación, recuperación pendiente y cierre forzado de sesión |
| `navigation-controller.js` | Resolución de rutas, precarga, caché de rutas, renderizado, paginación de carpetas, notificaciones y carga de mensajes anteriores |
| `letter-controller.js` | Caché de hilos, apertura inmediata de cartas, marcado de lectura en segundo plano, edición, respuestas, envío, formato, vista previa y descargas |
| `draft-controller.js` | Edición, validación de cuerpo, coordinación del autoguardado, cola de sincronización y descarte de borradores |
| `settings-controller.js` | Preferencias, temas, sesiones de dispositivos, verificación y renovación de la sesión propia |
| `notification-controller.js` | Lectura y sincronización de la bandeja de notificaciones |

Los controladores de dominio siguen siendo clases sin constructor y no poseen estado duplicado. Sus métodos se instalan en `AppController.prototype` usando `Object.getOwnPropertyDescriptors`; esto es necesario porque los métodos de clase son no enumerables y un `Object.assign` simple no los copiaría. Los handlers de evento y las vistas son funciones puras/delegadas que reciben el contexto de la instancia cuando necesitan acceso al estado. `controller-modularization.test.mjs` importa la clase real, verifica el contrato público y limita el tamaño del coordinador.

En v25, `app-controller.js` queda en aproximadamente 80 líneas y se concentra en crear el estado compartido, inicializar dependencias y componer prototipos. `init()` vive en `app-initialization-controller.js`; los listeners y la coordinación responsive están en `app-event-coordinator-controller.js`; y la recuperación de sesión, revocación entre pestañas y limpieza de identidad se aíslan en `session-lifecycle-controller.js`. Los despachos `onSubmit` y `onClick` delegan en `app-submit-handler.js` y `app-click-handler.js` usando `.call(this, event)`, de modo que ambos reciben la misma instancia coordinadora y el mismo estado. Los handlers mantienen la lógica de acciones fuera del controlador principal. `app-view.js` queda como una fachada de aproximadamente 100 líneas; los fragmentos de interfaz se separan en `auth-view.js`, `correspondence-view.js` y `settings-view.js`. `draft-controller.js` mantiene su coordinación del editor, y la persistencia local sigue en `draft-persistence-service.js`. La persistencia local vive en `assets/js/services/draft-persistence-service.js` y centraliza copias de emergencia, lectura/restauración de IndexedDB, hidratación del editor y persistencia al salir. La sincronización remota permanece en su servicio/cola independiente. El CSS principal también se dividió manteniendo el orden de cascada: `app.css`, `app-components.css` y `app-auth.css`; `index.html`, el auditor de contraste y las pruebas leen el bundle en el mismo orden. No se ha cambiado el mecanismo de carga a un bundler: GitHub Pages sigue sirviendo hojas de estilo y módulos estáticos.

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
- `npm run check:contrast`: revisa 24 combinaciones de color seleccionadas en ambos temas.
- `npm run test:coverage`: repite las pruebas con el instrumentador nativo de Node, limita la medición a `assets/js/**/*.js` y genera LCOV. El umbral inicial es 25 % líneas, 35 % funciones y 55 % ramas; es una línea base para elevarse progresivamente, no una afirmación de cobertura completa.
- `npm run test:a11y`: ejecuta axe-core y geometría del pie del editor en Chromium, después de `npm ci` y de instalar Chromium.
- `npm run check:edge`: ejecuta `deno check` en el workflow de GitHub Actions; el entorno local que produjo este paquete no tenía Deno instalado, así que se ejecutó además una comprobación estricta equivalente con `tsc` sobre las Edge Functions.

Estas pruebas no sustituyen una prueba con dos sesiones reales ni la aplicación de la migración sobre una branch aislada de Supabase.
