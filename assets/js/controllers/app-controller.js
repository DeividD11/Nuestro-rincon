import { AppState } from '../models/app-state.js';
import { AppView } from '../views/app-view.js';
import { putLocalDraft, getLocalDraft, deleteLocalDraft, getLocalDraftsForUser, deleteLocalDraftsForUser } from '../services/local-drafts.js';
import { ApiError } from '../services/api-client.js';
import { plainTextFromHtml, sanitizeRichHtml, showToast, showConfirmDialog, escapeHtml } from '../utils/dom.js';
import { readPendingRecovery, createPendingRegistration, createPendingRotation, clearPendingRecovery, markPendingRecoveryConfirmed, isUncertainRequestError } from '../services/recovery-handoff.js';

import { NavigationController } from './navigation-controller.js';
import { AuthController } from './auth-controller.js';
import { LetterController } from './letter-controller.js';
import { DraftController } from './draft-controller.js';
import { SettingsController } from './settings-controller.js';
import { NotificationController } from './notification-controller.js';
import { DraftSyncQueue } from '../services/draft-sync-queue.js';

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
    this.draftSyncQueue = new DraftSyncQueue();
    this.draftIdentity = new Map();
    // Un borrador descartado no debe resucitar por una sincronización pendiente.
    this.discardedDraftIds = new Set();
    this.notificationPoller = null;
    this.sessionPoller = null;
    this._sessionRevokedWhileRecoveryPending = false;
    this.sessionChannel = typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel('nuestro-rincon-session-events') : null;
    if (this.sessionChannel) {
      this.sessionChannel.onmessage = event => {
        const message = event.data || {};
        if (message.type === 'session-revoked' && message.sessionId && message.sessionId === this.session?.sessionId) {
          // La pantalla de entrega del código tiene prioridad: no se reemplaza
          // antes de que la persona pueda copiarlo. La sesión se descarta al
          // confirmar el guardado, sin volver a habilitar una sesión revocada.
          if (readPendingRecovery()) {
            this._sessionRevokedWhileRecoveryPending = true;
            return;
          }
          this.forceLogout();
        }
      };
    }
    this.localDraftKey = null;
    this._lastRecoveryCode = '';
    this._recoveryContinueRoute = 'home';
    this.routeCache = new Map();
    this.seenRoutes = new Set();
    this.routeRequestId = 0;
    this.routeCacheTtl = 60000;
    this.routePrefetches = new Map();
    this.routeCacheVersion = 0;
    this.letterThreadCache = new Map();
    this.pendingLetterActions = new Set();
    this.paginationObserver = null;
    this.editorInputVersion = 0;
    this.systemThemeMedia = window.matchMedia?.('(prefers-color-scheme: dark)') || null;
  }

  async init() {
    this.applyTheme(this.readLastTheme() || 'system');
    this.view.renderBoot();
    this.bindEvents();
    // Si existe un código pendiente, mostrarlo ANTES de cualquier petición de
    // restauración de sesión. Cambiar de pestaña para copiarlo no debe lanzar
    // peticiones en segundo plano que reemplacen esta pantalla.
    const pendingRecovery = readPendingRecovery();
    if (pendingRecovery) {
      this._lastRecoveryCode = pendingRecovery.recoveryCode;
      this._recoveryContinueRoute = pendingRecovery.purpose === 'rotation' ? 'settings' : 'home';
      const confirmed = pendingRecovery.serverConfirmed === true;
      const purposeMessage = confirmed
        ? 'El servidor confirmó este código. Cópialo y guárdalo fuera de este dispositivo. La pantalla permanecerá aquí hasta que confirmes que ya lo guardaste.'
        : pendingRecovery.purpose === 'registration'
          ? 'La solicitud de registro pudo completarse aunque se haya perdido la respuesta. Conservamos este código temporalmente en el almacenamiento local de este navegador. Si necesitas repetir el alta, usa la misma invitación, usuario y contraseña; el servidor reconocerá el mismo intento sin consumir otra invitación.'
          : 'La solicitud de renovación pudo completarse aunque se haya perdido la respuesta. Conservamos el nuevo código temporalmente en el almacenamiento local de este navegador. Si no recibiste confirmación, vuelve a Seguridad y repite la operación con tu contraseña actual.';
      this.view.renderRecoveryCode(pendingRecovery.recoveryCode, {
        message: purposeMessage,
        codePending: !confirmed,
        retryAvailable: !confirmed,
        retryLabel: pendingRecovery.purpose === 'registration' ? 'Reintentar registro' : 'Reintentar renovación',
        continueLabel: 'Ya guardé el código; continuar'
      });
      return;
    }
    const restored = await this.session.restore();
    if (!restored) {
      this.view.renderLogin();
      return;
    }
    this.resetPrivateSessionState(this.session.user);
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
      if (this.state.settings.theme === 'system') this.applyTheme('system');
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

  localDraftKeyFor(key) {
    const userId = this.session?.user?.id;
    if (!userId) throw new Error('No hay una sesión activa para acceder a borradores locales.');
    return `${userId}:${key}`;
  }

  resetPrivateSessionState(user = null) {
    // Nunca se reutiliza estado privado entre identidades. También invalida
    // peticiones de precarga que aún estén en vuelo para que no repueblen la caché.
    this.routeRequestId++;
    this.routeCacheVersion++;
    this.routeCache.clear();
    this.routePrefetches.clear();
    this.letterThreadCache.clear();
    this.seenRoutes.clear();
    this.state.user = user;
    this.state.letters = [];
    this.state.pagination = { offset: 0, nextOffset: 0, total: 0, limit: 40, hasMore: false, loading: false };
    this.state.selectedLetter = null;
    this.state.notifications = [];
    this.state.notificationPagination = { offset: 0, nextOffset: 0, total: 0, limit: 30, hasMore: false, loading: false };
    this.state.dashboard = { received: 0, unread: 0, sent: 0, drafts: 0, recent: [] };
    this.state.sessions = [];
    this.state.invitation = null;
    this.state.settings = { theme: 'system', time_zone: 'America/Bogota', in_app_notifications_enabled: true };
    this.state.editor = null;
    this.state.search = '';
    this.localDraftKey = null;
    this.draftIdentity.clear();
    this.pendingLetterActions.clear();
    this.state.routeError = null;
    this.state.routeNotice = null;
    this.state.routeLoading = false;
  }

  syncResponsiveAccessibility() {
    const narrow = window.matchMedia?.('(max-width: 1024px)')?.matches ?? window.innerWidth <= 1024;
    const sidebar = this.root.querySelector('.sidebar');
    const main = this.root.querySelector('#main-content');
    const skipLink = this.root.querySelector('.skip-link');
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
    if (skipLink) skipLink.toggleAttribute('inert', hideMain);
    if (trigger) trigger.setAttribute('aria-expanded', String(Boolean(narrow && this.state.mobileNavOpen)));
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
        this.resetPrivateSessionState(this.session.user);
        this.applyTheme(this.readCachedTheme() || 'system');
        this.loadPreferencesInBackground();
        await this.openRoute('home');
        this.startNotificationPolling();
        this.startSessionRefreshPolling();
      } else if (form.id === 'register-form') {
        const pending = this.getRegistrationRecoveryHandoff(data);
        this._lastRecoveryCode = pending.recoveryCode;
        this._recoveryContinueRoute = 'home';
        const result = await this.session.register({
          ...data,
          invitationCode: pending.invitationCode,
          displayName: pending.displayName,
          username: pending.username,
          requestId: pending.requestId,
          recoveryCode: pending.recoveryCode
        });
        data.password = '';
        history.replaceState(null, '', location.pathname);
        if (result.recoveryCodeCurrent === false) {
          this._lastRecoveryCode = '';
          clearPendingRecovery();
          this.state.user = this.session.user;
          this._recoveryContinueRoute = 'home';
          this.view.renderRecoveryCode('', {
            codeCurrent: false,
            message: result.message || 'La cuenta ya existe, pero el código de este intento fue sustituido. Inicia sesión y genera uno nuevo desde Configuración → Seguridad.',
            continueLabel: this.session.user ? 'Continuar a la aplicación' : 'Ir al inicio de sesión'
          });
          if (this.session.user) this.startSessionRefreshPolling();
          return;
        }
        if (result.recoveryCodeCurrent === true) markPendingRecoveryConfirmed();
        this.resetPrivateSessionState(this.session.user);
        if (this.session.user) {
          this.localDraftKey = this.localDraftKeyFor('new');
          this.applyTheme(this.readCachedTheme() || 'system');
          // No iniciar renovaciones periódicas mientras el código recién
          // emitido está visible. La persona debe poder copiarlo sin que una
          // comprobación de sesión reemplace esta pantalla. El polling se
          // reanuda al pulsar «Ya lo guardé».
          this.stopSessionRefreshPolling();
          this.stopNotificationPolling();
        }
        this.view.renderRecoveryCode(this._lastRecoveryCode, {
          message: result.authenticated === false
            ? 'La cuenta se creó y el código quedó registrado, pero no se pudo abrir la sesión. Guarda el código; después inicia sesión con tu usuario y contraseña. Si hace falta, puedes reintentar el mismo registro sin gastar otra invitación.'
            : 'Guárdalo fuera de este dispositivo y no lo compartas. El código se conserva en este navegador hasta que confirmes que ya lo guardaste.',
          retryAvailable: result.authenticated === false,
          retryLabel: 'Reintentar el registro',
          continueLabel: this.session.user ? 'Ya lo guardé' : 'Ya lo guardé; ir al acceso'
        });
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
      } else if (form.id === 'recovery-code-form') {
        const pending = this.getRotationRecoveryHandoff();
        this._lastRecoveryCode = pending.recoveryCode;
        this._recoveryContinueRoute = 'settings';
        this.stopSessionRefreshPolling();
        this.stopNotificationPolling();
        const result = await this.session.api.auth('recovery-code:rotate', {
          currentPassword: data.currentPassword,
          recoveryCode: pending.recoveryCode,
          requestId: pending.requestId
        });
        markPendingRecoveryConfirmed();
        this.view.renderRecoveryCode(pending.recoveryCode, {
          message: result.alreadyRotated
            ? 'La renovación ya se había completado. Este es el mismo código de esa operación; guárdalo fuera de este dispositivo.'
            : 'El código nuevo ya está activo y todos los códigos anteriores quedaron invalidados. Guárdalo fuera de este dispositivo.',
          retryAvailable: true,
          retryLabel: 'Volver a Seguridad',
          continueLabel: 'Ya guardé el nuevo código'
        });
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
        this.resetPrivateSessionState(null);
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
        this.invalidateRouteCache();
        showToast('Preferencias guardadas.', 'success');
        this.render();
      }
    } catch (error) {
      if (form.id === 'login-form') this.view.renderLogin(error.message);
      else if (form.id === 'register-form') {
        const pending = readPendingRecovery();
        if (pending?.purpose === 'registration'
          && (isUncertainRequestError(error) || error?.code === 'REGISTRATION_RETRY_CREDENTIALS_INVALID')) {
          this._lastRecoveryCode = pending.recoveryCode;
          this._recoveryContinueRoute = 'home';
          const credentialsMismatch = error?.code === 'REGISTRATION_RETRY_CREDENTIALS_INVALID';
          this.view.renderRecoveryCode(pending.recoveryCode, {
            codePending: true,
            message: credentialsMismatch
              ? 'El servidor reconoce que este intento pudo crear la cuenta, pero la contraseña introducida no coincide. No podemos confirmar desde este intento si el código sigue activo o fue sustituido. Conserva esta copia, inicia sesión con la contraseña vigente y, si hace falta, genera uno nuevo desde Configuración → Seguridad.'
              : 'No recibimos confirmación del servidor. Por seguridad conservamos el mismo código y la clave del intento en este navegador. El registro pudo haberse completado o quizá no llegó a ejecutarse: reintenta con la misma invitación, usuario y contraseña para que el servidor confirme o complete el alta sin consumir otra invitación.',
            retryAvailable: true,
            retryLabel: 'Reintentar registro',
            continueLabel: 'Ya guardé el código; ir al acceso'
          });
        } else {
          // Un rechazo definitivo significa que el RPC no confirmó el alta.
          // No mostrar un código temporal como si ya estuviera activo.
          clearPendingRecovery();
          this._lastRecoveryCode = '';
          this.view.renderRegister(error.message);
        }
      }
      else if (form.id === 'recovery-form') this.view.renderRecovery(error.message);
      else if (form.id === 'recovery-code-form') {
        const pending = readPendingRecovery();
        if (pending?.purpose === 'rotation' && isUncertainRequestError(error)) {
          this._lastRecoveryCode = pending.recoveryCode;
          this._recoveryContinueRoute = 'settings';
          this.stopSessionRefreshPolling();
          this.stopNotificationPolling();
          this.view.renderRecoveryCode(pending.recoveryCode, {
            codePending: true,
            message: 'No recibimos confirmación de Supabase. El nuevo código se conserva temporalmente en este navegador, pero aún no sabemos si quedó activo. Vuelve a Seguridad y repite la operación con tu contraseña actual; se reconocerá el mismo intento y no se generará un código distinto.',
            retryAvailable: Boolean(this.session.user),
            retryLabel: 'Volver a Seguridad',
            continueLabel: 'Ya guardé el código; continuar'
          });
        } else {
          // Un rechazo definitivo de la rotación no activa el código nuevo.
          clearPendingRecovery();
          this._lastRecoveryCode = '';
          showToast(error.message || 'No se pudo renovar el código.', 'error');
          if (this.session.user) {
            await this.openRoute('settings');
            this.loadPreferencesInBackground();
            this.startNotificationPolling();
            this.startSessionRefreshPolling();
          } else {
            this.view.renderLogin('Tu sesión terminó. Inicia sesión para gestionar tu código de recuperación.');
          }
        }
      }
      else showToast(error.message || 'No se pudo completar la operación.', 'error');
    } finally {
      if (button?.isConnected) { button.disabled = false; button.textContent = button.dataset.originalText || 'Continuar'; }
    }
  }

  async onClick(event) {
    const routeTarget = event.target.closest('[data-route]');
    if (routeTarget) {
      event.preventDefault();
      await this.openRoute(routeTarget.dataset.route, true, { focus: true });
      return;
    }
    const actionTarget = event.target.closest('[data-action]');
    if (!actionTarget) {
      const card = event.target.closest('[data-letter-id]');
      if (card?.dataset.letterId) await this.openLetter(card.dataset.letterId);
      return;
    }
    const action = actionTarget.dataset.action;
    const guardedLetterActions = new Set(['toggle-favorite','toggle-archive','trash-letter','restore-letter','purge-letter','reply-letter','edit-draft','preview-send-draft']);
    const guardedLetterId = guardedLetterActions.has(action) ? String(actionTarget.dataset.letterId || '') : '';
    const guardedButtons = guardedLetterId
      ? [...this.root.querySelectorAll('button[data-letter-id]')].filter(button => button.dataset.letterId === guardedLetterId)
      : [];
    if (guardedLetterId && this.pendingLetterActions.has(guardedLetterId)) return;
    const previousDisabled = guardedButtons.map(button => [button, button.disabled]);
    if (guardedLetterId) {
      this.pendingLetterActions.add(guardedLetterId);
      guardedButtons.forEach(button => { button.disabled = true; button.setAttribute('aria-busy', 'true'); });
    }
    try {
      switch (action) {
        case 'show-register': { const pending = readPendingRecovery(); this.view.renderRegister('', pending?.purpose === 'registration' ? pending : null); break; }
        case 'show-login': this.view.renderLogin(); break;
        case 'show-recovery': this.view.renderRecovery(); break;
        case 'copy-recovery': {
          if (!this._lastRecoveryCode) throw new Error('No hay un código disponible para copiar.');
          let copied = false;
          try {
            if (navigator.clipboard?.writeText) {
              await navigator.clipboard.writeText(this._lastRecoveryCode);
              copied = true;
            }
          } catch { /* Se intenta la copia compatible con navegadores antiguos. */ }
          if (!copied) {
            const field = document.createElement('textarea');
            field.value = this._lastRecoveryCode;
            field.setAttribute('readonly', '');
            field.style.position = 'fixed';
            field.style.opacity = '0';
            this.root.append(field);
            field.select();
            try { copied = document.execCommand('copy') === true; } catch { copied = false; }
            field.remove();
          }
          if (!copied) {
            const codeElement = this.root.querySelector('.recovery-list');
            if (codeElement) {
              const range = document.createRange();
              range.selectNodeContents(codeElement);
              const selection = window.getSelection();
              selection?.removeAllRanges();
              selection?.addRange(range);
            }
            throw new Error('No se pudo copiar automáticamente. El código quedó seleccionado para copiarlo manualmente.');
          }
          showToast('Código copiado. Guárdalo fuera de este dispositivo.', 'success');
          break;
        }
        case 'continue-after-recovery': await this.continueAfterRecoverySaved(); break;
        case 'retry-recovery-operation': await this.retryRecoveryOperation(); break;
        case 'open-mobile-nav': this.state.mobileNavOpen = true; this.render(); this.root.querySelector('.mobile-nav-close')?.focus?.({ preventScroll: true }); break;
        case 'close-mobile-nav': this.state.mobileNavOpen = false; this.render(); this.root.querySelector('.mobile-menu')?.focus?.({ preventScroll: true }); break;
        case 'logout': {
          const approved = await showConfirmDialog({
            tone: 'neutral', title: 'Cerrar sesión',
            message: '¿Quieres cerrar tu sesión en este dispositivo?',
            detail: 'Podrás volver a entrar con tu nombre de usuario y contraseña.',
            confirmLabel: 'Cerrar sesión', cancelLabel: 'Seguir aquí', icon: '↗'
          });
          if (approved) { await this.session.logout(); this.stopNotificationPolling(); this.stopSessionRefreshPolling(); this.resetPrivateSessionState(null); this.view.renderLogin(); }
          break;
        }
        case 'create-invitation': {
          actionTarget.disabled = true;
          const result = await this.session.api.auth('invitation:create');
          this.state.invitation = {
            ...(this.state.invitation || {}),
            canCreate: false,
            pending: true,
            expiresAt: result.expiresAt,
            revealedCode: result.code
          };
          this.invalidateRouteCache();
          this.render();
          showToast('Invitación generada. Copia y comparte el código en privado.', 'success');
          break;
        }
        case 'revoke-invitation': {
          const approved = await showConfirmDialog({
            tone: 'warning', title: 'Revocar invitación',
            message: 'El código dejará de ser válido inmediatamente.',
            detail: 'Si ya lo compartiste, la otra persona no podrá utilizarlo. Después podrás generar uno nuevo.',
            confirmLabel: 'Revocar código', cancelLabel: 'Conservar invitación'
          });
          if (!approved) break;
          await this.session.api.auth('invitation:revoke');
          this.state.invitation = { ...(this.state.invitation || {}), pending: false, canCreate: true, expiresAt: null, revealedCode: '' };
          this.invalidateRouteCache();
          this.render();
          showToast('La invitación fue revocada.', 'success');
          break;
        }
        case 'copy-invitation': {
          const code = this.state.invitation?.revealedCode;
          if (!code) throw new Error('El código ya no está disponible en esta pantalla.');
          await navigator.clipboard.writeText(code);
          showToast('Código de invitación copiado.', 'success');
          break;
        }
        case 'dismiss-invitation-code': {
          this.state.invitation = { ...(this.state.invitation || {}), revealedCode: '' };
          this.render();
          break;
        }
        case 'open-notifications': await this.openRoute('notifications', true, { focus: true }); break;
        case 'open-letter': {
          const targetId = actionTarget.dataset.letterId;
          const inThread = this.state.route === 'letter'
            ? this.state.selectedLetter?.thread?.find(item => String(item.id) === String(targetId))
            : null;
          await this.openLetter(targetId, true, inThread || this.letterSummary(targetId));
          break;
        }
        case 'retry-route': await this.openRoute(this.state.route, false); break;
        case 'retry-letter': await this.openLetter(this.state.selectedLetter?.letter?.id, false, this.state.selectedLetter?.letter); break;
        case 'back-to-list': await this.openRoute(this.previousListRoute, true, { focus: true }); break;
        case 'cancel-editor': await this.openRoute(this.previousListRoute || 'drafts', true, { focus: true }); break;
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
          const letterId = String(actionTarget.dataset.letterId || '');
          const source = this.state.selectedLetter?.letter?.id === letterId
            ? this.state.selectedLetter.letter
            : (this.state.letters || []).find(item => String(item.id) === letterId);
          if (!source) throw new Error('No encontramos la carta para actualizar el favorito.');
          const before = this.snapshotLetterState();
          const next = !Boolean(source.isFavorite);
          this.patchLetterState(letterId, { isFavorite: next }, { removeFromList: this.state.route === 'favorites' && !next });
          this.renderCurrentRoute();
          try {
            const result = await this.repository.setFavorite(letterId, next);
            if (result?.status !== 'updated') throw new Error('No se pudo actualizar el favorito. La carta puede estar en Papelera o ya no estar disponible.');
            this.invalidateRouteCache();
            showToast(next ? 'Añadida a Favoritos.' : 'Quitada de Favoritos.', 'success');
          } catch (error) {
            this.restoreLetterState(before);
            throw error;
          }
          break;
        }
        case 'toggle-archive': {
          const letterId = String(actionTarget.dataset.letterId || '');
          const source = this.state.selectedLetter?.letter?.id === letterId
            ? this.state.selectedLetter.letter
            : (this.state.letters || []).find(item => String(item.id) === letterId);
          if (!source) throw new Error('No encontramos la carta para actualizar el Archivo.');
          const before = this.snapshotLetterState();
          const next = !Boolean(source.isArchived);
          const removeFromList = (['inbox','sent'].includes(this.state.route) && next)
            || (this.state.route === 'archive' && !next);
          this.patchLetterState(letterId, { isArchived: next }, { removeFromList });
          this.renderCurrentRoute();
          try {
            const result = await this.repository.setArchive(letterId, next);
            if (result?.status !== 'updated') throw new Error('No se pudo actualizar el Archivo. La carta puede estar en Papelera o ya no estar disponible.');
            this.invalidateRouteCache();
            showToast(next ? 'Carta guardada en Archivo.' : 'Carta retirada del Archivo.', 'success');
          } catch (error) {
            this.restoreLetterState(before);
            throw error;
          }
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
          const letterId = String(actionTarget.dataset.letterId || '');
          const before = this.snapshotLetterState();
          this.state.letters = (this.state.letters || []).filter(item => String(item.id) !== letterId);
          if (this.state.selectedLetter?.letter?.id === letterId) this.state.selectedLetter = null;
          if (this.state.route === 'letter') {
            this.state.route = this.previousListRoute || 'trash';
            history.replaceState(null, '', `#/${this.state.route}`);
          }
          this.renderCurrentRoute();
          try {
            const restored = await this.repository.restore(letterId);
            if (restored.status !== 'restored') throw new Error('No se pudo recuperar la carta. Actualiza la lista e inténtalo de nuevo.');
            this.discardedDraftIds.delete(letterId);
            this.invalidateRouteCache();
            showToast('Carta recuperada.', 'success');
          } catch (error) {
            this.restoreLetterState(before);
            throw error;
          }
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
          const letterId = String(actionTarget.dataset.letterId || '');
          const before = this.snapshotLetterState();
          const optimisticAt = new Date().toISOString();
          // El botón cambia a estado de proceso mientras llega la respuesta,
          // pero no afirmamos que la confirmación quedó guardada antes del ACK.
          this.renderCurrentRoute();
          try {
            const result = await this.repository.purge(letterId);
            if (result.status === 'pending_other_participant' || result.status === 'already_confirmed_waiting') {
              this.patchLetterState(letterId, { purgeConfirmedAt: optimisticAt });
              showToast(result.status === 'pending_other_participant'
                ? 'Tu confirmación quedó guardada. La carta seguirá en Papelera hasta que la otra persona confirme.'
                : 'Ya habías confirmado. Solo falta que la otra persona confirme.', 'info', { duration: 6500 });
            } else if (result.status === 'purged' || result.status === 'already_purged') {
              this.state.letters = (this.state.letters || []).filter(item => String(item.id) !== letterId);
              if (this.state.selectedLetter?.letter?.id === letterId) this.state.selectedLetter = null;
              if (this.state.route === 'letter') {
                this.state.route = 'trash';
                history.replaceState(null, '', '#/trash');
              }
              showToast('El contenido se eliminó para ambas personas.', 'success');
            } else {
              throw new Error(result.status === 'not_in_trash'
                ? 'Primero mueve la carta a Papelera para eliminarla definitivamente.'
                : 'No se pudo confirmar la eliminación. Actualiza la Papelera e inténtalo de nuevo.');
            }
            this.invalidateRouteCache();
            this.renderCurrentRoute();
          } catch (error) {
            this.restoreLetterState(before);
            throw error;
          }
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
    } finally {
      if (guardedLetterId) {
        this.pendingLetterActions.delete(guardedLetterId);
        previousDisabled.forEach(([button, wasDisabled]) => {
          if (!button.isConnected) return;
          button.disabled = wasDisabled;
          button.removeAttribute('aria-busy');
        });
        if (previousDisabled.some(([button]) => !button.isConnected)) this.renderCurrentRoute();
      }
    }
  }

}

for (const modulePrototype of [
  NavigationController.prototype,
  AuthController.prototype,
  LetterController.prototype,
  DraftController.prototype,
  SettingsController.prototype,
  NotificationController.prototype
]) {
  const descriptors = Object.getOwnPropertyDescriptors(modulePrototype);
  delete descriptors.constructor;
  Object.defineProperties(AppController.prototype, descriptors);
}
