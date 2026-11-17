import { AppState } from '../models/app-state.js';
import { AppView } from '../views/app-view.js';
import { putLocalDraft, getLocalDraft, deleteLocalDraft, getLocalDraftsForUser, deleteLocalDraftsForUser } from '../services/local-drafts.js';
import { ApiError } from '../services/api-client.js';
import { plainTextFromHtml, sanitizeRichHtml, showToast, showConfirmDialog, escapeHtml } from '../utils/dom.js';

export class AppController {
  constructor({ root, session, repository }) {
    this.root = root;
    this.session = session;
    this.repository = repository;
    this.state = new AppState();
    this.view = new AppView(root);
    this.previousListRoute = 'inbox';
    this.autosaveTimer = null;
    this.localPersistTimer = null;
    this.draftQueues = new Map();
    this.draftIdentity = new Map();
    // Un borrador descartado no debe resucitar por una sincronización pendiente.
    this.discardedDraftIds = new Set();
    this.pollTimer = null;
    this.sessionRefreshTimer = null;
    this.sessionChannel = typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel('nuestro-rincon-session-events') : null;
    if (this.sessionChannel) {
      this.sessionChannel.onmessage = event => {
        const message = event.data || {};
        if (message.type === 'session-revoked' && message.sessionId && message.sessionId === this.session?.sessionId) {
          this.forceLogout();
        }
      };
    }
    this.localDraftKey = null;
    this._lastRecoveryCode = '';
    this.routeCache = new Map();
    this.seenRoutes = new Set();
    this.routeRequestId = 0;
    this.routeCacheTtl = 60000;
    this.routePrefetches = new Map();
    this.routeCacheVersion = 0;
    this.editorInputVersion = 0;
    this.systemThemeMedia = window.matchMedia?.('(prefers-color-scheme: dark)') || null;
  }

  async init() {
    this.applyTheme(this.readLastTheme() || 'system');
    this.view.renderBoot();
    this.bindEvents();
    const restored = await this.session.restore();
    if (!restored) {
      this.view.renderLogin();
      return;
    }
    this.state.user = this.session.user;
    this.applyTheme(this.readCachedTheme() || 'system');
    this.localDraftKey = this.localDraftKeyFor('new');
    this.restoreEmergencyDraft().catch(() => {});
    await this.openRoute(this.routeFromHash() || 'home');
    this.syncPendingLocalDrafts().then(() => {
      if (this.session.user && ['home','drafts'].includes(this.state.route)) this.openRoute(this.state.route, false).catch(() => {});
    }).catch(() => {});
    this.loadPreferencesInBackground();
    this.startNotificationPolling();
    this.startSessionRefreshPolling();
  }

