# Accesibilidad y gestión del enfoque

La interfaz incorpora controles semánticos, navegación por teclado, estados de foco, regiones de anuncios específicas, objetivos táctiles y compatibilidad con movimiento reducido. Esta guía separa la cobertura automatizada de las pruebas manuales: pasar axe-core o la auditoría de paleta no constituye por sí solo una certificación WCAG.

## Cobertura automatizada incluida

El workflow `Verify and deploy Nuestro Rincón` ejecuta las comprobaciones antes de subir el artefacto que después consume el despliegue:

1. `npm ci` instala exactamente el árbol de dependencias declarado en `package-lock.json`.
2. `npm run check` valida estructura, imports y sintaxis.
3. `npm run check:contrast` analiza combinaciones de la paleta de tema claro y oscuro.
4. `npm run check:edge` ejecuta `deno check` en las Edge Functions.
5. `npm test` ejecuta las pruebas de contrato y comportamiento.
6. `npm run build:pages` prepara el sitio.
7. `npm run test:a11y` ejecuta axe-core en Chromium para los estados de login, registro, recuperación, buzón, editor, notificaciones y configuración, en tema claro y oscuro.

La suite axe analiza las etiquetas WCAG 2.0/2.1/2.2 de nivel A y AA en los DOM de prueba. Cualquier violación reportada falla el job de verificación y evita que se publique el artefacto.

### Alcance de la auditoría de contraste

`tools/contrast-audit.mjs` calcula ratios WCAG para 22 pares explícitos de la paleta en los dos temas: texto principal, secundario y suave, acento de navegación, anillo de foco y texto de los botones primarios. Usa 4.5:1 para texto normal y 3:1 para el indicador de foco/no texto, según el criterio aplicable.

Esta auditoría cubre tokens y combinaciones seleccionadas, no todos los colores hard-coded ni todos los estados hover, disabled, error, selección y borde. La regla `color-contrast` de axe añade comprobación sobre texto visible en las pantallas de la matriz; los componentes y estados no renderizados deben comprobarse de manera específica.

## Estructura y anuncios

- `#app` no es una región viva. Sustituir la vista no debe anunciar indiscriminadamente toda la aplicación.
- `#app-announcer` es una región `status` (`aria-live="polite"`) para confirmaciones e información.
- `#app-alert-announcer` es una región `alert` (`aria-live="assertive"`) para errores que requieren atención.
- Los avisos visuales no añaden regiones vivas adicionales.
- Las vistas autenticadas incluyen enlace para saltar al contenido, navegación principal con nombre accesible, ruta activa y encabezado enfocable.

## Gestión del enfoque y teclado

- Al navegar a otra sección, el foco se coloca en el encabezado principal.
- El menú móvil cerrado se marca como `inert` y `aria-hidden`; al abrirlo, el foco pasa al control de cierre.
- Al cerrar el menú se restaura el foco al control «Abrir menú». Escape cierra el panel.
- Los diálogos de confirmación y vista previa limitan el recorrido de Tab, responden a Escape, inactivan el fondo y devuelven el foco al disparador.
- Los controles del editor tienen nombres accesibles y son alcanzables mediante Tab, Enter o Espacio.
- El pie del editor vive dentro de `.editor-shell`; sus reglas están aisladas en `assets/css/editor.css` y cambian a una sola columna en tablet/móvil.

## Pruebas manuales requeridas antes de declarar conformidad

| Tecnología / entorno | Recorrido | Resultado que debe comprobarse | Estado |
|---|---|---|---|
| Solo teclado, escritorio | Tab / Shift+Tab desde login hasta el último control | Orden lógico, foco visible, sin trampas fuera de diálogos | Pendiente manual |
| Solo teclado, escritorio | Login, registro, recuperación y formularios de configuración | Etiquetas, validación, errores, orden de lectura | Pendiente manual |
| Solo teclado, escritorio | Editor y vista previa de envío | Toolbar, textbox, botones, foco y cierre con Escape | Pendiente manual |
| NVDA + Firefox (Windows) | Inicio, buzón, editor, respuestas, ajustes y errores | Landmarks, encabezados, nombres, estados y anuncios sin duplicados | Pendiente manual |
| NVDA + Chrome (Windows) | Formularios y navegación entre secciones | Lectura coherente y foco tras navegación | Pendiente manual |
| VoiceOver + Safari (macOS/iOS) | Navegación, menú móvil, editor y diálogos | Rotor, agrupación, foco al abrir/cerrar y controles táctiles | Pendiente manual |
| TalkBack + Chrome (Android) | Buzón, carta, editor y enviar | Orden de lectura, áreas táctiles y panel oculto no enfocable | Pendiente manual |
| Zoom 200 % y reflow 320 CSS px | Editor, listas, notificaciones, ajustes | Sin pérdida de contenido/función ni desplazamiento horizontal no esencial | Pendiente manual |
| Contraste manual | Texto, placeholders, bordes, foco, hover, disabled, error y selección | Verificar pares reales de primer plano/fondo en ambos temas | Pendiente manual |

Las pruebas de lectores de pantalla no se ejecutan en GitHub Actions: requieren tecnologías de asistencia y sistemas operativos reales. No se afirma que NVDA, VoiceOver o TalkBack hayan sido probados por esta entrega.

## Límites conocidos

- axe-core detecta muchos problemas A/AA, pero no puede determinar por completo si el orden de lectura, la redacción de instrucciones, el contexto o el comportamiento son adecuados.
- Los fixtures automatizados cubren las pantallas enumeradas; cada modal, estado de error, selección, papelera y contenido de conversación requiere fixtures adicionales o pruebas manuales.
- Los cambios de color de `tools/contrast-audit.mjs` son una revisión de paleta; no certifican cada píxel de la aplicación.

## Ejecución local

```bash
npm ci
npm run check:contrast
npx playwright install chromium
npm run test:a11y
```

Para ejecutar toda la matriz de recorridos de navegador con datos de prueba aislados:

```bash
npm run test:e2e
```

La identificación discreta de la barra superior utiliza el color secundario del tema; su contraste se comprueba automáticamente en ambos temas (mínimo 4,5:1).
