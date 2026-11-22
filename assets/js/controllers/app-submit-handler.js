import { putLocalDraft, getLocalDraft, deleteLocalDraft, getLocalDraftsForUser, deleteLocalDraftsForUser } from '../services/local-drafts.js';
import { ApiError } from '../services/api-client.js';
import { plainTextFromHtml, sanitizeRichHtml, showToast, showConfirmDialog, escapeHtml } from '../utils/dom.js';
import { readPendingRecovery, createPendingRegistration, clearPendingRecovery, markPendingRecoveryConfirmed, isUncertainRequestError } from '../services/recovery-handoff.js';
import { encryptRecoveryVault, decryptRecoveryVault, downloadRecoveryVault } from '../services/recovery-vault.js';

export async function handleSubmit(event) {
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
    const registrationCodes = Array.isArray(pending.recoveryCodes) ? pending.recoveryCodes : [pending.recoveryCode];
    this._lastRecoveryCodes = registrationCodes;
    this._lastRecoveryCode = registrationCodes.join('\n');
    this._recoveryContinueRoute = 'home';
    const result = await this.session.register({
      ...data,
      invitationCode: pending.invitationCode,
      displayName: pending.displayName,
      username: pending.username,
      requestId: pending.requestId,
      ...(pending.purpose === 'registration_bundle' ? { recoveryCodes: registrationCodes } : { recoveryCode: pending.recoveryCode })
    });
    data.password = '';
    history.replaceState(null, '', location.pathname);
    if (result.recoveryCodeCurrent === false) {
      this._lastRecoveryCode = '';
      this._lastRecoveryCodes = [];
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
    const registrationBundle = pending.purpose === 'registration_bundle';
    this.view.renderRecoveryCode(registrationBundle ? registrationCodes : registrationCodes[0], {
      bundle: registrationBundle,
      message: result.authenticated === false
        ? `La cuenta se creó y ${registrationBundle ? 'los diez códigos quedaron registrados' : 'el código quedó registrado'}, pero no se pudo abrir la sesión. Guarda ${registrationBundle ? 'los códigos' : 'el código'}; después inicia sesión con tu usuario y contraseña. Si hace falta, puedes reintentar el mismo registro sin gastar otra invitación.`
        : `Guarda ${registrationBundle ? 'los diez códigos' : 'el código'} fuera de este dispositivo y no los compartas. Se conservan temporalmente en este navegador hasta que confirmes que ya los guardaste.`,
      retryAvailable: result.authenticated === false,
      retryLabel: 'Reintentar el registro',
      continueLabel: this.session.user ? (registrationBundle ? 'Ya guardé los diez códigos' : 'Ya lo guardé') : (registrationBundle ? 'Ya guardé los diez códigos; ir al acceso' : 'Ya lo guardé; ir al acceso')
    });
  } else if (form.id === 'recovery-form') {
    await this.session.api.auth('recover-with-code', {
      username: data.username,
      recoveryCode: data.recoveryCode,
      password: data.password
    });
    showToast('La contraseña fue actualizada. Por seguridad se invalidaron los demás códigos de respaldo. Inicia sesión y genera un conjunto nuevo.', 'success');
    this.view.renderLogin();
  } else if (form.id === 'recovery-vault-import-form') {
    const file = data.vaultFile;
    if (!file || typeof file.text !== 'function' || file.size > 100_000) throw new Error('Selecciona una copia JSON válida de Nuestro Rincón.');
    const codes = await decryptRecoveryVault(await file.text(), data.passphrase);
    const select = this.root.querySelector('#recovery-vault-code-select');
    const input = this.root.querySelector('#recovery-code');
    const status = this.root.querySelector('#recovery-vault-import-status');
    if (!select || !input || !status) throw new Error('No se encontró el formulario de recuperación para cargar los códigos.');
    select.replaceChildren(...codes.map((code, index) => {
      const option = document.createElement('option');
      option.value = code;
      option.textContent = `Código de respaldo ${index + 1}`;
      return option;
    }));
    select.hidden = false;
    input.value = codes[0];
    status.textContent = 'Copia desbloqueada. Se encontraron diez códigos; elige uno que no hayas utilizado.';
    showToast('Copia protegida abierta. Selecciona un código disponible.', 'success');
    form.reset();
  } else if (form.id === 'recovery-vault-export-form') {
    if (data.passphrase !== data.confirmPassphrase) throw new Error('Las frases secretas no coinciden.');
    const codes = this._lastRecoveryCodes;
    if (!Array.isArray(codes) || codes.length !== 10) throw new Error('No hay diez códigos disponibles para proteger.');
    const vault = await encryptRecoveryVault(codes, data.passphrase);
    downloadRecoveryVault(vault);
    showToast('Copia cifrada descargada. Conserva también su frase secreta.', 'success');
    form.reset();
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
    this._recoveryContinueRoute = 'settings';
    this.stopSessionRefreshPolling();
    this.stopNotificationPolling();
    if (pending.purpose === 'rotation') {
      // Compatibilidad: no descartar una rotación de un solo código creada antes de esta versión.
      this._lastRecoveryCode = pending.recoveryCode;
      this._lastRecoveryCodes = [pending.recoveryCode];
      const result = await this.session.api.auth('recovery-code:rotate', {
        currentPassword: data.currentPassword,
        recoveryCode: pending.recoveryCode,
        requestId: pending.requestId
      });
      markPendingRecoveryConfirmed();
      this.view.renderRecoveryCode(pending.recoveryCode, {
        message: result.alreadyRotated
          ? 'La renovación anterior ya se había completado. Este es el mismo código; guárdalo fuera de este dispositivo.'
          : 'El código nuevo ya está activo y el anterior quedó invalidado. Guárdalo fuera de este dispositivo.',
        retryAvailable: true,
        retryLabel: 'Volver a Seguridad',
        continueLabel: 'Ya guardé el nuevo código'
      });
    } else {
      this._lastRecoveryCodes = pending.recoveryCodes;
      this._lastRecoveryCode = pending.recoveryCodes.join('\n');
      const result = await this.session.api.auth('recovery-codes:rotate', {
        currentPassword: data.currentPassword,
        recoveryCodes: pending.recoveryCodes,
        requestId: pending.requestId
      });
      markPendingRecoveryConfirmed();
      this.view.renderRecoveryCode(pending.recoveryCodes, {
        bundle: true,
        message: result.alreadyRotated
          ? 'Este conjunto de diez códigos ya se había activado. Es la misma operación; guárdalo o descarga la copia cifrada.'
          : 'Los diez códigos están activos. Cada uno se puede usar una sola vez. Los códigos anteriores quedaron invalidados.',
        retryAvailable: true,
        retryLabel: 'Volver a Seguridad',
        continueLabel: 'Ya guardé los diez códigos'
      });
    }
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
    if (['registration', 'registration_bundle'].includes(pending?.purpose)
      && (isUncertainRequestError(error) || error?.code === 'REGISTRATION_RETRY_CREDENTIALS_INVALID')) {
      const pendingCodes = Array.isArray(pending.recoveryCodes) ? pending.recoveryCodes : [pending.recoveryCode];
      const bundle = pending.purpose === 'registration_bundle';
      this._lastRecoveryCodes = pendingCodes;
      this._lastRecoveryCode = pendingCodes.join('\n');
      this._recoveryContinueRoute = 'home';
      const credentialsMismatch = error?.code === 'REGISTRATION_RETRY_CREDENTIALS_INVALID';
      this.view.renderRecoveryCode(bundle ? pendingCodes : pendingCodes[0], {
        bundle,
        codePending: true,
        message: credentialsMismatch
          ? 'El servidor reconoce que este intento pudo crear la cuenta, pero la contraseña introducida no coincide. No podemos confirmar desde este intento si el conjunto sigue activo o fue sustituido. Conserva esta copia, inicia sesión con la contraseña vigente y, si hace falta, genera un conjunto nuevo desde Configuración → Seguridad.'
          : `No recibimos confirmación del servidor. Por seguridad conservamos ${bundle ? 'los diez códigos' : 'el mismo código'} y la clave del intento en este navegador. El registro pudo haberse completado o quizá no llegó a ejecutarse: reintenta con la misma invitación, usuario y contraseña para que el servidor confirme o complete el alta sin consumir otra invitación.`,
        retryAvailable: true,
        retryLabel: 'Reintentar registro',
        continueLabel: bundle ? 'Ya guardé los diez códigos; ir al acceso' : 'Ya guardé el código; ir al acceso'
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
    if (['rotation', 'rotation_bundle'].includes(pending?.purpose) && isUncertainRequestError(error)) {
      const bundle = pending.purpose === 'rotation_bundle';
      const codes = bundle ? pending.recoveryCodes : [pending.recoveryCode];
      this._lastRecoveryCodes = codes;
      this._lastRecoveryCode = codes.join('\n');
      this._recoveryContinueRoute = 'settings';
      this.stopSessionRefreshPolling();
      this.stopNotificationPolling();
      this.view.renderRecoveryCode(bundle ? codes : codes[0], {
        bundle,
        codePending: true,
        message: bundle
          ? 'No recibimos confirmación de Supabase. Los diez códigos permanecen temporalmente en este navegador. Vuelve a Seguridad y repite exactamente la operación con tu contraseña actual; el servidor reconocerá la misma solicitud.'
          : 'No recibimos confirmación de Supabase. El código permanece temporalmente en este navegador. Repite exactamente la misma operación para confirmar el resultado.',
        retryAvailable: Boolean(this.session.user),
        retryLabel: 'Volver a Seguridad',
        continueLabel: bundle ? 'Ya guardé los diez códigos; continuar' : 'Ya guardé el código; continuar'
      });
    } else {
      // Un rechazo definitivo de la rotación no activa el código nuevo.
      clearPendingRecovery();
      this._lastRecoveryCode = '';
      this._lastRecoveryCodes = [];
      showToast(error.message || 'No se pudo renovar los códigos.', 'error');
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