  bindEvents() {
    this.root.addEventListener('click', event => this.onClick(event));
    this.root.addEventListener('submit', event => this.onSubmit(event));
    this.root.addEventListener('input', event => this.onInput(event));
    this.root.addEventListener('change', event => {
      if (event.target?.id === 'settings-theme') this.applyTheme(event.target.value);
    });
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
      if (this.state.settings.theme === 'system') this.applyTheme('system');
    });
    window.addEventListener('hashchange', () => {
      const route = this.routeFromHash();
      if (route && this.session.user) this.openRoute(route, false);
    });
    window.addEventListener('online', () => {
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
      if (!this.session.user) return;
      this.checkCurrentSession().catch(() => {});
      this.refreshNotifications().catch(() => {});
      if (this.state.route === 'settings') this.refreshSessions().catch(() => {});
      this.syncPendingLocalDrafts().catch(() => {});
    });
    window.addEventListener('focus', () => {
      if (!this.session.user || !navigator.onLine) return;
      this.checkCurrentSession().catch(() => {});
      if (this.state.route === 'settings') this.refreshSessions().catch(() => {});
    });
  }

  localDraftKeyFor(key) {
    const userId = this.session?.user?.id;
    if (!userId) throw new Error('No hay una sesión activa para acceder a borradores locales.');
    return `${userId}:${key}`;
  }

  routeFromHash() {
    const match = location.hash.match(/^#\/?([a-z-]+)/i);
    return match?.[1] || null;
  }

  async openRoute(route, updateHash = true) {
    const allowed = new Set(['home','inbox','sent','write','drafts','favorites','archive','trash','letter','notifications','settings']);
    if (!allowed.has(route) || route === 'letter') route = 'home';

    // La copia local ya se actualiza en cada pulsación. Al cambiar de sección,
    // no esperamos la red: persistimos la última instantánea y sincronizamos en segundo plano.
    if (this.state.route === 'write' && route !== 'write' && this.state.editor) {
      window.clearTimeout(this.autosaveTimer);
      const snapshot = { ...this.state.editor, ...this.readEditorFromDom() };
      const storageKey = this.localDraftKey || this.localDraftKeyFor(snapshot.letterId ? `letter:${snapshot.letterId}` : 'new');
      this.state.editor = null;
      // No retrasar el cambio de sección esperando IndexedDB. La copia urgente
      // se respalda sincrónicamente y la persistencia/sincronización continúa aparte.
      this.localDraftKey = storageKey;
      this.queueDraftSync(snapshot, storageKey);
    }

    let editorHydration = null;
    if (route === 'write' && !this.state.editor) {
      if (!this.localDraftKey) this.localDraftKey = this.localDraftKeyFor('new');
      const draftKey = this.localDraftKey;
      const emergency = this.readEmergencyDraft(draftKey);
      const initialEditor = {
        letterId: null,
        creationRequestId: crypto.randomUUID(),
        title: '',
        body: '',
        revision: 1,
        parentLetterId: null,
        saving: false,
        saved: false,
        pendingSync: false
      };
      this.state.editor = emergency
        ? { ...initialEditor, ...emergency, creationRequestId: emergency.creationRequestId || initialEditor.creationRequestId }
        : initialEditor;
      editorHydration = { key: draftKey, identity: this.state.editor.creationRequestId };
    }

    if (route !== 'letter' && route !== 'write' && route !== 'notifications' && route !== 'settings') this.previousListRoute = route;
    this.state.route = route;
    this.state.routeError = null;
    this.state.routeNotice = null;
    this.state.mobileNavOpen = false;
    if (updateHash && location.hash !== `#/${route}`) history.replaceState(null, '', `#/${route}`);

    if (route === 'write') {
      this.state.routeLoading = false;
      this.render();
      if (editorHydration) this.hydrateEditorFromLocal(editorHydration.key, editorHydration.identity).catch(() => {});
      if (this.state.editor?.pendingSync || this.state.editor?.localOnly) {
        this.saveDraft(true).catch(() => {});
      }
      return;
    }

    const cacheKey = this.routeCacheKey(route);
    const cached = this.routeCache.get(cacheKey);
    const requestId = ++this.routeRequestId;
    const hasVisited = this.seenRoutes.has(route);
    this.seenRoutes.add(route);

    // Primero se muestra la última vista disponible. La red actualiza después
    // sin vaciar la página ni volver a mostrar placeholders al navegar.
    if (cached) {
      this.applyRouteData(route, cached.data);
      this.state.routeError = null;
      this.state.routeLoading = false;
      this.render();
      if (Date.now() - cached.at > this.routeCacheTtl) {
        this.refreshRouteData(route, cacheKey, requestId, true);
      }
      return;
    }

    const prefetched = this.routePrefetches.get(cacheKey);
    if (prefetched) {
      this.state.routeLoading = !hasVisited;
      this.render();
      await prefetched;
      if (requestId !== this.routeRequestId || this.state.route !== route) return;
      const ready = this.routeCache.get(cacheKey);
      if (ready) {
        this.applyRouteData(route, ready.data);
        this.state.routeError = null;
        this.state.routeLoading = false;
        this.render();
        return;
      }
    }

    this.state.routeLoading = !hasVisited;
    // En rutas ya visitadas conservamos el contenido anterior mientras llega la
    // consulta nueva. Así no parpadea una lista vacía ni reaparece el placeholder.
    this.render();
    await this.refreshRouteData(route, cacheKey, requestId, hasVisited);
  }

  routeCacheKey(route) {
    return `${route}:${['inbox','sent','drafts','favorites','archive','trash'].includes(route) ? this.state.search : ''}`;
  }

  prefetchRoute(route) {
    if (!route || route === 'write' || route === 'letter' || route === 'settings' && !this.session.user) return;
    const allowed = new Set(['home','inbox','sent','drafts','favorites','archive','trash','notifications','settings']);
    if (!allowed.has(route)) return;
    const key = this.routeCacheKey(route);
    const cached = this.routeCache.get(key);
    if (cached && Date.now() - cached.at <= this.routeCacheTtl) return;
    if (this.routePrefetches.has(key)) return;
    const cacheVersion = this.routeCacheVersion;
    const task = this.fetchRouteData(route)
      .then(data => {
        if (cacheVersion !== this.routeCacheVersion) return;
        this.routeCache.set(key, { data, at: Date.now() });
        if (this.routeCache.size > 30) this.routeCache.delete(this.routeCache.keys().next().value);
      })
      .catch(() => {})
      .finally(() => this.routePrefetches.delete(key));
    this.routePrefetches.set(key, task);
  }

  invalidateRouteCache() {
    // Conserva los datos para que la navegación siga siendo inmediata; marca
    // las vistas como caducadas y las sincroniza de nuevo al abrirlas.
    this.routeCacheVersion++;
    for (const [key, entry] of this.routeCache.entries()) {
      this.routeCache.set(key, { ...entry, at: 0 });
    }
    this.routePrefetches.clear();
  }

  async fetchRouteData(route) {
    if (route === 'home') {
      const [dashboard, notifications] = await Promise.all([
        this.repository.dashboard(),
        this.repository.notifications().catch(() => ({ items: this.state.notifications }))
      ]);
      return { dashboard, notifications };
    }
    if (['inbox','sent','drafts','favorites','archive','trash'].includes(route)) {
      return { letters: await this.repository.list(route, this.state.search) };
    }
    if (route === 'notifications') return { notifications: await this.repository.notifications() };
    if (route === 'settings') {
      const [settings, sessions] = await Promise.all([this.repository.settings(), this.repository.sessions()]);
      return { settings, sessions };
    }
    return {};
  }

  applyRouteData(route, data) {
    if (route === 'home') {
      this.state.dashboard = data.dashboard || this.state.dashboard;
      this.state.notifications = data.notifications?.items || this.state.notifications;
    } else if (['inbox','sent','drafts','favorites','archive','trash'].includes(route)) {
      this.state.letters = data.letters?.items || [];
    } else if (route === 'notifications') {
      this.state.notifications = data.notifications?.items || [];
    } else if (route === 'settings') {
      this.state.settings = { ...this.state.settings, ...(data.settings?.settings || {}) };
      this.state.sessions = data.sessions?.sessions || [];
      this.cacheTheme(this.state.settings.theme);
      this.applyTheme(this.state.settings.theme);
    }
  }

  async refreshRouteData(route, cacheKey, requestId, background) {
    const cacheVersion = this.routeCacheVersion;
    try {
      const data = await this.fetchRouteData(route);
      if (cacheVersion !== this.routeCacheVersion) return;
      this.routeCache.set(cacheKey, { data, at: Date.now() });
      if (this.routeCache.size > 30) this.routeCache.delete(this.routeCache.keys().next().value);
      if (requestId !== this.routeRequestId || this.state.route !== route) return;
      this.applyRouteData(route, data);
      this.state.routeError = null;
      this.state.routeNotice = null;
      this.state.routeLoading = false;
      this.render();
    } catch (error) {
      if (requestId !== this.routeRequestId || this.state.route !== route) return;
      this.state.routeLoading = false;
      if (error.status === 401) { this.forceLogout(); return; }
      if (background) {
        this.state.routeNotice = 'No pudimos actualizar esta sección. Se conserva la última copia disponible.';
      } else {
        this.state.routeError = error.message || 'No se pudo cargar esta sección.';
      }
      this.render();
    }
  }

  themeStorageKey() {
    return `nuestro-rincon:theme:${this.session?.user?.id || 'guest'}`;
  }

  readCachedTheme() {
    try {
      const value = localStorage.getItem(this.themeStorageKey());
      return ['light','dark','system'].includes(value) ? value : null;
    } catch { return null; }
  }

  readLastTheme() {
    try {
      const value = localStorage.getItem('nuestro-rincon:theme:last');
      return ['light','dark','system'].includes(value) ? value : null;
    } catch { return null; }
  }

  cacheTheme(theme) {
    if (!['light','dark','system'].includes(theme)) return;
    try {
      localStorage.setItem(this.themeStorageKey(), theme);
      localStorage.setItem('nuestro-rincon:theme:last', theme);
    } catch { /* La preferencia remota sigue siendo la fuente persistente. */ }
  }

  applyTheme(theme = 'system') {
    const preference = ['light','dark','system'].includes(theme) ? theme : 'system';
    const resolved = preference === 'system'
      ? (this.systemThemeMedia?.matches ? 'dark' : 'light')
      : preference;
    this.state.settings.theme = preference;
    document.documentElement.dataset.theme = resolved;
    document.documentElement.dataset.themePreference = preference;
    document.documentElement.style.colorScheme = resolved;
    this.cacheTheme(preference);
  }

  async loadPreferencesInBackground() {
    if (!this.session.user) return;
    try {
      const result = await this.repository.settings();
      if (!this.session.user) return;
      this.state.settings = { ...this.state.settings, ...(result.settings || {}) };
      this.cacheTheme(this.state.settings.theme);
      this.applyTheme(this.state.settings.theme);
      if (this.state.route === 'settings') this.render();
    } catch { /* Un fallo de preferencias no debe bloquear el resto de la aplicación. */ }
  }

  render() {
    this.state.user = this.session.user;
    this.view.renderShell(this.state);
  }

  async onSubmit(event) {
    const form = event.target;
    if (!(form instanceof HTMLFormElement)) return;
    event.preventDefault();
    const data = Object.fromEntries(new FormData(form).entries());
    const button = form.querySelector('button[type="submit"]');
    if (button) { button.disabled = true; button.dataset.originalText = button.textContent; button.textContent = 'Un momento…'; }
    try {
      if (form.id === 'login-form') {
        await this.session.login(data.identifier, data.password);
        this.state.user = this.session.user;
        this.applyTheme(this.readCachedTheme() || 'system');
        this.loadPreferencesInBackground();
        await this.openRoute('home');
        this.startNotificationPolling();
        this.startSessionRefreshPolling();
      } else if (form.id === 'register-form') {
        const result = await this.session.register(data);
        data.password = '';
        this._lastRecoveryCode = result.recoveryCode || '';
        this.state.user = this.session.user;
        this.localDraftKey = this.localDraftKeyFor('new');
        this.applyTheme('system');
        this.startSessionRefreshPolling();
        this.loadPreferencesInBackground();
        history.replaceState(null, '', location.pathname);
        this.view.renderRecoveryCode(this._lastRecoveryCode);
      } else if (form.id === 'recovery-form') {
        await this.session.api.auth('recover-with-code', {
          username: data.username,
          recoveryCode: data.recoveryCode,
          password: data.password
        });
        showToast('La contraseña fue actualizada. Inicia sesión con tu nueva contraseña.', 'success');
        this.view.renderLogin();
      } else if (form.id === 'profile-form') {
        const result = await this.repository.renameProfile(data.displayName.trim());
        this.session.user = { ...this.session.user, ...result.user };
        this.state.user = this.session.user;
        showToast('Tu nombre se actualizó.', 'success');
        this.render();
      } else if (form.id === 'account-form') {
        const result = await this.session.api.auth('account:update', {
          username: data.username,
          email: data.email,
          currentPassword: data.currentPassword
        });
        this.session.user = { ...this.session.user, ...result.user };
        this.state.user = this.session.user;
        showToast('Los datos de tu cuenta se actualizaron.', 'success');
        this.render();
      } else if (form.id === 'password-form') {
        if (data.newPassword !== data.confirmPassword) throw new Error('La confirmación de la nueva contraseña no coincide.');
        await this.session.api.auth('password:update', {
          currentPassword: data.currentPassword,
          newPassword: data.newPassword
        });
        await this.repository.sessions().then(result => { this.state.sessions = result.sessions || []; }).catch(() => {});
        showToast('Contraseña actualizada. Se cerraron las demás sesiones.', 'success');
        this.render();
      } else if (form.id === 'delete-account-form') {
        if (data.confirmation !== 'ELIMINAR') throw new Error('Escribe exactamente ELIMINAR para confirmar la eliminación de tu cuenta.');
        const approved = await showConfirmDialog({
          tone: 'danger',
          title: 'Eliminar tu cuenta',
          message: 'Esta acción eliminará tu perfil, preferencias, sesiones y borradores.',
          detail: 'Las cartas ya enviadas pueden permanecer en el buzón de la otra persona con el nombre “Cuenta eliminada”. Esta operación no se puede deshacer.',
          confirmLabel: 'Eliminar cuenta',
          cancelLabel: 'Conservar cuenta'
        });
        if (!approved) return;
        const userId = this.session.user.id;
        const result = await this.session.api.auth('account:delete', {
          currentPassword: data.currentPassword,
          confirmation: data.confirmation
        });
        if (!result.deleted) throw new Error('La cuenta no pudo eliminarse.');
        this.stopNotificationPolling();
        this.stopSessionRefreshPolling();
        await deleteLocalDraftsForUser(userId);
        try { localStorage.removeItem(`nuestro-rincon:theme:${userId}`); localStorage.removeItem(`nuestro-rincon:draft-emergency:${userId}`); } catch {}
        this.invalidateRouteCache();
        this.session.clearSession();
        this.state.editor = null;
        this.view.renderLogin('Tu cuenta se eliminó. Las cartas compartidas que ya fueron enviadas se conservaron para la otra persona.');
      } else if (form.id === 'settings-form') {
        const formData = new FormData(form);
        const result = await this.repository.saveSettings({
          theme: formData.get('theme') || 'system',
          timeZone: formData.get('timeZone'),
          notificationsEnabled: formData.get('notifications') === 'on'
        });
        this.state.settings = { ...this.state.settings, ...(result.settings || {}) };
        this.cacheTheme(this.state.settings.theme);
        this.applyTheme(this.state.settings.theme);
        this.routeCache.delete('settings:');
        showToast('Preferencias guardadas.', 'success');
        this.render();
      }
    } catch (error) {
      if (form.id === 'login-form') this.view.renderLogin(error.message);
      else if (form.id === 'register-form') this.view.renderRegister(error.message);
      else if (form.id === 'recovery-form') this.view.renderRecovery(error.message);
      else showToast(error.message || 'No se pudo completar la operación.', 'error');
    } finally {
      if (button?.isConnected) { button.disabled = false; button.textContent = button.dataset.originalText || 'Continuar'; }
    }
  }

  onInput(event) {
    if (event.target.id === 'letter-search') {
      this.state.search = event.target.value;
      window.clearTimeout(this.searchTimer);
      this.searchTimer = window.setTimeout(() => this.openRoute(this.state.route, false), 350);
      return;
    }
    if (event.target.id === 'editor-title' || event.target.id === 'letter-editor') {
      this.editorInputVersion++;
      const editor = this.readEditorFromDom();
      this.state.editor = { ...this.state.editor, ...editor, inputVersion: this.editorInputVersion, savedAt: new Date().toISOString(), saving: true, saved: false };
      const status = this.root.querySelector('#save-status');
      if (status) status.textContent = 'Guardando…';
      this.persistEmergencyDraft(this.state.editor);
      // IndexedDB conserva una instantánea por pulsación; la escritura remota
      // sí se agrupa para no abrir una petición por cada tecla.
      this.persistLocalDraft().catch(() => {});
      window.clearTimeout(this.autosaveTimer);
      this.autosaveTimer = window.setTimeout(() => this.saveDraft(true).catch(() => {}), 1000);
    }
  }

  async onClick(event) {
    const routeTarget = event.target.closest('[data-route]');
    if (routeTarget) {
      event.preventDefault();
      await this.openRoute(routeTarget.dataset.route);
      return;
    }
    const actionTarget = event.target.closest('[data-action]');
    if (!actionTarget) {
      const card = event.target.closest('[data-letter-id]');
      if (card?.dataset.letterId) await this.openLetter(card.dataset.letterId);
      return;
    }
    const action = actionTarget.dataset.action;
    try {
      switch (action) {
        case 'show-register': this.view.renderRegister(); break;
        case 'show-login': this.view.renderLogin(); break;
        case 'show-recovery': this.view.renderRecovery(); break;
        case 'copy-recovery': await navigator.clipboard.writeText(this._lastRecoveryCode); showToast('Código copiado.', 'success'); break;
        case 'continue-after-recovery': this._lastRecoveryCode = ''; history.replaceState(null, '', location.pathname); await this.openRoute('home'); this.startNotificationPolling(); this.startSessionRefreshPolling(); break;
        case 'open-mobile-nav': this.state.mobileNavOpen = true; this.render(); break;
        case 'close-mobile-nav': this.state.mobileNavOpen = false; this.render(); break;
        case 'logout': {
          const approved = await showConfirmDialog({
            tone: 'neutral', title: 'Cerrar sesión',
            message: '¿Quieres cerrar tu sesión en este dispositivo?',
            detail: 'Podrás volver a entrar con tu nombre de usuario y contraseña.',
            confirmLabel: 'Cerrar sesión', cancelLabel: 'Seguir aquí', icon: '↗'
          });
          if (approved) { await this.session.logout(); this.stopNotificationPolling(); this.stopSessionRefreshPolling(); this.view.renderLogin(); }
          break;
        }
        case 'open-notifications': await this.openRoute('notifications'); break;
        case 'open-letter': await this.openLetter(actionTarget.dataset.letterId); break;
        case 'retry-route': await this.openRoute(this.state.route, false); break;
        case 'back-to-list': await this.openRoute(this.previousListRoute); break;
        case 'cancel-editor': await this.openRoute(this.previousListRoute || 'drafts'); break;
        case 'save-draft': await this.saveDraft(false); break;
        case 'preview-send': await this.previewSend(); break;
        case 'preview-send-draft': await this.openLetterForSend(actionTarget.dataset.letterId); break;
        case 'confirm-send': await this.confirmSend(); break;
        case 'dismiss-modal': this.closeModal(); break;
        case 'edit-draft': await this.editDraft(actionTarget.dataset.letterId); break;
        case 'reply-letter': await this.startReply(actionTarget.dataset.letterId); break;
        case 'format-bold': this.execFormat('bold'); break;
        case 'format-italic': this.execFormat('italic'); break;
        case 'format-underline': this.execFormat('underline'); break;
        case 'format-left': this.execFormat('justifyLeft'); break;
        case 'format-center': this.execFormat('justifyCenter'); break;
        case 'format-right': this.execFormat('justifyRight'); break;
        case 'toggle-favorite': {
          const letterId = actionTarget.dataset.letterId;
          const current = actionTarget.dataset.favorite === undefined ? Boolean(this.state.selectedLetter?.letter?.isFavorite) : actionTarget.dataset.favorite === 'true';
          await this.repository.setFavorite(letterId, !current);
          this.invalidateRouteCache(); showToast('Favorito actualizado.', 'success');
          if (this.state.route === 'letter') await this.openLetter(letterId, false); else await this.openRoute(this.state.route, false);
          break;
        }
        case 'toggle-archive': {
          const letterId = actionTarget.dataset.letterId;
          const current = actionTarget.dataset.archived === undefined ? Boolean(this.state.selectedLetter?.letter?.isArchived) : actionTarget.dataset.archived === 'true';
          await this.repository.setArchive(letterId, !current);
          this.invalidateRouteCache(); showToast(current ? 'La carta salió del archivo.' : 'La carta se guardó en Archivo.', 'success');
          if (this.state.route === 'letter') await this.openRoute(this.previousListRoute, false); else await this.openRoute(this.state.route, false);
          break;
        }
        case 'trash-letter': {
          const letterId = actionTarget.dataset.letterId;
          const currentItem = this.state.letters.find(item => item.id === letterId);
          const selectedItem = this.state.selectedLetter?.letter?.id === letterId ? this.state.selectedLetter.letter : null;
          const isDraft = actionTarget.dataset.letterStatus === 'draft' || currentItem?.status === 'draft' || selectedItem?.status === 'draft';
          // Descartar un borrador es reversible desde Papelera: no requiere una
          // segunda pulsación de confirmación. Para cartas compartidas sí se confirma.
          if (!isDraft && !(await showConfirmDialog({
            tone: 'warning', title: 'Mover carta a Papelera',
            message: 'La carta dejará de aparecer en tus carpetas habituales.',
            detail: 'Podrás recuperarla desde Papelera mientras no se elimine definitivamente.',
            confirmLabel: 'Mover a Papelera', cancelLabel: 'Cancelar', icon: '⌑'
          }))) break;
          await this.discardLetter(letterId, isDraft);
          break;
        }
        case 'restore-letter': {
          const letterId = actionTarget.dataset.letterId;
          const restored = await this.repository.restore(letterId);
          if (restored.status !== 'restored') throw new Error('No se pudo recuperar la carta. Actualiza la lista e inténtalo de nuevo.');
          this.discardedDraftIds.delete(letterId);
          this.invalidateRouteCache(); showToast('Carta recuperada.', 'success');
          await this.openRoute(this.state.route === 'letter' ? this.previousListRoute : this.state.route, false);
          break;
        }
        case 'purge-letter': {
          const approved = await showConfirmDialog({
            tone: 'danger', title: 'Eliminar definitivamente',
            message: 'Esta acción no se puede deshacer cuando el proceso de eliminación se complete.',
            detail: 'En una carta compartida, tu confirmación queda registrada y la eliminación del contenido solo se completa cuando ambas personas la confirman.',
            confirmLabel: 'Eliminar definitivamente', cancelLabel: 'Mantener en Papelera'
          });
          if (!approved) break;
          const result = await this.repository.purge(actionTarget.dataset.letterId);
          this.invalidateRouteCache();
          showToast(result.status === 'pending_other_participant' ? 'Tu confirmación quedó registrada. Falta la de la otra persona.' : 'El contenido se eliminó según la política compartida.', 'success');
          await this.openRoute(this.state.route === 'letter' ? 'trash' : this.state.route, false);
          break;
        }
        case 'download-txt': await this.downloadTxt(actionTarget.dataset.letterId); break;
        case 'download-html': await this.downloadHtml(actionTarget.dataset.letterId); break;
        case 'print-letter': window.print(); break;
        case 'read-notification': await this.repository.markNotificationRead(actionTarget.dataset.notificationId); this.invalidateRouteCache(); await this.openRoute('notifications', false); break;
        case 'revoke-session': {
          const approved = await showConfirmDialog({
            tone: 'warning', title: 'Revocar sesión',
            message: 'El dispositivo seleccionado perderá el acceso a Nuestro Rincón.',
            detail: 'La persona que lo esté utilizando tendrá que iniciar sesión nuevamente.',
            confirmLabel: 'Revocar acceso', cancelLabel: 'Conservar sesión', icon: '⌑'
          });
          if (!approved) break;
          const sessionId = actionTarget.dataset.sessionId;
          await this.repository.revokeSession(sessionId);
          this.state.sessions = (this.state.sessions || []).filter(item => item.id !== sessionId);
          this.sessionChannel?.postMessage({ type: 'session-revoked', sessionId });
          this.render();
          showToast('Sesión revocada.', 'success');
          await this.refreshSessions();
          break;
        }
      }
    } catch (error) {
      showToast(error.message || 'La operación no se pudo completar.', 'error');
      if (error.status === 401) this.forceLogout();
    }
  }

  async openLetter(letterId, updateHash = true) {
    const requestId = ++this.routeRequestId;
    this.state.routeLoading = false;
    this.previousListRoute = ['inbox','sent','drafts','favorites','archive','trash'].includes(this.state.route) ? this.state.route : this.previousListRoute;
    const data = await this.repository.get(letterId);
    if (requestId !== this.routeRequestId) return;
    this.state.selectedLetter = data;
    if (data.letter.status === 'sent' && data.letter.recipient_id === this.session.user.id && !data.letter.read_at) {
      await this.repository.markRead(data.letter.thread_id);
      if (requestId !== this.routeRequestId) return;
      this.invalidateRouteCache();
      data.letter.read_at = new Date().toISOString();
      data.letter.readByRecipientAt = data.letter.read_at;
      try { this.state.dashboard = await this.repository.dashboard(); } catch { /* La lectura ya quedó registrada; el contador se actualizará en la siguiente carga. */ }
      if (requestId !== this.routeRequestId) return;
    }
    this.state.route = 'letter';
    this.state.mobileNavOpen = false;
    if (updateHash) history.replaceState(null, '', '#/letter');
    this.render();
  }

  async openLetterForSend(letterId) {
    await this.editDraft(letterId);
    await this.previewSend();
  }

  async editDraft(letterId) {
    const data = await this.repository.get(letterId);
    if (data.letter.status !== 'draft') throw new Error('Esta carta ya no es un borrador.');
    this.localDraftKey = this.localDraftKeyFor(`letter:${letterId}`);
    const local = await getLocalDraft(this.localDraftKey);
    const localIsNewer = Boolean(local?.savedAt && new Date(local.savedAt).getTime() > new Date(data.letter.updated_at || data.letter.created_at).getTime());
    this.state.editor = { letterId, creationRequestId: local?.creationRequestId || null, title: localIsNewer ? (local.title || '') : (data.letter.title || ''), body: localIsNewer ? (local.body || '') : (data.letter.body || ''), revision: data.letter.revision, parentLetterId: null, saving: false, saved: !localIsNewer, localOnly: localIsNewer, pendingSync: localIsNewer };
    this.routeRequestId++;
    this.state.routeLoading = false;
    this.state.route = 'write';
    history.replaceState(null, '', '#/write');
    this.render();
    if (localIsNewer) this.saveDraft(true).catch(() => {});
  }

  async startReply(letterId) {
    const data = await this.repository.get(letterId);
    this.localDraftKey = this.localDraftKeyFor(`reply:${letterId}`);
    this.state.editor = { letterId: null, creationRequestId: crypto.randomUUID(), title: `Re: ${data.letter.title || 'Tu carta'}`.slice(0,180), body: '', revision: 1, parentLetterId: letterId, saving: false, saved: false };
    const local = await getLocalDraft(this.localDraftKey);
    if (local) this.state.editor = { ...this.state.editor, ...local };
    this.routeRequestId++;
    this.state.routeLoading = false;
    this.state.route = 'write';
    history.replaceState(null, '', '#/write');
    this.render();
  }

  readEditorFromDom() {
    const title = this.root.querySelector('#editor-title')?.value ?? this.state.editor?.title ?? '';
    const body = sanitizeRichHtml(this.root.querySelector('#letter-editor')?.innerHTML ?? this.state.editor?.body ?? '');
    return { title, body };
  }

  emergencyDraftStorageKey() {
    return `nuestro-rincon:draft-emergency:${this.session?.user?.id || 'guest'}`;
  }

  persistEmergencyDraft(snapshot = null) {
    const editor = snapshot || (this.state.editor ? { ...this.state.editor, ...this.readEditorFromDom() } : null);
    if (!editor || editor.parentLetterId) return;
    const userId = this.session?.user?.id;
    if (!userId) return;
    try {
      localStorage.setItem(this.emergencyDraftStorageKey(), JSON.stringify({
        ...editor,
        key: this.localDraftKey || this.localDraftKeyFor(editor.letterId ? `letter:${editor.letterId}` : 'new'),
        userId,
        pendingSync: true,
        savedAt: editor.savedAt || new Date().toISOString()
      }));
    } catch { /* IndexedDB conserva la copia principal. */ }
  }

  readEmergencyDraft(expectedKey = null) {
    const userId = this.session?.user?.id;
    if (!userId) return null;
    try {
      const raw = localStorage.getItem(this.emergencyDraftStorageKey());
      if (!raw) return null;
      const draft = JSON.parse(raw);
      if (draft.userId !== userId || !draft.key || draft.parentLetterId) return null;
      if (expectedKey && draft.key !== expectedKey) return null;
      return { ...draft, pendingSync: true, localOnly: true };
    } catch { return null; }
  }

  async restoreEmergencyDraft() {
    const userId = this.session?.user?.id;
    if (!userId) return;
    const draft = this.readEmergencyDraft();
    if (!draft) return;
    if (draft.key.startsWith(`${userId}:`)) this.localDraftKey = draft.key;
    await putLocalDraft(draft);
  }

  async hydrateEditorFromLocal(storageKey, identity) {
    const local = await getLocalDraft(storageKey);
    if (!local || this.state.route !== 'write' || this.state.editor?.creationRequestId !== identity) return;
    const emergency = this.readEmergencyDraft(storageKey);
    const newest = [local, emergency].filter(Boolean)
      .sort((a,b) => new Date(b.savedAt || 0).getTime() - new Date(a.savedAt || 0).getTime())[0];
    if (!newest) return;
    const current = this.state.editor;
    if (new Date(newest.savedAt || 0).getTime() < new Date(current.savedAt || 0).getTime()) return;
    this.state.editor = { ...current, ...newest, creationRequestId: newest.creationRequestId || identity };
    this.render();
    if (this.state.editor.pendingSync || this.state.editor.localOnly) this.saveDraft(true).catch(() => {});
  }

  flushDraftOnExit() {
    if (!this.state.editor || this.state.editor.parentLetterId) return;
    const snapshot = { ...this.state.editor, ...this.readEditorFromDom(), saving: true, saved: false, pendingSync: true, localOnly: true };
    this.persistEmergencyDraft(snapshot);
    const storageKey = this.localDraftKey || this.localDraftKeyFor(snapshot.letterId ? `letter:${snapshot.letterId}` : 'new');
    putLocalDraft({ key: storageKey, ...snapshot }).then(() => {
      if (navigator.onLine) this.enqueueDraftSync(snapshot, storageKey, { keepalive: true }).catch(() => {});
    }).catch(() => {});
  }

  async persistLocalDraft() {
    if (!this.state.editor) return;
    const current = this.readEditorFromDom();
    this.state.editor = { ...this.state.editor, ...current, savedAt: this.state.editor.savedAt || new Date().toISOString(), pendingSync: true, saved: false };
    const storageKey = this.localDraftKey || this.localDraftKeyFor(this.state.editor.letterId ? `letter:${this.state.editor.letterId}` : 'new');
    this.persistEmergencyDraft(this.state.editor);
    await putLocalDraft({ key: storageKey, ...this.state.editor, pendingSync: true });
  }

  async saveDraft(silent = false, options = {}) {
    if (!this.state.editor) return null;
    const current = this.readEditorFromDom();
    const editor = { ...this.state.editor, ...current };
    if (plainTextFromHtml(editor.body).length > 100000) throw new Error('La carta supera el límite de 100.000 caracteres.');
    const storageKey = this.localDraftKey || this.localDraftKeyFor(editor.letterId ? `letter:${editor.letterId}` : 'new');
    if (editor.letterId && this.discardedDraftIds.has(editor.letterId)) {
      await this.clearLocalDraftForLetter(editor.letterId, this.localDraftKey);
      return { status: 'discarded' };
    }
    const snapshot = { ...editor, inputVersion: this.editorInputVersion, savedAt: new Date().toISOString(), saving: true, saved: false, pendingSync: true, localOnly: true };
    this.state.editor = snapshot;
    this.persistEmergencyDraft(snapshot);
    await putLocalDraft({ key: storageKey, ...snapshot });

    const title = editor.title.trim() || 'Sin título';
    if (editor.parentLetterId) {
      this.state.editor = { ...editor, title, saving: false, saved: true, localOnly: true, pendingSync: false };
      await putLocalDraft({ key: storageKey, ...this.state.editor });
      this.updateSaveStatus('Respuesta guardada en este dispositivo');
      if (!silent) showToast('La respuesta se guardó en este dispositivo; se enviará al confirmar.', 'success');
      return { status: 'local' };
    }
    if (!navigator.onLine) {
      this.state.editor = { ...editor, saving: false, saved: true, localOnly: true, pendingSync: true };
      this.updateSaveStatus('Sin conexión · copia local conservada');
      if (!silent) showToast('Sin conexión. La copia local está guardada.', 'error');
      return { status: 'local' };
    }

    try {
      const result = await this.enqueueDraftSync({ ...snapshot, title }, storageKey, options);
      if (result?.status === 'discarded') {
        this.updateSaveStatus('Este borrador está en la papelera. Recupéralo antes de seguir editándolo.');
      } else if (result?.status === 'saved' || result?.status === 'created') {
        this.updateSaveStatus('Guardado en la nube');
        if (!silent) showToast('Borrador guardado.', 'success');
      } else if (result?.status === 'conflict') {
        this.updateSaveStatus('Hay cambios nuevos en el servidor; conserva esta copia local antes de continuar.');
        if (!silent) showToast('Conflicto de edición. Tu copia local permanece intacta.', 'error');
      }
      return result;
    } catch (error) {
      if (editor.letterId && this.discardedDraftIds.has(editor.letterId)) {
        await this.clearLocalDraftForLetter(editor.letterId, storageKey);
        return { status: 'discarded' };
      }
      const latest = this.state.editor?.creationRequestId === editor.creationRequestId || this.state.editor?.letterId === editor.letterId
        ? { ...this.state.editor, ...this.readEditorFromDom() }
        : editor;
      this.state.editor = { ...latest, saving: false, saved: true, localOnly: true, pendingSync: true };
      await putLocalDraft({ key: storageKey, ...this.state.editor });
      this.persistEmergencyDraft(this.state.editor);
      this.updateSaveStatus('No se pudo sincronizar · copia local conservada');
      if (error.status === 401) this.forceLogout();
      throw error;
    }
  }

  draftSyncQueueKey() {
    // La identidad del borrador cambia de `new` a `letter:<id>` al crearse.
    // Un único carril por cuenta evita que ambas claves guarden a la vez con
    // la misma revisión y provoquen conflictos artificiales.
    return this.localDraftKeyFor('__draft-sync__');
  }

  enqueueDraftSync(snapshot, storageKey, options = {}) {
    const letterId = snapshot?.letterId;
    if (letterId && this.discardedDraftIds.has(letterId)) {
      return this.clearLocalDraftForLetter(letterId, storageKey).then(() => ({ status: 'discarded' }));
    }
    const queueKey = this.draftSyncQueueKey();
    const previous = this.draftQueues.get(queueKey) || Promise.resolve();
    const next = previous.catch(() => {}).then(() => this.syncDraftSnapshot(snapshot, storageKey, options));
    this.draftQueues.set(queueKey, next);
    next.finally(() => { if (this.draftQueues.get(queueKey) === next) this.draftQueues.delete(queueKey); }).catch(() => {});
    return next;
  }

  async waitForDraftSyncQueue() {
    const queueKey = this.draftSyncQueueKey();
    // Una tarea puede encadenar otra al detectar texto escrito mientras guarda.
    // Esperamos también esas continuaciones antes de confirmar el descarte.
    for (let attempt = 0; attempt < 20; attempt++) {
      const pending = this.draftQueues.get(queueKey);
      if (!pending) {
        await Promise.resolve();
        if (!this.draftQueues.has(queueKey)) return;
        continue;
      }
      await pending.catch(() => {});
      await Promise.resolve();
      if (!this.draftQueues.has(queueKey)) return;
    }
    throw new ApiError('El borrador todavía se está sincronizando. Vuelve a intentar descartarlo.', 409, 'DRAFT_SYNC_BUSY');
  }

  async clearLocalDraftForLetter(letterId, storageKey = null) {
    const canonicalKey = this.localDraftKeyFor(`letter:${letterId}`);
    const keys = new Set([canonicalKey, storageKey].filter(Boolean));
    for (const [source, target] of this.draftIdentity.entries()) {
      if (source === canonicalKey || target === canonicalKey || source === storageKey || target === storageKey) keys.add(source);
    }
    await Promise.all([...keys].map(key => deleteLocalDraft(key)));
    for (const [source, target] of this.draftIdentity.entries()) {
      if (keys.has(source) || keys.has(target)) this.draftIdentity.delete(source);
    }
    const emergency = this.readEmergencyDraft();
    if (emergency && (emergency.letterId === letterId || keys.has(emergency.key))) {
      try { localStorage.removeItem(this.emergencyDraftStorageKey()); } catch {}
    }
    if (this.localDraftKey && keys.has(this.localDraftKey)) this.localDraftKey = this.localDraftKeyFor('new');
    if (this.state.editor?.letterId === letterId) {
      this.state.editor = null;
      if (this.state.route === 'write') {
        this.state.route = 'drafts';
        history.replaceState(null, '', '#/drafts');
        this.render();
      }
    }
  }

  async discardLetter(letterId, isDraft) {
    if (!letterId) throw new Error('No se identificó la carta que quieres descartar.');
    const currentItem = this.state.letters.find(item => item.id === letterId);
    const selectedItem = this.state.selectedLetter?.letter?.id === letterId ? this.state.selectedLetter.letter : null;
    const source = currentItem || selectedItem;
    const wasAlreadyInTrash = Boolean(source?.isInTrash);
    const targetRoute = this.state.route === 'letter' ? (this.previousListRoute || 'inbox') : this.state.route;

    if (isDraft) {
      this.discardedDraftIds.add(letterId);
      window.clearTimeout(this.autosaveTimer);
      try {
        await this.waitForDraftSyncQueue();
      } catch (error) {
        this.discardedDraftIds.delete(letterId);
        throw error;
      }
    }

    try {
      const result = await this.repository.moveToTrash(letterId);
      if (!['trashed', 'already_trashed'].includes(result?.status)) {
        throw new Error('La carta no se movió a la papelera. Actualiza la lista e inténtalo de nuevo.');
      }
      if (isDraft) await this.clearLocalDraftForLetter(letterId, this.localDraftKeyFor(`letter:${letterId}`));

      this.state.letters = (this.state.letters || []).filter(item => item.id !== letterId);
      if (this.state.selectedLetter?.letter?.id === letterId) this.state.selectedLetter = null;
      if (isDraft && !wasAlreadyInTrash) {
        this.state.dashboard.drafts = Math.max(0, Number(this.state.dashboard.drafts || 0) - 1);
      }

      for (const [cacheKey, entry] of this.routeCache.entries()) {
        const folder = cacheKey.split(':', 1)[0];
        let data = entry.data;
        if (Array.isArray(data?.letters?.items)) {
          let items = data.letters.items.filter(item => item.id !== letterId);
          if (folder === 'trash' && source && !items.some(item => item.id === letterId)) {
            items = [{ ...source, isInTrash: true }, ...items];
          }
          data = { ...data, letters: { ...data.letters, items } };
        }
        if (folder === 'home' && data?.dashboard && isDraft && !wasAlreadyInTrash) {
          data = { ...data, dashboard: { ...data.dashboard, drafts: Math.max(0, Number(data.dashboard.drafts || 0) - 1) } };
        }
        this.routeCache.set(cacheKey, { ...entry, data, at: 0 });
      }

      this.invalidateRouteCache();
      if (this.state.route === 'letter') {
        this.state.route = targetRoute;
        history.replaceState(null, '', `#/${targetRoute}`);
      }
      this.state.routeLoading = false;
      this.render();
      showToast(result.status === 'already_trashed' ? 'La carta ya estaba en la papelera.' : 'La carta se movió a la papelera.', 'success');

      const requestId = ++this.routeRequestId;
      const cacheKey = this.routeCacheKey(this.state.route);
      this.refreshRouteData(this.state.route, cacheKey, requestId, true).catch(() => {});
    } catch (error) {
      if (isDraft) this.discardedDraftIds.delete(letterId);
      throw error;
    }
  }

  queueDraftSync(snapshot, storageKey) {
    if (snapshot?.letterId && this.discardedDraftIds.has(snapshot.letterId)) {
      this.clearLocalDraftForLetter(snapshot.letterId, storageKey).catch(() => {});
      return;
    }
    this.persistEmergencyDraft(snapshot);
    putLocalDraft({ key: storageKey, ...snapshot, pendingSync: true, localOnly: true }).then(() => {
      if (snapshot?.letterId && this.discardedDraftIds.has(snapshot.letterId)) {
        return this.clearLocalDraftForLetter(snapshot.letterId, storageKey);
      }
      return this.enqueueDraftSync({ ...snapshot, pendingSync: true }, storageKey);
    }).catch(() => {});
  }

  async syncPendingLocalDrafts() {
    if (!this.session?.user?.id || !navigator.onLine) return;
    const drafts = await getLocalDraftsForUser(this.session.user.id);
    for (const draft of drafts) {
      if (!draft || draft.parentLetterId) continue;
      if (draft.pendingSync || draft.localOnly || draft.saved === false || !draft.letterId) {
        await this.enqueueDraftSync(draft, draft.key).catch(() => {});
      }
    }
  }

  async syncDraftSnapshot(initialSnapshot, initialStorageKey, options = {}) {
    if (!initialSnapshot || initialSnapshot.parentLetterId || !navigator.onLine) return { status: 'local' };
    let storageKey = this.draftIdentity.get(initialStorageKey) || initialStorageKey;
    let snapshot = { ...initialSnapshot };
    if (snapshot.letterId && this.discardedDraftIds.has(snapshot.letterId)) {
      await this.clearLocalDraftForLetter(snapshot.letterId, storageKey);
      return { status: 'discarded' };
    }
    const local = await getLocalDraft(storageKey);
    if (local && (new Date(local.savedAt || 0).getTime() >= new Date(snapshot.savedAt || 0).getTime())) snapshot = { ...snapshot, ...local };
    const requestOptions = options.keepalive ? { keepalive: true, timeoutMs: 7000 } : {};
    const title = snapshot.title?.trim() || 'Sin título';

    const storeSynced = async (draft, latestSnapshot, currentStorageKey) => {
      if (this.discardedDraftIds.has(draft.id)) {
        await this.clearLocalDraftForLetter(draft.id, currentStorageKey);
        return { status: 'discarded' };
      }
      const targetKey = this.localDraftKeyFor(`letter:${draft.id}`);
      const localLatest = await getLocalDraft(currentStorageKey);
      const emergencyLatest = this.readEmergencyDraft(currentStorageKey);
      const freshest = [latestSnapshot, localLatest, emergencyLatest].filter(Boolean)
        .sort((a,b) => new Date(b.savedAt || 0).getTime() - new Date(a.savedAt || 0).getTime())[0] || latestSnapshot;
      const currentMatches = this.state.editor && (
        this.state.editor.creationRequestId === latestSnapshot.creationRequestId ||
        this.state.editor.letterId === latestSnapshot.letterId ||
        this.state.editor.letterId === draft.id
      );
      const liveEditor = currentMatches && this.state.route === 'write'
        ? { ...this.state.editor, ...this.readEditorFromDom() }
        : null;
      const liveIsNewer = Boolean(liveEditor && (
        liveEditor.title !== freshest.title || liveEditor.body !== freshest.body ||
        this.editorInputVersion > Number(freshest.inputVersion || 0)
      ));
      const source = liveIsNewer ? { ...freshest, ...liveEditor, inputVersion: this.editorInputVersion } : freshest;
      const persisted = {
        ...source,
        letterId: draft.id,
        creationRequestId: source.creationRequestId || draft.creationRequestId || crypto.randomUUID(),
        revision: draft.revision || 1,
        title: source.title ?? draft.title ?? title,
        body: source.body ?? draft.body ?? '',
        saving: false,
        saved: !liveIsNewer,
        localOnly: liveIsNewer,
        pendingSync: liveIsNewer,
        conflict: false
      };
      await putLocalDraft({ key: targetKey, ...persisted });
      if (currentStorageKey !== targetKey) {
        this.draftIdentity.set(currentStorageKey, targetKey);
        await deleteLocalDraft(currentStorageKey);
      }
      if (currentMatches) {
        this.localDraftKey = targetKey;
        this.state.editor = persisted;
        if (this.state.route === 'write') this.updateSaveStatus(liveIsNewer ? 'Sincronizando los últimos cambios…' : 'Guardado en la nube');
      } else if (this.localDraftKey === currentStorageKey) {
        this.localDraftKey = null;
      }
      if (liveIsNewer) {
        this.persistEmergencyDraft(persisted);
        this.enqueueDraftSync(persisted, targetKey).catch(() => {});
      } else if (emergencyLatest && !(this.state.editor && this.state.route === 'write' && !currentMatches)) {
        // No borres la emergencia de una carta diferente que se esté editando.
        try { localStorage.removeItem(this.emergencyDraftStorageKey()); } catch {}
      }
      this.invalidateRouteCache();
      return { status: 'saved', draft };
    };

    if (!snapshot.letterId) {
      let creationRequestId = snapshot.creationRequestId || crypto.randomUUID();
      let created = await this.repository.createDraft({ creationRequestId, title, body: snapshot.body || '' }, requestOptions);
      if (created?.status === 'discarded' && created?.draft?.id) {
        this.discardedDraftIds.add(created.draft.id);
        await this.clearLocalDraftForLetter(created.draft.id, storageKey);
        return { status: 'discarded' };
      }
      if (created?.draft?.status === 'purged') {
        creationRequestId = crypto.randomUUID();
        const recoveredLocal = { ...snapshot, creationRequestId, pendingSync: true, localOnly: true, savedAt: new Date().toISOString() };
        await putLocalDraft({ key: storageKey, ...recoveredLocal });
        this.persistEmergencyDraft(recoveredLocal);
        created = await this.repository.createDraft({ creationRequestId, title, body: snapshot.body || '' }, requestOptions);
      }
      if (created.status !== 'created' || !created.draft?.id || created.draft.status !== 'draft') throw new ApiError('El servidor no confirmó la creación de un borrador nuevo.', 502, 'DRAFT_CREATE_UNCONFIRMED');
      let latest = await getLocalDraft(storageKey) || snapshot;
      const emergencyLatest = this.readEmergencyDraft(storageKey);
      if (emergencyLatest && new Date(emergencyLatest.savedAt || 0) > new Date(latest.savedAt || 0)) latest = { ...latest, ...emergencyLatest };
      latest = { ...snapshot, ...latest, letterId: created.draft.id, creationRequestId, revision: created.draft.revision || 1 };
      if (latest.title !== title || latest.body !== (snapshot.body || '')) {
        const saved = await this.repository.saveDraft({ letterId: created.draft.id, title: latest.title?.trim() || 'Sin título', body: latest.body || '', expectedRevision: created.draft.revision || 1 }, requestOptions);
        if (saved.status === 'not_found') throw new ApiError('El servidor creó el borrador pero no lo encontró al guardar los últimos cambios.', 404, 'DRAFT_NOT_FOUND');
        if (saved.status !== 'saved') throw new ApiError('No se pudieron guardar los últimos cambios del borrador.', 502, 'DRAFT_SAVE_UNCONFIRMED');
        return storeSynced(saved.draft || created.draft, latest, storageKey);
      }
      return storeSynced(created.draft, latest, storageKey);
    }

    try {
      const result = await this.repository.saveDraft({
        letterId: snapshot.letterId,
        title,
        body: snapshot.body || '',
        expectedRevision: snapshot.revision || 1
      }, requestOptions);
      if (result.status === 'discarded') {
        this.discardedDraftIds.add(snapshot.letterId);
        await this.clearLocalDraftForLetter(snapshot.letterId, storageKey);
        return { status: 'discarded' };
      }
      if (result.status === 'conflict') {
        const remote = result.draft;
        if (remote?.id === snapshot.letterId && remote.status === 'draft' && remote.title === title && remote.body === (snapshot.body || '')) {
          return storeSynced(remote, snapshot, storageKey);
        }
        const conflicted = { ...snapshot, conflict: true, localOnly: true, pendingSync: true, saved: true, saving: false };
        await putLocalDraft({ key: storageKey, ...conflicted });
        if (this.state.editor?.letterId === snapshot.letterId) this.state.editor = conflicted;
        return { status: 'conflict' };
      }
      if (result.status === 'not_found') throw new ApiError('El borrador ya no existe en el servidor.', 404, 'DRAFT_NOT_FOUND');
      if (result.status !== 'saved' || !result.draft) throw new ApiError('El servidor no confirmó el guardado del borrador.', 502, 'DRAFT_SAVE_UNCONFIRMED');
      let latest = await getLocalDraft(storageKey) || snapshot;
      latest = { ...snapshot, ...latest };
      if (latest.title !== snapshot.title || latest.body !== snapshot.body) {
        const second = await this.repository.saveDraft({
          letterId: snapshot.letterId,
          title: latest.title?.trim() || 'Sin título',
          body: latest.body || '',
          expectedRevision: result.draft.revision || snapshot.revision || 1
        }, requestOptions);
        if (second.status === 'not_found') throw new ApiError('El borrador ya no existe en el servidor.', 404, 'DRAFT_NOT_FOUND');
        if (second.status === 'discarded') {
          this.discardedDraftIds.add(snapshot.letterId);
          await this.clearLocalDraftForLetter(snapshot.letterId, storageKey);
          return { status: 'discarded' };
        }
        if (second.status === 'conflict') {
          if (second.draft?.id === snapshot.letterId && second.draft.status === 'draft' && second.draft.title === (latest.title?.trim() || 'Sin título') && second.draft.body === (latest.body || '')) {
            return storeSynced(second.draft, latest, storageKey);
          }
          await putLocalDraft({ key: storageKey, ...latest, conflict: true, localOnly: true, pendingSync: true, saving: false });
          return { status: 'conflict' };
        }
        if (second.status !== 'saved' || !second.draft) throw new ApiError('El servidor no confirmó los últimos cambios.', 502, 'DRAFT_SAVE_UNCONFIRMED');
        return storeSynced(second.draft, latest, storageKey);
      }
      return storeSynced(result.draft, latest, storageKey);
    } catch (error) {
      // Un ID purgado, perdido o inaccesible se reemplaza con un borrador nuevo;
      // jamás se elimina la copia local hasta confirmar la creación y guardado.
      if (error.status !== 404 && error.code !== 'DRAFT_NOT_FOUND') throw error;
      const replacementRequestId = crypto.randomUUID();
      const replacement = await this.repository.createDraft({
        creationRequestId: replacementRequestId,
        title: snapshot.title?.trim() || 'Sin título',
        body: snapshot.body || ''
      }, requestOptions);
      if (replacement.status !== 'created' || !replacement.draft?.id) throw new ApiError('No se pudo recuperar la copia local como un nuevo borrador.', 502, 'DRAFT_RECOVERY_FAILED');
      let latest = await getLocalDraft(storageKey) || snapshot;
      latest = { ...snapshot, ...latest, creationRequestId: replacementRequestId, letterId: replacement.draft.id };
      let finalDraft = replacement.draft;
      if (latest.title !== (replacement.draft.title || '') || latest.body !== (replacement.draft.body || '')) {
        const saved = await this.repository.saveDraft({
          letterId: replacement.draft.id,
          title: latest.title?.trim() || 'Sin título',
          body: latest.body || '',
          expectedRevision: replacement.draft.revision || 1
        }, requestOptions);
        if (saved.status !== 'saved' || !saved.draft) throw new ApiError('Se recuperó el borrador, pero falta confirmar la última edición.', 502, 'DRAFT_RECOVERY_SAVE_FAILED');
        finalDraft = saved.draft;
      }
      const oldStorageKey = storageKey;
      const targetKey = this.localDraftKeyFor(`letter:${finalDraft.id}`);
      const persisted = { ...latest, letterId: finalDraft.id, revision: finalDraft.revision || 1, saving: false, saved: true, localOnly: false, pendingSync: false, conflict: false };
      await putLocalDraft({ key: targetKey, ...persisted });
      if (oldStorageKey !== targetKey) {
        this.draftIdentity.set(oldStorageKey, targetKey);
        await deleteLocalDraft(oldStorageKey);
      }
      const currentMatches = this.state.editor && (this.state.editor.letterId === snapshot.letterId || this.state.editor.creationRequestId === snapshot.creationRequestId);
      if (currentMatches) {
        this.localDraftKey = targetKey;
        this.state.editor = persisted;
        if (this.state.route === 'write') this.updateSaveStatus('Borrador recuperado y guardado');
      }
      try { localStorage.removeItem(this.emergencyDraftStorageKey()); } catch {}
      this.invalidateRouteCache();
      return { status: 'saved', draft: finalDraft, recovered: true };
    }
  }

  updateSaveStatus(text) {
    const status = this.root.querySelector('#save-status');
    if (status) status.textContent = text;
  }

  execFormat(command) {
    const editor = this.root.querySelector('#letter-editor');
    if (!editor) return;
    editor.focus();
    document.execCommand(command, false, null);
    this.onInput({ target: editor });
  }

  async previewSend() {
    if (!navigator.onLine) throw new Error('Necesitas conexión para enviar. El borrador permanece guardado en este dispositivo.');
    await this.saveDraft(true);
    const editor = this.state.editor;
    if (!editor?.parentLetterId && (!editor?.letterId || editor.localOnly || editor.conflict)) throw new Error('No se pudo sincronizar el borrador con el servidor. Se conserva la copia local; vuelve a intentarlo antes de enviar.');
    if (!plainTextFromHtml(editor?.body || '').trim()) throw new Error('Escribe el contenido de la carta antes de enviarla.');
    const preview = sanitizeRichHtml(editor.body);
    const modal = document.createElement('div');
    modal.className = 'modal-backdrop';
    modal.id = 'confirm-modal';
    modal.innerHTML = `<section class="modal-card" role="dialog" aria-modal="true" aria-labelledby="send-confirm-title"><span class="eyebrow">Un último vistazo</span><h2 id="send-confirm-title">¿Enviar esta carta?</h2><p>Después de enviarla quedará registrada como correspondencia y ya no se editará silenciosamente.</p><article class="letter-paper" style="padding:20px;margin-top:14px"><h2 style="font-size:23px">${escapeHtml(editor.title || 'Sin título')}</h2><div class="letter-body">${preview}</div></article><div class="modal-actions"><button class="btn btn-ghost" data-action="dismiss-modal">Seguir revisando</button><button class="btn btn-primary" data-action="confirm-send">Enviar carta ↗</button></div></section>`;
    document.body.append(modal);
  }

  async confirmSend() {
    const editor = { ...this.state.editor, ...this.readEditorFromDom() };
    const title = editor.title.trim() || 'Sin título';
    let result;
    if (editor.parentLetterId) {
      result = await this.repository.reply({ parentLetterId: editor.parentLetterId, creationRequestId: editor.creationRequestId || crypto.randomUUID(), title, body: editor.body });
      if (result.status !== 'created') throw new Error('No se pudo enviar la respuesta.');
      await deleteLocalDraft(this.localDraftKey);
    } else {
      if (!editor.letterId) await this.saveDraft(true);
      const current = this.state.editor;
      if (!current?.letterId || current.localOnly || current.conflict) throw new Error('El borrador no está sincronizado. No se envió la versión del servidor.');
      result = await this.repository.sendDraft({ letterId: current.letterId, expectedRevision: current.revision || 1 });
      if (result.status === 'recipient_unavailable') throw new Error('Tu borrador está guardado, pero la segunda cuenta todavía no está creada. Cuando tu esposa se registre podrás enviarlo.');
      if (result.status !== 'sent' && result.status !== 'already_sent') throw new Error('No se pudo enviar la carta.');
      await deleteLocalDraft(this.localDraftKeyFor(`letter:${current.letterId}`));
      try { localStorage.removeItem(this.emergencyDraftStorageKey()); } catch {}
      this.localDraftKey = null;
    }
    this.closeModal();
    this.state.editor = null;
    this.invalidateRouteCache();
    showToast('Tu carta fue enviada.', 'success');
    await this.openRoute('sent');
  }

  closeModal() { document.querySelector('#confirm-modal')?.remove(); }

  async downloadTxt(letterId) {
    const data = await this.repository.get(letterId);
    const letter = data.letter;
    const text = `${letter.title || 'Sin título'}\nDe: ${letter.senderName}\nPara: ${letter.recipientName}\nFecha: ${letter.sent_at || letter.created_at}\n\n${plainTextFromHtml(letter.body)}`;
    const blob = new Blob([`\ufeff${text}`], { type: 'text/plain;charset=utf-8' });
    this.downloadBlob(blob, `${this.fileName(letter.title)}.txt`);
  }

  async downloadHtml(letterId) {
    const data = await this.repository.get(letterId);
    const letter = data.letter;
    const title = escapeHtml(letter.title || 'Sin título');
    const sender = escapeHtml(letter.senderName || 'Remitente');
    const recipient = escapeHtml(letter.recipientName || 'Destinatario');
    const date = escapeHtml(new Date(letter.sent_at || letter.created_at).toLocaleString('es-CO', { dateStyle: 'long', timeStyle: 'short' }));
    const body = sanitizeRichHtml(letter.body || '');
    const documentHtml = `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><style>body{margin:0;padding:32px;background:#f4eee5;color:#403630;font:16px/1.8 Georgia,serif}.letter{max-width:760px;margin:24px auto;padding:clamp(28px,7vw,64px);background:#fffdf8;border:1px solid #eadfd2}.meta{display:flex;flex-wrap:wrap;gap:12px;color:#88776e;font:12px/1.5 Arial,sans-serif;border-bottom:1px solid #eadfd2;padding-bottom:18px;margin-bottom:26px}.body{overflow-wrap:anywhere}.body p{margin:.5em 0}.body blockquote{border-left:2px solid #c89f91;padding-left:15px;color:#765d52}</style></head><body><main class="letter"><h1>${title}</h1><div class="meta"><span>De: ${sender}</span><span>Para: ${recipient}</span><span>${date}</span></div><div class="body">${body}</div><p><em>Con cariño, ${sender}</em></p></main></body></html>`;
    const blob = new Blob([`\ufeff${documentHtml}`], { type: 'text/html;charset=utf-8' });
    this.downloadBlob(blob, `${this.fileName(letter.title)}.html`);
  }

  downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url; anchor.download = filename; anchor.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  fileName(title) { return (title || 'carta').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9-_]+/gi, '-').replace(/^-|-$/g, '').toLowerCase() || 'carta'; }

  async refreshSessions() {
    if (!this.session?.user || this.state.route !== 'settings' || !navigator.onLine) return;
    try {
      const result = await this.repository.sessions();
      const sessions = result.sessions || [];
      this.state.sessions = sessions;
      if (!sessions.some(item => item.isCurrent)) {
        this.forceLogout();
        return;
      }
      if (this.state.route === 'settings') this.render();
    } catch (error) {
      if (error.status === 401) this.forceLogout();
      throw error;
    }
  }

  async checkCurrentSession() {
    if (!this.session?.user || !navigator.onLine) return false;
    try {
      const result = await this.session.api.auth('session');
      if (result?.sessionId) {
        if (this.session.sessionId && this.session.sessionId !== result.sessionId) {
          this.forceLogout();
          return false;
        }
        this.session.sessionId = result.sessionId;
      }
      if (result?.user) {
        this.session.user = { ...this.session.user, ...result.user };
        this.state.user = this.session.user;
      }
      return true;
    } catch (error) {
      if (error.status !== 401) return false;
      // Si solo caducó el access token, rotamos el refresh token. Una sesión
      // revocada no podrá renovarlo y se cerrará automáticamente aquí mismo.
      try {
        await this.session.refreshSession();
        const verified = await this.session.api.auth('session');
        if (verified?.sessionId) this.session.sessionId = verified.sessionId;
        if (verified?.user) this.session.user = { ...this.session.user, ...verified.user };
        return true;
      } catch {
        this.forceLogout();
        return false;
      }
    }
  }

  startSessionRefreshPolling() {
    this.stopSessionRefreshPolling();
    this.sessionRefreshTimer = window.setInterval(() => {
      if (!this.session.user || document.hidden || !navigator.onLine) return;
      this.checkCurrentSession().then(valid => {
        if (valid && this.state.route === 'settings') this.refreshSessions().catch(() => {});
      }).catch(() => {});
    }, 10000);
  }

  stopSessionRefreshPolling() {
    if (this.sessionRefreshTimer) window.clearInterval(this.sessionRefreshTimer);
    this.sessionRefreshTimer = null;
  }

  async refreshNotifications() {
    const result = await this.repository.notifications();
    this.state.notifications = result.items || [];
    if (this.state.route !== 'notifications') this.render();
  }

  startNotificationPolling() {
    this.stopNotificationPolling();
    this.pollTimer = window.setInterval(() => {
      if (this.session.user && !document.hidden && navigator.onLine) this.refreshNotifications().catch(() => {});
    }, 45000);
  }

  stopNotificationPolling() { if (this.pollTimer) window.clearInterval(this.pollTimer); this.pollTimer = null; }

  forceLogout() {
    this.stopNotificationPolling();
    this.stopSessionRefreshPolling();
    this.invalidateRouteCache();
    this.state.routeLoading = false;
    this.applyTheme(this.readLastTheme() || 'system');
    this.session.clearSession();
    this.view.renderLogin('Tu sesión ha expirado. Vuelve a iniciar sesión.');
  }
}
