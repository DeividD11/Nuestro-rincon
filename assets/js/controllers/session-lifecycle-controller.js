import { readPendingRecovery } from '../services/recovery-handoff.js';

export class SessionLifecycleController {
  setupSessionLifecycle() {
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
    this.state.pagination = { cursor: null, loadedCount: 0, limit: 40, hasMore: false, loading: false };
    this.state.selectedLetter = null;
    this.state.notifications = [];
    this.state.notificationPagination = { cursor: null, loadedCount: 0, limit: 30, hasMore: false, loading: false };
    this.state.dashboard = { received: 0, unread: 0, sent: 0, drafts: 0, recent: [] };
    this.state.sessions = [];
    this.state.invitation = null;
    this.state.settings = { theme: 'system', time_zone: 'America/Bogota', in_app_notifications_enabled: true };
    this.state.pushNotifications = { supported: null, configured: false, subscribed: false, permission: 'default', busy: false };
    this.state.editor = null;
    this.state.search = '';
    this.localDraftKey = null;
    this.draftIdentity.clear();
    this.pendingLetterActions.clear();
    this.state.routeError = null;
    this.state.routeNotice = null;
    this.state.routeLoading = false;
  }

  async restoreInitialSession() {
    // Si existe un código pendiente, mostrarlo ANTES de cualquier petición de
    // restauración de sesión. Cambiar de pestaña para copiarlo no debe lanzar
    // peticiones en segundo plano que reemplacen esta pantalla.
    const pendingRecovery = readPendingRecovery();
    if (pendingRecovery) {
      const recoveryCodes = Array.isArray(pendingRecovery.recoveryCodes)
        ? pendingRecovery.recoveryCodes
        : [pendingRecovery.recoveryCode];
      this._lastRecoveryCodes = recoveryCodes;
      this._lastRecoveryCode = recoveryCodes.join('\n');
      this._recoveryContinueRoute = ['rotation', 'rotation_bundle'].includes(pendingRecovery.purpose) ? 'settings' : 'home';
      const confirmed = pendingRecovery.serverConfirmed === true;
      const isBundle = ['registration_bundle', 'rotation_bundle'].includes(pendingRecovery.purpose);
      const purposeMessage = confirmed
        ? (isBundle ? 'El servidor confirmó los diez códigos de respaldo. Guárdalos fuera de este dispositivo o descarga una copia cifrada.' : 'El servidor confirmó este código. Cópialo y guárdalo fuera de este dispositivo.')
        : ['registration', 'registration_bundle'].includes(pendingRecovery.purpose)
          ? `La solicitud de registro pudo completarse aunque se haya perdido la respuesta. Conservamos ${isBundle ? 'los diez códigos' : 'este código'} temporalmente en el almacenamiento local de este navegador. Si necesitas repetir el alta, usa la misma invitación, usuario y contraseña; el servidor reconocerá el mismo intento sin consumir otra invitación.`
          : (isBundle
            ? 'La renovación pudo completarse aunque se haya perdido la respuesta. Conservamos los diez códigos en este navegador para que puedas repetir exactamente la misma operación y confirmar el resultado.'
            : 'La solicitud de renovación pudo completarse aunque se haya perdido la respuesta. Conservamos el nuevo código temporalmente en el almacenamiento local de este navegador.');
      this.view.renderRecoveryCode(isBundle ? recoveryCodes : recoveryCodes[0], {
        bundle: isBundle,
        message: purposeMessage,
        codePending: !confirmed,
        retryAvailable: !confirmed,
        retryLabel: ['registration', 'registration_bundle'].includes(pendingRecovery.purpose) ? 'Reintentar registro' : 'Reintentar renovación',
        continueLabel: isBundle ? 'Ya guardé los diez códigos; continuar' : 'Ya guardé el código; continuar'
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
}
