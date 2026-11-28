import { sanitizeRichHtml } from './dom.js';

/**
 * Prepara imágenes privadas de solo lectura sin mostrar el nombre del archivo.
 * La autorización y la firma de cada URL ocurren antes, en letters-api.
 */
export function renderLetterBodyHtml(html = '', options = {}) {
  const showPlaceholder = options.showPlaceholder !== false;
  const eagerImages = options.eagerImages === true;
  const doc = new DOMParser().parseFromString(sanitizeRichHtml(html), 'text/html');
  const images = [...doc.body.querySelectorAll('img[data-image-path]')];
  images.forEach((image, index) => {
    const parent = image.parentNode;
    if (!parent) return;
    const frame = doc.createElement('span');
    frame.className = 'letter-image-frame';
    frame.setAttribute('role', 'group');
    frame.setAttribute('aria-label', `Imagen adjunta${images.length > 1 ? ` ${index + 1}` : ''}`);
    const placeholder = showPlaceholder ? doc.createElement('span') : null;
    if (placeholder) {
      placeholder.className = 'letter-image-placeholder';
      placeholder.setAttribute('aria-hidden', 'true');
      placeholder.innerHTML = '<span class="letter-image-placeholder-icon">▧</span><span class="letter-image-placeholder-label">Cargando imagen…</span>';
    }
    image.setAttribute('alt', '');
    image.setAttribute('loading', eagerImages || index === 0 ? 'eager' : 'lazy');
    image.setAttribute('decoding', eagerImages ? 'sync' : 'async');
    if (eagerImages || index === 0) image.setAttribute('fetchpriority', 'high');
    const hasSource = Boolean(image.getAttribute('src'));
    // La URL privada puede llegar después de hidratar el borrador. Hasta entonces
    // mantenemos el placeholder de carga; no mostramos un error prematuro.
    frame.classList.add('is-loading');
    if (!hasSource) frame.classList.add('is-pending-source');
    parent.replaceChild(frame, image);
    if (placeholder) frame.append(placeholder);
    if (hasSource) frame.append(image);
  });
  return doc.body.innerHTML;
}

/** El editor conserva las imágenes como nodos editables, pero nunca muestra el filename. */
export function renderEditorBodyHtml(html = '') {
  const doc = new DOMParser().parseFromString(sanitizeRichHtml(html), 'text/html');
  const images = [...doc.body.querySelectorAll('img[data-image-path]')];
  images.forEach((image, index) => {
    image.setAttribute('alt', '');
    image.classList.add('letter-editor-image', 'is-loading');
    image.setAttribute('loading', index === 0 ? 'eager' : 'lazy');
    image.setAttribute('decoding', 'async');
    if (index === 0) image.setAttribute('fetchpriority', 'high');
  });
  return doc.body.innerHTML;
}

/** Conecta eventos de carga para una previsualización que se monta fuera del root principal. */
export function bindLetterImageLoading(root) {
  const onLoad = event => {
    const image = event.target;
    if (!(image instanceof HTMLImageElement)) return;
    const frame = image.closest('.letter-image-frame');
    frame?.classList.remove('is-loading', 'is-error', 'is-pending-source');
    frame?.querySelector('.letter-image-placeholder')?.remove();
    if (image.classList.contains('letter-editor-image')) image.classList.remove('is-loading', 'is-error');
  };
  const onError = event => {
    const image = event.target;
    if (!(image instanceof HTMLImageElement)) return;
    const frame = image.closest('.letter-image-frame');
    if (frame) {
      image.remove();
      frame.classList.remove('is-loading');
      frame.classList.add('is-error');
      const label = frame.querySelector('.letter-image-placeholder-label');
      if (label) label.textContent = 'Imagen no disponible';
      return;
    }
    if (image.classList.contains('letter-editor-image')) {
      image.classList.remove('is-loading');
      image.classList.add('is-error');
    }
  };
  root.addEventListener('load', onLoad, true);
  root.addEventListener('error', onError, true);
  return () => {
    root.removeEventListener('load', onLoad, true);
    root.removeEventListener('error', onError, true);
  };
}
