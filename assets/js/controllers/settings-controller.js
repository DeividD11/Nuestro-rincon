import { readPendingRecovery } from '../services/recovery-handoff.js';
import { AdaptivePoller } from '../services/adaptive-poller.js';
import { showToast } from '../utils/dom.js';

export class SettingsController {
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
        this.loadPushStatus().catch(() => {});
        if (this.state.route === 'settings') this.render();
      } catch { /* Un fallo de preferencias no debe bloquear el resto de la aplicación. */ }
    }

    async loadPushStatus() {
      if (!this.session?.user) return;
      const supported = Boolean(globalThis.isSecureContext
        && 'serviceWorker' in navigator && 'PushManager' in globalThis && 'Notification' in globalThis);
      const state = {
        supported,
        configured: false,
        subscribed: false,
        permission: supported ? Notification.permission : 'unsupported',
        busy: false
      };
      if (!supported) {
        this.state.pushNotifications = state;
        if (this.state.route === 'settings') this.render();
        return;
      }
      try {
        const backend = await this.repository.pushConfig();
        state.configured = backend.enabled === true && typeof backend.publicKey === 'string';
        const scope = new URL('./', document.baseURI).pathname;
        const registration = await navigator.serviceWorker.getRegistration(scope);
        const subscription = await registration?.pushManager.getSubscription();
        state.subscribed = Boolean(subscription && backend.subscribed === true);
        state.browserSubscription = Boolean(subscription);
        this.state.pushNotifications = state;
      } catch {
        state.configured = false;
        state.error = true;
        this.state.pushNotifications = state;
      }
      if (this.state.route === 'settings') this.render();
    }

    async enablePushNotifications() {
      const current = this.state.pushNotifications || {};
      if (!current.supported) throw new Error('Este navegador o dispositivo no admite notificaciones push en esta instalación.');
      const backend = await this.repository.pushConfig();
      if (backend.enabled !== true || !backend.publicKey) {
        throw new Error('Las notificaciones externas todavía no están configuradas en el servidor.');
      }

      let permission = Notification.permission;
      if (permission === 'default') permission = await Notification.requestPermission();
      if (permission !== 'granted') throw new Error('No se concedió permiso para mostrar notificaciones. Puedes activarlo en los ajustes del navegador.');

      const scopeUrl = new URL('./', document.baseURI);
      const workerUrl = new URL('./service-worker.js', document.baseURI);
      const registration = await navigator.serviceWorker.register(workerUrl.href, { scope: scopeUrl.pathname, updateViaCache: 'none' });
      await navigator.serviceWorker.ready;
      let subscription = await registration.pushManager.getSubscription();
      if (!subscription) {
        const padding = '='.repeat((4 - backend.publicKey.length % 4) % 4);
        const binary = atob(backend.publicKey.replace(/-/g, '+').replace(/_/g, '/') + padding);
        const applicationServerKey = Uint8Array.from(binary, character => character.charCodeAt(0));
        subscription = await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey });
      }
      await this.repository.subscribePush(subscription.toJSON());
      this.state.pushNotifications = {
        supported: true, configured: true, subscribed: true, browserSubscription: true,
        permission: Notification.permission, busy: false
      };
      this.render();
      showToast('Notificaciones externas activadas en este dispositivo.', 'success');
    }

    async disablePushNotifications() {
      const scope = new URL('./', document.baseURI).pathname;
      const registration = await navigator.serviceWorker.getRegistration(scope);
      const subscription = await registration?.pushManager.getSubscription();
      if (subscription) {
        await this.repository.unsubscribePush(subscription.endpoint);
        await subscription.unsubscribe();
      }
      this.state.pushNotifications = {
        ...(this.state.pushNotifications || {}), subscribed: false, browserSubscription: false,
        permission: typeof Notification === 'undefined' ? 'unsupported' : Notification.permission
      };
      this.render();
      showToast('Las notificaciones externas se desactivaron en este dispositivo.', 'success');
    }

    async refreshSessions() {
      // La pantalla de entrega del código debe permanecer visible incluso si la
      // persona cambia de pestaña para copiarlo o guardarlo en otro lugar.
      if (readPendingRecovery() || !this.session?.user || this.state.route !== 'settings' || !navigator.onLine) return;
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
      // No reemplazar el handoff del código por una comprobación de sesión al
      // volver a la pestaña. La validación se reanuda tras la confirmación manual.
      if (readPendingRecovery() || !this.session?.user || !navigator.onLine) return false;
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
      if (readPendingRecovery() || !this.session?.user) return;
      this.sessionPoller = new AdaptivePoller({
        enabled: () => Boolean(this.session?.user) && !readPendingRecovery(),
        activeIntervalMs: 5 * 60_000,
        idleIntervalMs: 15 * 60_000,
        idleAfterMs: 2 * 60_000,
        minRefreshGapMs: 60_000,
        maxBackoffMs: 30 * 60_000,
        task: async () => {
          const valid = await this.checkCurrentSession();
          if (!valid && this.session?.user) throw new Error('SESSION_CHECK_FAILED');
          if (valid && this.state.route === 'settings') await this.refreshSessions();
          return valid;
        },
        onError: error => {
          if (error?.status === 401) this.forceLogout();
        }
      });
      this.sessionPoller.start();
    }

    stopSessionRefreshPolling() {
      this.sessionPoller?.stop();
      this.sessionPoller = null;
    }
}
