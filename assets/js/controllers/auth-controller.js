import { showConfirmDialog } from '../utils/dom.js';
import { readPendingRecovery, createPendingRegistration, createPendingRecoveryCodeBundle, clearPendingRecovery } from '../services/recovery-handoff.js';

export class AuthController {
    getRegistrationRecoveryHandoff(data) {
      const existing = readPendingRecovery();
      const normalize = value => String(value || '').normalize('NFKC').trim().toLocaleLowerCase('es-CO');
      const normalizeInvite = value => String(value || '').normalize('NFKC').replace(/[\s-]/g, '').toUpperCase();
      if (['registration', 'registration_bundle'].includes(existing?.purpose)
        && normalize(existing.username) === normalize(data.username)
        && normalizeInvite(existing.invitationCode) === normalizeInvite(data.invitationCode)) {
        return existing;
      }
      return createPendingRegistration(data);
    }

    getRotationRecoveryHandoff() {
      const existing = readPendingRecovery();
      return ['rotation', 'rotation_bundle'].includes(existing?.purpose) ? existing : createPendingRecoveryCodeBundle();
    }

    async continueAfterRecoverySaved() {
      const approved = await showConfirmDialog({
        tone: 'neutral',
        title: '¿Ya guardaste el código?',
        message: 'Antes de continuar, confirma que guardaste todos los códigos fuera de este dispositivo o descargaste la copia cifrada.',
        detail: 'Al continuar, la copia temporal se eliminará de este navegador y no podremos volver a mostrar el mismo código.',
        confirmLabel: 'Sí, ya lo guardé',
        cancelLabel: 'Seguir en esta pantalla'
      });
      if (!approved) return;
      const route = this._recoveryContinueRoute || 'home';
      clearPendingRecovery();
      this._lastRecoveryCode = '';
      this._lastRecoveryCodes = [];
      this._recoveryContinueRoute = 'home';
      history.replaceState(null, '', location.pathname);
      if (this._sessionRevokedWhileRecoveryPending) {
        this._sessionRevokedWhileRecoveryPending = false;
        this.session.clearSession();
        this.view.renderLogin('La sesión se revocó en otro dispositivo. El código quedó guardado; inicia sesión para continuar.');
        return;
      }
      if (!this.session.user && this.session.refreshToken) {
        await this.session.restore();
      }
      if (!this.session.user) {
        this.view.renderLogin();
        return;
      }
      this.resetPrivateSessionState(this.session.user);
      this.applyTheme(this.readCachedTheme() || 'system');
      if (route === 'home') {
        this.localDraftKey = this.localDraftKeyFor('new');
        this.restoreEmergencyDraft().catch(() => {});
      }
      await this.openRoute(route);
      this.loadPreferencesInBackground();
      this.startNotificationPolling();
      this.startSessionRefreshPolling();
    }

    async retryRecoveryOperation() {
      const pending = readPendingRecovery();
      if (!pending) {
        this.view.renderLogin();
        return;
      }
      if (['registration', 'registration_bundle'].includes(pending.purpose)) {
        this.view.renderRegister('', pending);
        this.root.querySelector('#register-password')?.focus();
        return;
      }
      if (!this.session.user && this.session.refreshToken) await this.session.restore();
      if (!this.session.user) {
        this.view.renderLogin('Inicia sesión para terminar de confirmar la renovación del código.');
        return;
      }
      await this.openRoute('settings');
      this.root.querySelector('#recovery-rotate-password')?.focus();
    }

    forceLogout() {
      this.stopNotificationPolling();
      this.stopSessionRefreshPolling();
      this.resetPrivateSessionState(null);
      this.applyTheme(this.readLastTheme() || 'system');
      this.session.clearSession();
      this.view.renderLogin('Tu sesión ha expirado. Vuelve a iniciar sesión.');
    }
}
