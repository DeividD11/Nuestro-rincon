import { APP_CONFIG } from '../config/app-config.js';

export function escapeHtml(value = '') {
  return String(value).replace(/[&<>"']/g, char => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[char]);
}

const ALLOWED_TAGS = new Set(['P', 'DIV', 'BR', 'STRONG', 'B', 'EM', 'I', 'U', 'UL', 'OL', 'LI', 'BLOCKQUOTE', 'IMG']);
const ALLOWED_ALIGN = new Set(['left', 'center', 'right', 'justify']);

/** Convierte HTML del editor en una lista blanca antes de mostrarlo o enviarlo. */
export function sanitizeRichHtml(html = '') {
  const parser = new DOMParser();
  const document = parser.parseFromString(`<body>${String(html)}</body>`, 'text/html');
  const cleanNode = node => {
    if (node.nodeType === Node.TEXT_NODE) return document.createTextNode(node.nodeValue || '');
    if (node.nodeType !== Node.ELEMENT_NODE) return document.createDocumentFragment();
    // El placeholder temporal de carga no forma parte del contenido persistido.
    // Se elimina completo (incluido su texto) al guardar mientras sube el archivo.
    if (node.hasAttribute?.('data-letter-image-uploading')) return document.createDocumentFragment();
    const tag = node.tagName.toUpperCase();
    const fragment = document.createDocumentFragment();
    if (!ALLOWED_TAGS.has(tag)) {
      [...node.childNodes].forEach(child => fragment.append(cleanNode(child)));
      return fragment;
    }
    const clean = document.createElement(tag.toLowerCase());
    if (tag === 'IMG') {
      const path = String(node.getAttribute('data-image-path') || '');
      // No mostrar ni persistir nombres locales de archivos como texto alternativo.
      const alt = 'Imagen adjunta';
      if (!/^letters\/[0-9a-f-]{36}\/[0-9a-f-]{36}\/[0-9a-f-]{36}\.(?:jpg|jpeg|png|webp)$/i.test(path)) return fragment;
      clean.setAttribute('data-image-path', path);
      clean.setAttribute('alt', alt || 'Imagen adjunta');
      const source = String(node.getAttribute('src') || '');
      if (source.startsWith('blob:')) {
        clean.setAttribute('src', source);
      } else {
        try {
          const url = new URL(source);
          const origin = new URL(APP_CONFIG.supabaseUrl).origin;
          if (url.origin === origin && url.pathname.startsWith('/storage/v1/object/sign/private-media/')) clean.setAttribute('src', url.href);
        } catch { /* La imagen se vuelve a firmar al abrir la carta. */ }
      }
      clean.setAttribute('loading', 'lazy');
      clean.setAttribute('decoding', 'async');
      fragment.append(clean);
      return fragment;
    }
    if (node.hasAttribute('style')) {
      const align = node.style.textAlign.toLowerCase();
      if (ALLOWED_ALIGN.has(align)) clean.style.textAlign = align;
    }
    [...node.childNodes].forEach(child => clean.append(cleanNode(child)));
    fragment.append(clean);
    return fragment;
  };
  const result = document.createElement('div');
  [...document.body.childNodes].forEach(child => result.append(cleanNode(child)));
  return result.innerHTML;
}

export function plainTextFromHtml(html = '') {
  const doc = new DOMParser().parseFromString(sanitizeRichHtml(html), 'text/html');
  return (doc.body.textContent || '').replace(/\u00a0/g, ' ').trim();
}

let activeConfirmDialog = null;
let dialogSequence = 0;

/**
 * Muestra una confirmación accesible y coherente con el diseño de la aplicación.
 * Devuelve true solo cuando la persona activa el botón de confirmación.
 */
export function showConfirmDialog({
  title = '¿Confirmar acción?',
  message = '',
  detail = '',
  confirmLabel = 'Confirmar',
  cancelLabel = 'Cancelar',
  tone = 'neutral',
  icon
} = {}) {
  if (typeof document === 'undefined' || !document.body) return Promise.resolve(false);
  if (activeConfirmDialog) return Promise.resolve(false);

  const safeTone = ['danger', 'warning', 'success', 'neutral'].includes(tone) ? tone : 'neutral';
  const sequence = ++dialogSequence;
  const titleId = `app-confirm-title-${sequence}`;
  const messageId = `app-confirm-message-${sequence}`;
  const detailId = detail ? `app-confirm-detail-${sequence}` : '';
  const previousFocus = document.activeElement;
  const appSurface = document.querySelector('.app-root');
  const previousAriaHidden = appSurface?.getAttribute('aria-hidden');
  const previousOverflow = document.body.style.overflow;
  const previousPosition = document.body.style.position;
  const previousTop = document.body.style.top;
  const previousWidth = document.body.style.width;
  const previousHtmlOverflow = document.documentElement.style.overflow;
  const scrollY = window.scrollY || window.pageYOffset || 0;

  const backdrop = document.createElement('div');
  backdrop.className = 'nr-dialog-backdrop';
  backdrop.dataset.tone = safeTone;

  const dialog = document.createElement('section');
  dialog.className = 'nr-dialog';
  dialog.setAttribute('role', safeTone === 'danger' ? 'alertdialog' : 'dialog');
  dialog.setAttribute('aria-modal', 'true');
  dialog.setAttribute('aria-labelledby', titleId);
  dialog.setAttribute('aria-describedby', detail ? `${messageId} ${detailId}` : messageId);

  const header = document.createElement('div');
  header.className = 'nr-dialog-header';
  const iconNode = document.createElement('span');
  iconNode.className = 'nr-dialog-icon';
  iconNode.setAttribute('aria-hidden', 'true');
  iconNode.textContent = icon || ({ danger: '!', warning: '!', success: '✓', neutral: '?' }[safeTone]);

  const copy = document.createElement('div');
  copy.className = 'nr-dialog-copy';
  const heading = document.createElement('h2');
  heading.id = titleId;
  heading.textContent = title;
  const messageNode = document.createElement('p');
  messageNode.id = messageId;
  messageNode.className = 'nr-dialog-message';
  messageNode.textContent = message;
  copy.append(heading, messageNode);
  header.append(iconNode, copy);

  dialog.append(header);
  if (detail) {
    const detailNode = document.createElement('p');
    detailNode.id = detailId;
    detailNode.className = 'nr-dialog-detail';
    detailNode.textContent = detail;
    dialog.append(detailNode);
  }

  const actions = document.createElement('div');
  actions.className = 'nr-dialog-actions';
  const cancelButton = document.createElement('button');
  cancelButton.type = 'button';
  cancelButton.className = 'btn btn-ghost nr-dialog-cancel';
  cancelButton.textContent = cancelLabel;
  const confirmButton = document.createElement('button');
  confirmButton.type = 'button';
  confirmButton.className = `btn nr-dialog-confirm nr-dialog-confirm-${safeTone}`;
  confirmButton.textContent = confirmLabel;
  actions.append(cancelButton, confirmButton);
  dialog.append(actions);
  backdrop.append(dialog);

  document.documentElement.style.overflow = 'hidden';
  document.documentElement.classList.add('modal-open');
  document.body.style.position = 'fixed';
  document.body.style.top = `-${scrollY}px`;
  document.body.style.width = '100%';
  document.body.style.overflow = 'hidden';
  backdrop.addEventListener('touchmove', event => { if (!event.target?.closest?.('.nr-dialog')) event.preventDefault(); }, { passive: false });
  backdrop.addEventListener('wheel', event => { if (!event.target?.closest?.('.nr-dialog')) event.preventDefault(); }, { passive: false });
  appSurface?.setAttribute('aria-hidden', 'true');
  document.body.append(backdrop);

  let settle;
  const promise = new Promise(resolve => { settle = resolve; });
  let closed = false;

  const cleanup = result => {
    if (closed) return;
    closed = true;
    document.removeEventListener('keydown', onKeyDown, true);
    backdrop.removeEventListener('click', onBackdropClick);
    cancelButton.removeEventListener('click', onCancel);
    confirmButton.removeEventListener('click', onConfirm);
    backdrop.remove();
    document.documentElement.classList.remove('modal-open');
    document.documentElement.style.overflow = previousHtmlOverflow;
    document.body.style.overflow = previousOverflow;
    document.body.style.position = previousPosition;
    document.body.style.top = previousTop;
    document.body.style.width = previousWidth;
    // Restaurar sin animación: el documento global usa scroll-behavior:smooth.
    // La restauración de un diálogo no debe animar la página por detrás.
    window.scrollTo({ left: 0, top: scrollY, behavior: 'instant' });
    if (appSurface) {
      if (previousAriaHidden === null) appSurface.removeAttribute('aria-hidden');
      else appSurface.setAttribute('aria-hidden', previousAriaHidden);
    }
    activeConfirmDialog = null;
    if (previousFocus?.isConnected && typeof previousFocus.focus === 'function') {
      previousFocus.focus({ preventScroll: true });
    }
    settle(result);
  };

  const onCancel = () => cleanup(false);
  const onConfirm = () => cleanup(true);
  const onBackdropClick = event => {
    if (event.target === backdrop) cleanup(false);
  };
  const onKeyDown = event => {
    if (event.key === 'Escape') {
      event.preventDefault();
      cleanup(false);
      return;
    }
    if (event.key !== 'Tab') return;
    const focusable = [...dialog.querySelectorAll('button:not([disabled])')];
    const first = focusable[0];
    const last = focusable.at(-1);
    if (!first || !last) return;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  cancelButton.addEventListener('click', onCancel);
  confirmButton.addEventListener('click', onConfirm);
  backdrop.addEventListener('click', onBackdropClick);
  document.addEventListener('keydown', onKeyDown, true);
  activeConfirmDialog = { promise, close: cleanup };
  cancelButton.focus({ preventScroll: true });
  return promise;
}

const TOAST_META = Object.freeze({
  loading: { title: 'Procesando', icon: '' },
  success: { title: 'Listo', icon: '✓' },
  error: { title: 'No se pudo completar', icon: '!' },
  info: { title: 'Aviso', icon: 'i' }
});

function announceToast(message, safeType) {
  const meta = TOAST_META[safeType] || TOAST_META.info;
  const announcement = `${meta.title}. ${String(message ?? '')}`.trim();
  const announcerId = safeType === 'error' ? 'app-alert-announcer' : 'app-announcer';
  let announcer = document.getElementById(announcerId);
  if (!announcer) {
    announcer = document.createElement('div');
    announcer.id = announcerId;
    announcer.className = 'sr-only';
    announcer.setAttribute('role', safeType === 'error' ? 'alert' : 'status');
    announcer.setAttribute('aria-live', safeType === 'error' ? 'assertive' : 'polite');
    announcer.setAttribute('aria-atomic', 'true');
    document.body.append(announcer);
  }
  if (announcer._announceTimer) window.clearTimeout(announcer._announceTimer);
  announcer.textContent = '';
  announcer._announceTimer = window.setTimeout(() => {
    announcer.textContent = announcement;
    announcer._announceTimer = null;
  }, 25);
}

/** Presenta avisos breves, descartables y compatibles con lectores de pantalla. */
export function showToast(message, type = 'info', options = {}) {
  const safeType = Object.hasOwn(TOAST_META, type) ? type : 'info';
  let region = document.querySelector('.toast-region');
  if (!region) {
    region = document.createElement('div');
    region.className = 'toast-region';
    region.setAttribute('role', 'region');
    region.setAttribute('aria-label', 'Avisos de la aplicación');
    document.body.append(region);
  }

  const toast = document.createElement('article');
  toast.className = `toast app-toast toast-${safeType}`;
  toast.setAttribute('role', 'group');
  const iconNode = document.createElement('span');
  iconNode.className = 'toast-icon';
  iconNode.setAttribute('aria-hidden', 'true');
  const content = document.createElement('div');
  content.className = 'toast-content';
  const titleNode = document.createElement('strong');
  const messageNode = document.createElement('p');
  content.append(titleNode, messageNode);
  const closeButton = document.createElement('button');
  closeButton.type = 'button';
  closeButton.className = 'toast-close';
  closeButton.setAttribute('aria-label', 'Cerrar aviso');
  closeButton.textContent = '×';
  toast.append(iconNode, content, closeButton);
  region.append(toast);

  let timer = null;
  let dismissed = false;
  const dismiss = () => {
    if (dismissed) return;
    dismissed = true;
    if (timer !== null) window.clearTimeout(timer);
    timer = null;
    toast.remove();
  };
  const update = (nextMessage, nextType = 'info', nextOptions = {}) => {
    if (dismissed) return toast;
    const nextSafeType = Object.hasOwn(TOAST_META, nextType) ? nextType : 'info';
    const meta = TOAST_META[nextSafeType];
    const announcement = `${meta.title}. ${String(nextMessage ?? '')}`.trim();
    toast.className = `toast app-toast toast-${nextSafeType}`;
    toast.dataset.toastState = nextSafeType;
    toast.setAttribute('aria-label', announcement);
    titleNode.textContent = meta.title;
    messageNode.textContent = String(nextMessage ?? '');
    iconNode.textContent = meta.icon;
    announceToast(nextMessage, nextSafeType);
    if (timer !== null) window.clearTimeout(timer);
    timer = null;
    if (nextSafeType !== 'loading' && nextOptions.persistent !== true) {
      const duration = Math.max(1800, Math.min(Number(nextOptions.duration) || 4600, 10000));
      timer = window.setTimeout(dismiss, duration);
    }
    return toast;
  };
  toast.update = update;
  toast.dismiss = dismiss;
  closeButton.addEventListener('click', dismiss, { once: true });
  toast.addEventListener('mouseenter', () => {
    if (timer !== null) window.clearTimeout(timer);
    timer = null;
  }, { once: true });
  toast.addEventListener('mouseleave', () => {
    if (toast.isConnected && !dismissed && toast.dataset.toastState !== 'loading') {
      timer = window.setTimeout(dismiss, 1200);
    }
  });
  update(message, safeType, options);
  return toast;
}

/** Crea un único aviso de proceso que se transforma en éxito o error al terminar la acción. */
export function beginActionToast(message, options = {}) {
  const toast = showToast(message, 'loading', { ...options, persistent: true });
  let settled = false;
  return {
    toast,
    update(nextMessage) {
      if (!settled) toast.update(nextMessage, 'loading', { persistent: true });
      return this;
    },
    success(nextMessage, nextOptions = {}) {
      if (settled) return this;
      settled = true;
      toast.update(nextMessage, 'success', nextOptions);
      return this;
    },
    error(nextMessage, nextOptions = {}) {
      if (settled) return this;
      settled = true;
      toast.update(nextMessage, 'error', nextOptions);
      return this;
    },
    info(nextMessage, nextOptions = {}) {
      if (settled) return this;
      settled = true;
      toast.update(nextMessage, 'info', nextOptions);
      return this;
    },
    dismiss() {
      settled = true;
      toast.dismiss();
      return this;
    }
  };
}
