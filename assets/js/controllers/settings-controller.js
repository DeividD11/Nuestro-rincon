import { readPendingRecovery } from '../services/recovery-handoff.js';
import { AdaptivePoller } from '../services/adaptive-poller.js';
import { showToast } from '../utils/dom.js';
import { uploadPrivateMedia } from '../services/private-media-upload.js';

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
        const previousProfile = this.state.profile || { avatarUrl: null, avatarPath: null };
        const incomingProfile = result.profile || previousProfile;
        const sameAvatarPath = Boolean(previousProfile.avatarPath)
          && String(previousProfile.avatarPath) === String(incomingProfile.avatarPath || '');
        const canReuseAvatarImage = sameAvatarPath
          && (Boolean(previousProfile.previewUrl) || this.view?.avatarNodeCache?.hasSidebarImage?.(previousProfile));
        this.state.profile = sameAvatarPath
          ? {
              ...incomingProfile,
              // Mantener el objeto/URL actual solo si el nodo sigue cargando o
              // ya tiene píxeles. Si falló o nunca se creó, usar la firma nueva.
              avatarUrl: canReuseAvatarImage
                ? (previousProfile.avatarUrl || incomingProfile.avatarUrl || null)
                : (incomingProfile.avatarUrl || previousProfile.avatarUrl || null),
              previewUrl: previousProfile.previewUrl || null
            }
          : { ...incomingProfile, previewUrl: incomingProfile.previewUrl || null };
        this.syncAvatarFromProfile(previousProfile, this.state.profile);

        this.state.settings = { ...this.state.settings, ...(result.settings || {}) };
        this.cacheTheme(this.state.settings.theme);
        this.applyTheme(this.state.settings.theme);
        // Actualizar los controles sin reconstruir el árbol: así conservamos
        // los nodos de imagen ya descargados y decodificados.
        const themeControl = this.root.querySelector('#settings-theme');
        const timezoneControl = this.root.querySelector('#settings-timezone');
        const notificationsControl = this.root.querySelector('#settings-notifications');
        if (themeControl) themeControl.value = this.state.settings.theme || 'system';
        if (timezoneControl) timezoneControl.value = this.state.settings.time_zone || 'America/Bogota';
        if (notificationsControl) notificationsControl.checked = this.state.settings.in_app_notifications_enabled !== false;
        this.loadPushStatus().catch(() => {});
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

    syncAvatarFromProfile(previousProfile = {}, nextProfile = {}) {
      const cache = this.view?.avatarNodeCache;
      const previousIdentity = cache?.avatarIdentity?.(previousProfile) || '';
      const nextIdentity = cache?.avatarIdentity?.(nextProfile) || '';
      const nextUrl = nextProfile.previewUrl || nextProfile.avatarUrl || null;
      const previousUrl = previousProfile.previewUrl || previousProfile.avatarUrl || null;
      const sidebarNode = this.root.querySelector('.user-mini .avatar');
      const sidebarImage = sidebarNode?.querySelector('img');
      const sidebarImageMissing = Boolean(nextUrl && (!sidebarImage
        || (sidebarImage.complete && sidebarImage.naturalWidth === 0)));
      const needsRefresh = previousIdentity !== nextIdentity
        || (!previousUrl && Boolean(nextUrl))
        || sidebarImageMissing;

      if (needsRefresh) {
        this.updateAvatarPreview(nextUrl, {
          persisted: Boolean(nextProfile.avatarPath || nextProfile.avatarUrl),
          updateSidebar: true
        });
      } else {
        cache?.adopt?.(nextProfile);
      }
    }

    updateAvatarPreview(url, { persisted = Boolean(this.state.profile?.avatarUrl), updateSidebar = false } = {}) {
      const displayName = String(this.session.user?.displayName || this.session.user?.username || 'NR');
      const avatarInitials = displayName.split(/\s+/).slice(0, 2).map(part => part[0] || '').join('').toUpperCase();
      const updateContainer = (container, placeholderClass) => {
        if (!container) return;
        let placeholder = container.querySelector(`.${placeholderClass}`);
        if (!placeholder) {
          placeholder = document.createElement('span');
          placeholder.className = placeholderClass;
          placeholder.setAttribute('aria-hidden', 'true');
        }
        placeholder.textContent = avatarInitials;
        const currentImage = container.querySelector('img');
        const sameSource = Boolean(url && currentImage
          && (currentImage.getAttribute('src') === url || currentImage.src === url));
        if (!url) {
          currentImage?.remove();
          container.classList.remove('has-image', 'is-loading');
          container.setAttribute('aria-hidden', 'true');
          container.replaceChildren(placeholder);
          return;
        }
        container.classList.add('has-image');
        container.classList.toggle('is-loading', !sameSource || !currentImage?.complete || currentImage?.naturalWidth === 0);
        container.setAttribute('aria-hidden', 'true');
        if (sameSource) {
          if (placeholder.parentNode !== container) container.prepend(placeholder);
          return;
        }
        const image = document.createElement('img');
        image.alt = '';
        image.loading = 'eager';
        image.decoding = 'async';
        image.fetchPriority = 'high';
        image.referrerPolicy = 'no-referrer';
        container.replaceChildren(placeholder, image);
        image.src = url;
      };

      updateContainer(this.root.querySelector('.profile-avatar-preview'), 'avatar-preview-placeholder');

      const pickerLabel = this.root.querySelector('label[for="profile-avatar-input"]');
      if (pickerLabel) pickerLabel.textContent = url || persisted ? 'Cambiar avatar' : 'Agregar avatar';
      const controls = this.root.querySelector('.profile-avatar-controls');
      if (controls) {
        let removeButton = controls.querySelector('[data-action="remove-profile-avatar"]');
        if (persisted && !removeButton) {
          removeButton = document.createElement('button');
          removeButton.type = 'button';
          removeButton.className = 'btn btn-ghost btn-small';
          removeButton.dataset.action = 'remove-profile-avatar';
          removeButton.textContent = 'Quitar avatar';
          controls.insertBefore(removeButton, controls.querySelector('small'));
        } else if (!persisted) {
          removeButton?.remove();
        }
      }

      if (updateSidebar) {
        updateContainer(this.root.querySelector('.user-mini .avatar'), 'avatar-image-placeholder');
      }
      this.view?.avatarNodeCache?.adopt?.(this.state.profile);
    }

    async uploadProfileAvatar(file) {
      if (!file) return;
      if (!navigator.onLine) throw new Error('Necesitas conexión para actualizar tu avatar.');
      const previousProfile = { ...(this.state.profile || { avatarUrl: null, avatarPath: null }) };
      const previewUrl = URL.createObjectURL(file);
      this.state.profile = { ...previousProfile, previewUrl };
      // La vista previa aparece inmediatamente, antes de procesar o subir el archivo.
      this.updateAvatarPreview(previewUrl, { persisted: Boolean(previousProfile.avatarUrl), updateSidebar: true });

      try {
        const { prepareImageFile } = await import('../services/image-processing.js');
        const image = await prepareImageFile(file, { maxDimension: 512, maxBytes: 512 * 1024 });
        const media = await this.repository.prepareMediaUpload({ kind: 'avatar', mimeType: image.type, fileSize: image.size });
        await uploadPrivateMedia(media.uploadUrl, image);
        const result = await this.repository.setAvatar(media.path);
        const savedProfile = result.profile || { avatarPath: media.path, avatarUrl: null };
        const remoteUrl = savedProfile.avatarUrl || null;
        this.state.profile = {
          ...previousProfile,
          ...savedProfile,
          // Conserva el object URL local hasta que el recurso privado esté listo.
          previewUrl
        };
        this.view?.avatarNodeCache?.adopt?.(this.state.profile);

        if (remoteUrl) {
          // Precargar y decodificar antes de sustituir la foto local mantiene
          // una imagen visible durante toda la transición de Storage.
          const warmedImage = new Image();
          warmedImage.decoding = 'async';
          warmedImage.referrerPolicy = 'no-referrer';
          warmedImage.src = remoteUrl;
          try {
            if (typeof warmedImage.decode === 'function') await warmedImage.decode();
            else if (!warmedImage.complete) await new Promise((resolve, reject) => {
              warmedImage.onload = resolve;
              warmedImage.onerror = reject;
            });
            this.state.profile = { ...this.state.profile, previewUrl: null };
            this.updateAvatarPreview(remoteUrl, { persisted: true, updateSidebar: true });
            URL.revokeObjectURL(previewUrl);
          } catch {
            // La foto local sigue visible y válida aunque la URL firmada falle.
            this.state.profile = { ...this.state.profile, previewUrl };
          }
        } else {
          this.updateAvatarPreview(previewUrl, { persisted: Boolean(savedProfile.avatarPath), updateSidebar: true });
        }
        showToast('Tu avatar se actualizó.', 'success');
      } catch (error) {
        this.state.profile = previousProfile;
        this.updateAvatarPreview(previousProfile.previewUrl || previousProfile.avatarUrl || null, {
          persisted: Boolean(previousProfile.avatarUrl), updateSidebar: Boolean(previousProfile.avatarUrl)
        });
        URL.revokeObjectURL(previewUrl);
        throw error;
      }
    }

    async removeProfileAvatar() {
      const result = await this.repository.removeAvatar();
      this.state.profile = result.profile || { avatarPath: null, avatarUrl: null };
      this.render();
      showToast('Se quitó tu avatar.', 'success');
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
