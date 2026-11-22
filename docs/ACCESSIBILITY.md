# Accesibilidad y gestión del enfoque

La interfaz incorpora controles semánticos, navegación por teclado, estados de foco, regiones de anuncios específicas, objetivos táctiles y compatibilidad con movimiento reducido. Esta guía distingue la cobertura automatizada de las validaciones manuales. Pasar axe-core o una auditoría de paleta no equivale a certificar conformidad WCAG.

## Cobertura automatizada incluida

El workflow `Verify and deploy Nuestro Rincón` ejecuta las comprobaciones antes de publicar el artefacto:

1. `npm ci` instala el árbol de dependencias fijado por `package-lock.json`.
2. `npm run check` valida estructura, imports y sintaxis.
3. `npm run check:contrast` analiza 24 combinaciones seleccionadas de contraste en los dos temas.
4. `npm run check:edge` verifica las Edge Functions.
5. `npm test` ejecuta contratos y pruebas de comportamiento.
6. `npm run build:pages` prepara el sitio estático.
7. `npm run test:a11y` ejecuta axe-core en Chromium.

La matriz axe cubre nueve vistas (`login`, `register`, `recovery`, `inbox`, `write`, `notifications`, `settings`, `trash` y `letter`) en tema claro y oscuro. Además, comprueba formularios de acceso, registro y recuperación con errores, la pantalla de diez códigos de respaldo, el formulario de eliminación de cuenta y el `alertdialog` de confirmación destructiva. En Papelera se verifican estados `hover`, `disabled` y de espera; la navegación confirma la ruta seleccionada mediante `aria-current="page"`.

El conjunto de reglas de axe incluye WCAG 2.0/2.1/2.2 de nivel A y AA. Una violación reportada falla el job de verificación y evita que se publique el artefacto. El alcance y los nombres de las vistas son visibles en `tests/e2e/accessibility.spec.mjs`.

### Zoom, reflow y tamaños de pantalla

La suite Playwright comprueba el editor en anchos habituales y prueba las vistas críticas a:

- **640 píxeles CSS**, como equivalente de reflow de una ventana de 1280 píxeles CSS al 200 % de zoom del navegador.
- **320 píxeles CSS**, para comprobar reflow estrecho sin desplazamiento horizontal del documento, pérdida del encabezado ni desaparición de las acciones principales.

Esta simulación de viewport no sustituye la comprobación visual en un navegador real al 200 % de zoom, ni la inspección con ampliación del sistema operativo. Ambas permanecen en la matriz manual.

### Alcance de la auditoría de contraste

`tools/contrast-audit.mjs` calcula ratios WCAG para 24 combinaciones explícitas: 12 por tema, entre texto principal/secundario/suave, acento de navegación, anillo de foco y texto de botones primarios. Usa 4.5:1 para texto normal y 3:1 para indicadores de foco/no texto donde corresponde.

La auditoría de paleta no cubre todos los colores declarados directamente en componentes. axe inspecciona texto visible en las vistas y estados renderizados; los estilos `hover`, `disabled`, `error` y `selected` se incluyen parcialmente en fixtures y siguen requiriendo revisión manual de sus pares reales de primer plano y fondo, en ambos temas y con foco de teclado.

## Semántica, anuncios y gestión del foco

- `#app` no es una región viva. Reemplazar la vista no debe anunciar toda la aplicación.
- `#app-announcer` es una región `status` (`aria-live="polite"`) para confirmaciones e información.
- `#app-alert-announcer` es una región `alert` (`aria-live="assertive"`) para errores que requieren atención.
- Los avisos visuales no agregan regiones vivas redundantes.
- Las vistas autenticadas ofrecen enlace para saltar al contenido, navegación principal nombrada, ruta activa y encabezado enfocable.
- El menú móvil cerrado usa `inert` y `aria-hidden`; al abrirlo, el foco pasa al control de cierre. Al cerrar, se restaura al botón que abrió el menú.
- Los diálogos de confirmación y vista previa usan `dialog` o `alertdialog`, tienen nombre y descripción accesibles, limitan Tab, responden a Escape, inactivan la aplicación de fondo y devuelven el foco al disparador.
- Los controles del editor tienen nombres accesibles y son alcanzables mediante teclado.

## Matriz manual obligatoria antes de declarar conformidad

Las pruebas de lector de pantalla no se ejecutan en GitHub Actions. Requieren sistemas operativos, versiones de navegador y tecnologías de asistencia reales. **En esta entrega no se han ejecutado NVDA, VoiceOver ni TalkBack**; cada combinación de la matriz conserva el estado `Pendiente manual` hasta que una persona realice y registre el recorrido.

