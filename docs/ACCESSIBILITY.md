# Accesibilidad y gestión del enfoque

Esta guía describe los controles de accesibilidad incluidos en la interfaz. Es una lista de implementación y de validación manual; no sustituye una auditoría WCAG completa ni implica que se hayan ejecutado pruebas físicas con lectores de pantalla.

## Estructura y anuncios

- `#app` es el contenedor de la interfaz y **no** es una región viva. Reemplazar una vista completa no provoca que un lector de pantalla intente anunciar toda la aplicación.
- `#app-announcer` es una región `status` (`aria-live="polite"`) para confirmaciones e información.
- `#app-alert-announcer` es una región `alert` (`aria-live="assertive"`) para errores que requieren atención.
- Los avisos visuales son grupos normales, no regiones vivas adicionales. `showToast` envía un único texto breve a la región adecuada.
- Las vistas autenticadas incluyen un enlace para saltar al contenido, una navegación principal con nombre accesible y un encabezado de página enfocable.
- La ruta activa se identifica con `aria-current="page"`.

## Gestión del enfoque

- Al navegar a otra sección desde la navegación, el foco se coloca en el encabezado principal de esa sección.
- La navegación móvil cerrada se marca como `inert` y `aria-hidden`; al abrirla, el contenido principal queda temporalmente inerte y el foco pasa al botón de cierre.
- Al cerrar el menú se restaura el foco al control «Abrir menú». La tecla Escape cierra el menú.
- Si se cambia el tamaño de la ventana mientras el foco está dentro del panel que va a quedar inerte, se traslada primero a un control que permanece disponible.
- El diálogo para revisar el envío de una carta limita el recorrido de Tab, responde a Escape, oculta/inactiva la aplicación de fondo y devuelve el foco al control que lo abrió.
- Los diálogos de confirmación utilizan el mismo patrón de foco y teclado.

## Formularios y editor

- Los campos tienen etiquetas asociadas; los botones de envío declaran `type="submit"` y las acciones auxiliares `type="button"`.
- Se conservan la validación nativa de HTML (`required`, `minlength`, `pattern`, `type="email"`) y los mensajes de error con `role="alert"`.
- El editor enriquecido se presenta como un `textbox` multilínea con nombre y descripción accesibles.
- La barra de formato contiene botones con nombres accesibles. Cada botón se puede alcanzar con Tab y activar con Enter o Espacio.

## Contraste, controles y movimiento

- Se oscurecieron tonos secundarios de la interfaz clara y los textos de marcador de posición para mejorar su legibilidad.
- Los controles del área principal y la navegación móvil alcanzan un área táctil mínima de 44 × 44 CSS px en dispositivos con puntero grueso, sin ampliar artificialmente todos los botones pequeños de escritorio.
- Los indicadores de foco son visibles y no dependen solo del color de fondo.
- Las transiciones y animaciones decorativas se reducen cuando `prefers-reduced-motion: reduce` está activo.

Los cambios de color son una mejora dirigida, no una certificación de contraste de cada combinación de texto, borde, estado y tema. Para una auditoría formal deben medirse los pares reales de primer plano y fondo, incluidos hover, disabled, error y foco, en ambos temas.

## Matriz de pruebas manuales recomendada

| Entorno | Recorrido | Resultado que debe comprobarse |
|---|---|---|
| Teclado, escritorio | Tab / Shift+Tab desde login hasta el último control | Orden lógico, foco visible, sin trampas fuera de diálogos |
| Teclado, escritorio | Saltar al contenido y navegar entre secciones | El enlace de salto funciona y cada cambio mueve el foco al encabezado |
| Teclado, escritorio | Crear cuenta, recuperar acceso y guardar preferencias | Campos etiquetados, validación nativa, errores anunciados |
| Teclado, escritorio | Abrir y cerrar la vista previa de envío | Tab queda dentro del diálogo; Escape cierra; foco vuelve al disparador |
| NVDA + Firefox (Windows) | Inicio, buzón, editor, respuestas, configuración y errores | Landmarks, encabezados, nombres de controles y avisos no duplicados |
| NVDA + Chrome (Windows) | Navegar y operar los formularios | Lectura coherente de etiquetas, estados, botones y errores |
| VoiceOver + Safari (macOS/iOS) | Navegación principal, menú móvil y editor | Rotor/landmarks, foco al abrir/cerrar menú y controles táctiles |
| TalkBack + Chrome (Android) | Navegar, abrir cartas y enviar | Orden de lectura, áreas táctiles y ausencia de foco en el panel oculto |

**Estado de esta entrega:** se ejecutan comprobaciones automáticas de estructura y contrato. No se dispone de un entorno de lector de pantalla ni de dispositivos físicos en el proceso de empaquetado; por eso las filas NVDA, VoiceOver y TalkBack quedan pendientes de validación manual antes de declarar conformidad completa.
