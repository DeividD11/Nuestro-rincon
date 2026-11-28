import { showToast } from '../utils/dom.js';
import { readPendingRecovery } from '../services/recovery-handoff.js';
import { handleSubmit } from './app-submit-handler.js';
import { handleClick } from './app-click-handler.js';
import { APP_CONFIG } from '../config/app-config.js';

export class AppEventCoordinatorController {
  bindEvents() {
    this.root.addEventListener('click', event => this.onClick(event));
    this.root.addEventListener('submit', event => this.onSubmit(event));
    this.root.addEventListener('input', event => this.onInput(event));
    this.root.addEventListener('load', event => {
      const image = event.target;
      if (!(image instanceof HTMLImageElement)) return;
      const avatarContainer = image.closest('.profile-avatar-preview.has-image.is-loading, .user-mini .avatar.has-image.is-loading');
      if (avatarContainer) {
        const revealAvatar = () => {
          if (image.isConnected && avatarContainer.isConnected && image.naturalWidth > 0) {
            avatarContainer.classList.remove('is-loading');
          }
        };
        if (typeof image.decode === 'function') image.decode().then(revealAvatar).catch(() => {
          if (image.complete && image.naturalWidth > 0) revealAvatar();
        });
        else revealAvatar();
      }
      const stamp = image.closest('.letter-stamp.has-image.is-loading');
      if (stamp) {
        const revealStampImage = () => {
          if (image.isConnected && stamp.isConnected && image.naturalWidth > 0) {
            stamp.classList.remove('is-loading', 'is-pending-source');
          }
        };
        if (typeof image.decode === 'function') image.decode().then(revealStampImage).catch(() => {
          if (image.complete && image.naturalWidth > 0) revealStampImage();
        });
        else revealStampImage();
      }
      const loadedFrame = image.closest('.letter-image-frame.is-loading');
      loadedFrame?.classList.remove('is-loading', 'is-pending-source');
      if (image.classList.contains('letter-editor-image')) image.classList.remove('is-loading', 'is-error');
    }, true);
    // Si una URL privada caduca o una imagen deja de estar disponible, retirar
    // el <img> deja visible el placeholder/icono en vez del icono roto del navegador.
    this.root.addEventListener('error', event => {
      const image = event.target;
      if (!(image instanceof HTMLImageElement)) return;
      if (image.classList.contains('letter-editor-image')) {
        image.classList.remove('is-loading');
        image.classList.add('is-error');
        return;
      }
      const letterImageFrame = image.closest('.letter-image-frame');
      if (letterImageFrame) {
        image.remove();
        letterImageFrame.classList.remove('is-loading');
        letterImageFrame.classList.add('is-error');
        const label = letterImageFrame.querySelector('.letter-image-placeholder-label');
        if (label) label.textContent = 'Imagen no disponible';
        return;
      }
      const stamp = image.closest('.letter-stamp.has-image');
      if (stamp) {
        void this.fallbackLetterStampImage(image, stamp);
        return;
      }
      const avatarContainer = image.closest('.profile-avatar-preview.has-image, .user-mini .avatar.has-image');
      if (avatarContainer) {
        const isSidebarAvatar = avatarContainer.matches('.user-mini .avatar');
        image.remove();
        avatarContainer.classList.remove('has-image', 'is-loading');
        const placeholder = avatarContainer.querySelector('.avatar-preview-placeholder, .avatar-image-placeholder');
        if (placeholder) placeholder.style.opacity = '1';
        // Una URL firmada puede caducar o haber fallado al generarse. Solicitar
        // una firma nueva una sola vez por ruta privada, sin dejar el avatar
        // permanentemente reducido a las iniciales.
        const failedPath = String(this.state.profile?.avatarPath || '');
        if (isSidebarAvatar && failedPath && this._avatarRefreshAttemptedPath !== failedPath) {
          this._avatarRefreshAttemptedPath = failedPath;
          this.loadPreferencesInBackground?.().catch(() => {});
        }
      }
    }, true);
    this.hydrateLetterStampPreviews();
    this.observeLetterBodyImages();
    this.root.addEventListener('pointerdown', event => {
      if (!event.target?.closest?.('#settings-theme')) return;
      this._themePointerOrigin = { x: event.clientX, y: event.clientY, at: Date.now() };
    }, true);
    this.root.addEventListener('change', event => {
      if (event.target?.id === 'settings-theme') this.changeThemePreference(event.target.value, event).catch(() => {});
      if (event.target?.id === 'recovery-vault-code-select') {
        const input = this.root.querySelector('#recovery-code');
        if (input) input.value = event.target.value;
      }
      if (event.target?.id === 'letter-image-input') {
        const files = [...(event.target.files || [])];
        event.target.value = '';
        files.slice(0, 6).reduce((chain, file) => chain.then(() => this.addLetterImage(file)), Promise.resolve())
          .catch(error => { if (!error?.actionFeedbackShown) showToast(error.message || 'No se pudo adjuntar la imagen.', 'error'); });
      }
      if (event.target?.id === 'profile-avatar-input' && event.target.files?.[0]) {
        const file = event.target.files[0]; event.target.value = '';
        this.uploadProfileAvatar(file).catch(error => {
          if (!error?.actionFeedbackShown) showToast(error.message || 'No se pudo actualizar el avatar.', 'error');
        });
      }
    });
    document.addEventListener('keydown', event => {
      if (event.key !== 'Escape' || !this.state.mobileNavOpen) return;
      this.state.mobileNavOpen = false;
      this.render();
      this.root.querySelector('.mobile-menu')?.focus?.({ preventScroll: true });
    });
    window.addEventListener('resize', () => this.syncResponsiveAccessibility());
    // Calienta la sección mientras el usuario apunta o enfoca un enlace del menú.
    this.root.addEventListener('pointerover', event => {
      if (event.pointerType && event.pointerType !== 'mouse') return;
      const target = event.target.closest?.('[data-route]');
      if (target) this.prefetchRoute(target.dataset.route);
    });
    this.root.addEventListener('pointerdown', event => {
      const target = event.target.closest?.('[data-route]');
      if (target) this.prefetchRoute(target.dataset.route);
    });
    this.root.addEventListener('focusin', event => {
      const target = event.target.closest?.('[data-route]');
      if (target) this.prefetchRoute(target.dataset.route);
    });
    this.systemThemeMedia?.addEventListener?.('change', () => {
      if (this.state.settings.theme === 'system') this.applyTheme('system', { cache: !this._themePreferenceDirty });
    });
    window.addEventListener('hashchange', () => {
      if (readPendingRecovery()) return;
      const route = this.routeFromHash();
      if (route && this.session.user) this.openRoute(route, false, { focus: true });
    });
    window.addEventListener('online', () => {
      if (readPendingRecovery()) return;
      this.sessionPoller?.wake();
      this.notificationPoller?.wake();
      if (this.state.editor) this.saveDraft(true).catch(() => {});
      this.syncPendingLocalDrafts().catch(() => {});
      showToast('Conexión restablecida. Se intentará sincronizar el borrador.', 'success');
    });
    window.addEventListener('pagehide', () => this.flushDraftOnExit());
    window.addEventListener('beforeunload', () => this.flushDraftOnExit());
    document.addEventListener('click', event => {
      if (event.target instanceof Element && event.target.closest('#confirm-modal')) this.onClick(event);
    });
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) { this.flushDraftOnExit(); return; }
      if (readPendingRecovery() || !this.session.user) return;
      this.sessionPoller?.wake();
      this.notificationPoller?.wake();
      this.syncPendingLocalDrafts().catch(() => {});
    });
    window.addEventListener('focus', () => {
      if (readPendingRecovery() || !this.session.user || !navigator.onLine) return;
      this.sessionPoller?.wake();
      this.notificationPoller?.wake();
    });
  }

  syncResponsiveAccessibility() {
    const narrow = window.matchMedia?.('(max-width: 1024px)')?.matches ?? window.innerWidth <= 1024;
    const sidebar = this.root.querySelector('.sidebar');
    const main = this.root.querySelector('#main-content');
    const trigger = this.root.querySelector('.mobile-menu');
    const closeButton = this.root.querySelector('.mobile-nav-close');
    const hideSidebar = Boolean(narrow && !this.state.mobileNavOpen);
    const hideMain = Boolean(narrow && this.state.mobileNavOpen);

    // Si el tamaño de ventana cambia mientras el foco está en el panel que
    // pasará a inert, desplázalo antes a un control que seguirá disponible.
    const active = document.activeElement;
    if (hideSidebar && sidebar?.contains?.(active)) {
      trigger?.focus?.({ preventScroll: true });
    } else if (hideMain && main?.contains?.(active)) {
      closeButton?.focus?.({ preventScroll: true });
    } else if (!narrow && (active === trigger || active === closeButton)) {
      // Los controles del drawer dejan de mostrarse en escritorio: no dejes
      // el foco retenido en un botón que pasó a display:none.
      const activeNav = sidebar?.querySelector?.('.nav-link.active');
      if (activeNav) activeNav.focus?.({ preventScroll: true });
      else this.root.querySelector('#page-heading')?.focus?.({ preventScroll: true });
    }

    if (sidebar) {
      sidebar.toggleAttribute('inert', hideSidebar);
      if (narrow) sidebar.setAttribute('aria-hidden', String(hideSidebar));
      else sidebar.removeAttribute('aria-hidden');
    }
    if (main) {
      main.toggleAttribute('inert', hideMain);
      if (narrow) main.setAttribute('aria-hidden', String(hideMain));
      else main.removeAttribute('aria-hidden');
    }
    if (trigger) trigger.setAttribute('aria-expanded', String(Boolean(narrow && this.state.mobileNavOpen)));
  }

  async onSubmit(event) { return handleSubmit.call(this, event); }

  async onClick(event) { return handleClick.call(this, event); }

  async fallbackLetterStampImage(image, stamp) {
    let currentUrl;
    try { currentUrl = new URL(image.currentSrc || image.src); } catch { currentUrl = null; }
    const isTransformed = currentUrl?.pathname.startsWith('/storage/v1/render/image/sign/private-media/');
    const letterId = String(stamp.dataset.letterId || '');
    const path = String(stamp.dataset.imagePath || '');
    const validPath = /^letters\/([0-9a-f-]{36})\/([0-9a-f-]{36})\/([0-9a-f-]{36})\.(?:jpg|jpeg|png|webp)$/i.test(path);

    if (isTransformed && stamp.dataset.originalFallbackTried !== 'true'
      && validPath && /^[0-9a-f-]{36}$/i.test(letterId)
      && typeof this.repository?.signLetterThumbnail === 'function') {
      stamp.dataset.originalFallbackTried = 'true';
      stamp.classList.add('is-loading');
      try {
        const result = await this.repository.signLetterThumbnail({ letterId, path, optimized: false });
        const source = String(result?.signedUrl || '');
        const url = new URL(source);
        const expectedOrigin = new URL(APP_CONFIG.supabaseUrl).origin;
        if (url.protocol === 'https:' && url.origin === expectedOrigin
          && url.pathname.startsWith('/storage/v1/object/sign/private-media/')
          && image.isConnected && stamp.isConnected) {
          const key = `${letterId}:${path}`;
          this.letterStampPreviewCache ||= new Map();
          this.letterStampPreviewCache.set(key, { expiresAt: Date.now() + 22 * 60 * 60 * 1000, promise: Promise.resolve(url.href) });
          image.src = url.href;
          return;
        }
      } catch { /* Se conserva el fallback visual si tampoco está disponible el original. */ }
    }

    image.remove();
    stamp.classList.remove('has-image', 'is-loading', 'is-pending-source');
  }

  async hydrateLetterStampPreviews() {
    const stamps = [...(this.root?.querySelectorAll?.('.letter-stamp[data-letter-id][data-image-path]') || [])];
    if (!stamps.length || typeof this.repository?.signLetterImage !== 'function') return;
    this.letterStampPreviewCache ||= new Map();
    const pattern = /^letters\/([0-9a-f-]{36})\/([0-9a-f-]{36})\/([0-9a-f-]{36})\.(?:jpg|jpeg|png|webp)$/i;
    const expectedOrigin = (() => { try { return new URL(APP_CONFIG.supabaseUrl).origin; } catch { return ''; } })();

    const hydrateOne = async stamp => {
      if (!stamp.isConnected || stamp.dataset.previewRequested === 'true') return;
      if (stamp.querySelector('img') && !stamp.dataset.suspendedSrc) return;
      const suspendedSource = String(stamp.dataset.suspendedSrc || '');
      if (suspendedSource) {
        const restored = document.createElement('img');
        restored.alt = ''; restored.width = 96; restored.height = 96;
        restored.loading = 'eager'; restored.decoding = 'async'; restored.fetchPriority = 'low';
        restored.referrerPolicy = 'no-referrer';
        stamp.append(restored);
        stamp.classList.add('has-image', 'is-loading');
        stamp.classList.remove('is-pending-source');
        stamp.dataset.previewRequested = 'true';
        delete stamp.dataset.suspendedSrc;
        restored.src = suspendedSource;
        return;
      }
      const letterId = String(stamp.dataset.letterId || '');
      const path = String(stamp.dataset.imagePath || '');
      const match = path.match(pattern);
      const allowedBaseIds = [letterId, String(stamp.dataset.replyToLetterId || '')].filter(Boolean);
      if (!match || !allowedBaseIds.includes(match[1]) || !/^[0-9a-f-]{36}$/i.test(letterId)) {
        stamp.classList.remove('has-image', 'is-loading', 'is-pending-source');
        stamp.querySelector('img')?.remove();
        return;
      }
      stamp.dataset.previewRequested = 'true';
      const key = `${letterId}:${path}`;
      let entry = this.letterStampPreviewCache.get(key);
      if (!entry || entry.expiresAt <= Date.now()) {
        entry = { expiresAt: Date.now() + 30_000, promise: null };
        entry.promise = Promise.resolve().then(async () => {
          const payload = { letterId, path };
          let result;
          if (typeof this.repository.signLetterThumbnail === 'function') {
            try { result = await this.repository.signLetterThumbnail(payload); }
            catch {
              try { result = await this.repository.signLetterThumbnail({ ...payload, optimized: false }); }
              catch { result = await this.repository.signLetterImage(payload); }
            }
          } else result = await this.repository.signLetterImage(payload);
          const source = String(result?.signedUrl || '');
          const url = new URL(source);
          const allowedPath = url.pathname.startsWith('/storage/v1/object/sign/private-media/')
            || url.pathname.startsWith('/storage/v1/render/image/sign/private-media/');
          if (!expectedOrigin || url.protocol !== 'https:' || url.origin !== expectedOrigin || !allowedPath) return '';
          entry.expiresAt = Date.now() + 22 * 60 * 60 * 1000;
          return url.href;
        }).catch(() => '');
        this.letterStampPreviewCache.set(key, entry);
      }
      const source = await entry.promise;
      if (!stamp.isConnected) return;
      if (!source) {
        stamp.dataset.previewRequested = 'false';
        stamp.classList.add('is-pending-source', 'is-loading');
        return;
      }
      const image = document.createElement('img');
      image.alt = '';
      image.width = 96;
      image.height = 96;
      image.loading = 'lazy';
      image.decoding = 'async';
      image.fetchPriority = 'low';
      image.referrerPolicy = 'no-referrer';
      stamp.append(image);
      image.src = source;
    };

    // Los sellos se observan durante toda su vida: al salir del viewport se
    // libera el bitmap y al volver a entrar se restaura la URL privada.
    if (typeof IntersectionObserver === 'function') {
      if (!this.letterStampPreviewObserver) {
        this.letterStampPreviewObserver = new IntersectionObserver(entries => {
          for (const entry of entries) {
            const stamp = entry.target;
            if (entry.isIntersecting) {
              stamp.dataset.previewVisible = 'true';
              if (stamp.dataset.previewQueued === 'true' || stamp.dataset.previewRequested === 'true') continue;
              stamp.dataset.previewQueued = 'true';
              this.letterStampPreviewQueue ||= [];
              this.letterStampPreviewQueue.push({ stamp, hydrate: hydrateOne });
              continue;
            }
            if (stamp.dataset.previewVisible !== 'true') continue;
            const image = stamp.querySelector('img');
            if (image) {
              const source = image.currentSrc || image.src || '';
              if (source) stamp.dataset.suspendedSrc = source;
              image.remove();
            }
            stamp.dataset.previewRequested = 'false';
            stamp.dataset.previewQueued = 'false';
            stamp.classList.add('has-image', 'is-loading', 'is-pending-source');
          }
          this.drainLetterStampPreviewQueue();
        }, { root: null, rootMargin: '120px 0px', threshold: 0.01 });
      }
      for (const stamp of stamps) {
        if (stamp.dataset.previewObserved === 'true') continue;
        stamp.dataset.previewObserved = 'true';
        this.letterStampPreviewObserver.observe(stamp);
      }
      if (!this.letterStampMutationObserver && this.root && typeof MutationObserver === 'function') {
        this.letterStampMutationObserver = new MutationObserver(() => queueMicrotask(() => this.hydrateLetterStampPreviews()));
        this.letterStampMutationObserver.observe(this.root, { childList: true, subtree: true });
      }
      return;
    }

    // Compatibilidad con navegadores sin IntersectionObserver: carga diferida
    // por lotes pequeños para no bloquear la apertura del apartado.
    this.letterStampPreviewQueue ||= [];
    for (const stamp of stamps) {
      if (stamp.dataset.previewQueued === 'true' || stamp.dataset.previewRequested === 'true') continue;
      stamp.dataset.previewQueued = 'true';
      this.letterStampPreviewQueue.push({ stamp, hydrate: hydrateOne });
    }
    this.drainLetterStampPreviewQueue();
  }

  observeLetterBodyImages() {
    if (!this.root || typeof IntersectionObserver !== 'function') return;
    if (!this.letterBodyImageObserver) {
      this.letterBodyImageObserver = new IntersectionObserver(entries => {
        for (const entry of entries) {
          const image = entry.target;
          const frame = image.closest('.letter-image-frame');
          if (!frame) continue;
          if (entry.isIntersecting) {
            image.dataset.inViewport = 'true';
            const suspended = image.dataset.suspendedSrc;
            if (suspended) {
              frame.classList.add('is-loading');
              frame.classList.remove('is-error');
              const label = frame.querySelector('.letter-image-placeholder-label');
              if (label) label.textContent = 'Cargando imagen…';
              image.loading = 'eager';
              image.src = suspended;
              delete image.dataset.suspendedSrc;
            }
          } else if (image.dataset.inViewport === 'true' && image.complete && image.naturalWidth > 0) {
            const source = image.currentSrc || image.src || '';
            if (source) {
              image.dataset.suspendedSrc = source;
              image.removeAttribute('src');
              frame.classList.add('is-loading');
              frame.classList.remove('is-error');
              const label = frame.querySelector('.letter-image-placeholder-label');
              if (label) label.textContent = 'Cargando imagen…';
            }
          }
        }
      }, { root: null, rootMargin: '80px 0px', threshold: 0.01 });
    }
    const observeNewImages = () => {
      for (const image of this.root.querySelectorAll('.letter-image-frame img[data-image-path]')) {
        if (image.dataset.viewportObserved === 'true') continue;
        image.dataset.viewportObserved = 'true';
        this.letterBodyImageObserver.observe(image);
      }
    };
    observeNewImages();
    if (!this.letterBodyImageMutationObserver) {
      this.letterBodyImageMutationObserver = new MutationObserver(() => observeNewImages());
      this.letterBodyImageMutationObserver.observe(this.root, { childList: true, subtree: true });
    }
  }

  async drainLetterStampPreviewQueue() {
    if (this._drainingLetterStampPreviewQueue) return;
    this._drainingLetterStampPreviewQueue = true;
    try {
      this.letterStampPreviewQueue ||= [];
      while (this.letterStampPreviewQueue.length) {
        const batch = this.letterStampPreviewQueue.splice(0, 4);
        await Promise.all(batch.map(async task => {
          try { await task.hydrate(task.stamp); }
          finally { task.stamp.dataset.previewQueued = 'false'; }
        }));
      }
    } finally {
      this._drainingLetterStampPreviewQueue = false;
      if (this.letterStampPreviewQueue?.length) queueMicrotask(() => this.drainLetterStampPreviewQueue());
    }
  }



}