| Tecnología / entorno | Recorrido que se debe completar | Resultado esperado | Estado |
|---|---|---|---|
| NVDA + Firefox (Windows) | Login, registro, error de credenciales, recuperación, anuncios `status`/`alert` | Etiquetas, instrucciones, mensajes de error anunciados una vez, orden de foco y encabezados | Pendiente manual |
| NVDA + Firefox (Windows) | Ajustes, rotación de códigos, confirmación de eliminación de cuenta y cancelación del diálogo | Nombre/rol/estado, descripción del `alertdialog`, lectura de la advertencia y retorno de foco | Pendiente manual |
| NVDA + Firefox (Windows) | Papelera: abrir carta, recuperar, esperar confirmación compartida y eliminar definitivamente | Estado de espera/deshabilitado comunicado; acciones no confundidas ni anunciadas como disponibles | Pendiente manual |
| NVDA + Chrome o Edge (Windows) | Navegación entre secciones, menú móvil, editor, vista previa y formularios con error | Landmarks, encabezados, lectura coherente, foco visible y sin anuncios duplicados | Pendiente manual |
| VoiceOver + Safari (macOS) | Login, recuperación, rotor, encabezados, campos y mensajes de validación | Rotor útil, orden de lectura lógico y errores perceptibles sin depender del color | Pendiente manual |
| VoiceOver + Safari (macOS) | Diálogo de eliminación, confirmación/cancelación y Papelera | Modalidad efectiva, título/descripción, acciones y restauración del foco | Pendiente manual |
| VoiceOver + Safari (iPhone/iPad) | Menú, buzón, detalle, editor, Papelera y recuperación de códigos | Navegación por gestos, elementos ocultos fuera del recorrido, botones táctiles y lectura contextual | Pendiente manual |
| TalkBack + Chrome (Android) | Login, recuperación, error de formulario, notificaciones y ajustes | Orden de swipe, encabezados, descripciones, anuncios y controles táctiles | Pendiente manual |
| TalkBack + Chrome (Android) | Diálogos de confirmación y Papelera | Foco/lectura contenidos en el diálogo, distinguir recuperar de eliminar, estados deshabilitados claros | Pendiente manual |
| Teclado, sin lector | Toda la aplicación: Tab, Shift+Tab, Enter, Espacio y Escape | Orden lógico, indicador visible, ninguna trampa fuera del diálogo, retorno del foco | Pendiente manual |
| Zoom de navegador 200 % | Buzón, editor, detalle, Papelera, ajustes, recuperación y diálogo | Sin recorte, solapamiento ni pérdida de función; scroll solo en contenedores que lo necesiten | Pendiente manual |
| Reflow a 320 CSS px | Buzón, editor, detalle, Papelera, notificaciones, ajustes y formularios | Sin scroll horizontal de página para contenido de lectura; acciones y campos utilizables | Pendiente manual |
| Estados visuales, ambos temas | `hover`, `focus-visible`, `disabled`, `error`, `selected` y espera de confirmación | Contraste suficiente, estado no comunicado solo por color, foco no oculto | Pendiente manual |

### Seguridad al probar eliminación de cuenta

Los recorridos de recuperación y eliminación deben usar **cuentas de prueba en un proyecto Supabase aislado**. Comprueba primero la validación HTML de la contraseña y la palabra `ELIMINAR`, después abre el diálogo, prueba cancelar y verifica que el foco vuelve al botón de origen. La ruta de confirmación definitiva puede borrar datos: no la ejecutes con una cuenta real ni contra producción. Si se necesita probar la confirmación del servidor, usa una cuenta desechable y registra el resultado antes de eliminar el entorno.

## Límites conocidos

- axe-core detecta muchos problemas A/AA, pero no determina por completo si el orden de lectura, el contexto, la redacción o la respuesta de una tecnología de asistencia resultan comprensibles.
- Los fixtures automatizados cubren vistas y estados enumerados; no validan todas las combinaciones posibles de contenido, navegador, fuente, zoom y lector de pantalla.
- Los cambios de `tools/contrast-audit.mjs` son una auditoría de paleta, no una medición de cada píxel de la aplicación.
- La automatización en Chromium no equivale a compatibilidad certificada en Firefox, Safari o Chrome móvil.

### Regresiones detectadas y corregidas en la suite

- Las tarjetas de carta exponen el nombre accesible a partir del texto visible, sin un `aria-label` que lo sustituya y provoque `label-content-name-mismatch`.
- Las etiquetas de estado normales y de no leído usan primeros planos con contraste AA sobre sus fondos claros, y las fechas de las tarjetas tienen un color secundario legible también en el tema oscuro.
- El detalle y el hilo de una carta representan el contenido con `sanitizeRichHtml`, la misma lista blanca usada por el editor, evitando referencias a un formateador inexistente.
- Los tests de errores apuntan al mensaje `.form-error[role="alert"]` y no al anunciador global vacío, que también tiene el rol `alert` por diseño.

## Ejecución local

```bash
npm ci
npm run check:contrast
npx playwright install chromium
npm run test:a11y
```

Para ejecutar toda la matriz E2E de escritorio y móvil con datos de prueba aislados:

```bash
npm run test:e2e
```

Al completar una prueba manual, registra fecha, versión de la aplicación, sistema operativo, navegador, lector de pantalla y su versión, recorrido exacto, resultado y defectos observados. No cambies el estado a `Validado` sin conservar esa evidencia.
