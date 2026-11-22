import { escapeHtml } from '../utils/dom.js';

export function renderBoot(view) {
    view.root.innerHTML = '<div class="boot-screen" role="status"><span class="brand-seal">N</span><p>Abriendo nuestro rincón…</p></div>';
}

export function renderLogin(view, error = '') {
    view.root.innerHTML = `
      <main class="auth-page">
        <section class="auth-story">
          <div class="brand-lockup"><span class="brand-seal">N</span><div><span class="brand-name">Nuestro Rincón</span><span class="brand-tagline">Correspondencia privada</span></div></div>
          <div class="story-copy"><span class="eyebrow">Un lugar solo nuestro</span><h1>Hay palabras que merecen quedarse.</h1><p>Un pequeño buzón para escribir sin prisa, leer con calma y guardar cada carta como un recuerdo compartido.</p></div>
          <p class="story-note">“Lo que se escribe con cariño encuentra siempre su lugar.”</p>
        </section>
        <section class="auth-panel-wrap"><form class="auth-card" id="login-form">
          <span class="eyebrow">Bienvenidos de vuelta</span><h2>Entrar a nuestro rincón</h2><p>Inicia sesión con tu nombre de usuario.</p>
          <div class="field"><label for="login-identifier">Nombre de usuario</label><input id="login-identifier" name="identifier" autocomplete="username" autocapitalize="none" spellcheck="false" required maxlength="48" placeholder="Tu nombre de usuario"></div>
          <div class="field"><label for="login-password">Contraseña</label><input id="login-password" type="password" name="password" autocomplete="current-password" required placeholder="Tu contraseña"></div>
          <div class="form-error" role="alert">${escapeHtml(error)}</div>
          <button class="btn btn-primary btn-block" type="submit">Entrar <span aria-hidden="true">→</span></button>
          <div class="auth-switch">¿Todavía no tienes una cuenta? <button class="text-button" type="button" data-action="show-register">Crear cuenta</button><br><button class="text-button" type="button" data-action="show-recovery">¿Olvidaste tu contraseña?</button></div>
        </form></section>
      </main>`;
}

export function renderRegister(view, error = '', pending = null) {
    const locked = Boolean(['registration', 'registration_bundle'].includes(pending?.purpose));
    const invitationCode = escapeHtml(pending?.invitationCode || '');
    const displayName = escapeHtml(pending?.displayName || '');
    const username = escapeHtml(pending?.username || '');
    const lockedAttribute = locked ? 'readonly' : '';
    const retryNote = locked
      ? '<p class="form-notice" role="status">Para recuperar el mismo intento, utiliza la misma invitación, nombre visible y usuario. Vuelve a escribir la contraseña; nunca se conserva en este navegador.</p>'
      : '';
    view.root.innerHTML = `
      <main class="auth-page"><section class="auth-story"><div class="brand-lockup"><span class="brand-seal">N</span><div><span class="brand-name">Nuestro Rincón</span><span class="brand-tagline">Correspondencia privada</span></div></div><div class="story-copy"><span class="eyebrow">Un espacio para dos</span><h1>Todo comienza con una cuenta.</h1><p>Crea tu acceso para empezar a escribir, recibir y conservar cartas.</p></div><p class="story-note">No necesitas correo electrónico ni claves de instalación.</p></section>
      <section class="auth-panel-wrap"><form class="auth-card" id="register-form"><span class="eyebrow">Crear cuenta</span><h2>${locked ? 'Reintentar el registro' : 'Preparar tu espacio'}</h2><p>Elige tus datos de acceso. Este espacio admite hasta dos cuentas.</p>${retryNote}
        <div class="field"><label for="register-invitation">Código de invitación privada</label><input id="register-invitation" name="invitationCode" type="text" required minlength="35" maxlength="75" autocomplete="off" autocapitalize="characters" spellcheck="false" inputmode="text" placeholder="NR1-XXXXXXXX-…" value="${invitationCode}" ${lockedAttribute}><small class="muted">Necesitas un código personal de un solo uso, compartido contigo por la persona que ya tiene una cuenta.</small></div>
        <div class="field"><label for="register-display">Cómo te llamamos</label><input id="register-display" name="displayName" required maxlength="80" autocomplete="name" placeholder="Tu nombre" value="${displayName}" ${lockedAttribute}></div>
        <div class="field"><label for="register-username">Nombre de usuario</label><input id="register-username" name="username" required minlength="3" maxlength="48" autocomplete="username" autocapitalize="none" spellcheck="false" placeholder="deivid.ñ_2026" value="${username}" ${lockedAttribute}><small class="muted">Admite letras, acentos, números y los símbolos punto, guion, guion bajo, @ y +. Sin espacios.</small></div>
        <div class="field"><label for="register-password">Contraseña</label><input id="register-password" name="password" type="password" required minlength="12" maxlength="128" autocomplete="new-password" placeholder="12 caracteres o más"><small class="muted">Usa una contraseña larga y única. Por seguridad, no se guarda para los reintentos.</small></div>
        <div class="form-error" role="alert">${escapeHtml(error)}</div><button class="btn btn-primary btn-block" type="submit">${locked ? 'Reintentar con los mismos datos' : 'Crear cuenta y entrar'} <span aria-hidden="true">→</span></button>
        <div class="auth-switch"><button class="text-button" type="button" data-action="show-login">Volver al inicio de sesión</button></div>
      </form></section></main>`;
}

export function renderRecovery(view, error = '') {
    view.root.innerHTML = `<main class="auth-page"><section class="auth-story"><div class="brand-lockup"><span class="brand-seal">N</span><div><span class="brand-name">Nuestro Rincón</span><span class="brand-tagline">Correspondencia privada</span></div></div><div class="story-copy"><span class="eyebrow">Volver a entrar</span><h1>Tu acceso sigue estando a salvo.</h1><p>Recupera tu cuenta con uno de los códigos de respaldo que guardaste.</p></div><p class="story-note">Cada código se puede utilizar una sola vez.</p></section><section class="auth-panel-wrap"><div class="auth-card"><form id="recovery-form"><span class="eyebrow">Recuperación</span><h2>Restablecer contraseña</h2><p>Introduce tu usuario, uno de tus códigos de respaldo y una contraseña nueva.</p><div class="field"><label for="recovery-username">Nombre de usuario</label><input id="recovery-username" name="username" autocomplete="username" autocapitalize="none" maxlength="48" required></div><div class="field"><label for="recovery-code">Código de respaldo</label><input id="recovery-code" name="recoveryCode" required autocomplete="off" autocapitalize="characters" spellcheck="false"></div><div class="field"><label for="recovery-vault-code-select">Código seleccionado de la copia protegida</label><select id="recovery-vault-code-select" hidden aria-describedby="recovery-vault-import-status"></select><small id="recovery-vault-import-status" class="muted" role="status">También puedes escribir el código manualmente.</small></div><div class="field"><label for="recovery-password">Nueva contraseña</label><input id="recovery-password" name="password" type="password" minlength="12" maxlength="128" required autocomplete="new-password"></div><div class="form-error" role="alert">${escapeHtml(error)}</div><button class="btn btn-primary btn-block" type="submit">Cambiar contraseña</button><div class="auth-switch"><button class="text-button" type="button" data-action="show-login">Volver</button></div></form><details class="recovery-vault-import"><summary>Importar una copia de recuperación cifrada</summary><form id="recovery-vault-import-form"><p>Selecciona el archivo JSON protegido y escribe la frase secreta que utilizaste al descargarlo. La frase y los códigos se procesan en este navegador.</p><div class="field"><label for="recovery-vault-file">Copia cifrada (.json)</label><input id="recovery-vault-file" name="vaultFile" type="file" accept="application/json,.json" required></div><div class="field"><label for="recovery-vault-passphrase">Frase secreta de la copia</label><input id="recovery-vault-passphrase" name="passphrase" type="password" autocomplete="off" minlength="14" maxlength="256" required></div><button class="btn btn-soft btn-block" type="submit">Desbloquear copia</button></form></details></div></section></main>`;
}

export function renderRecoveryCode(view, code, options = {}) {
    const codes = Array.isArray(code) ? code : (code ? [String(code)] : []);
    const codeText = codes.join('\n');
    const bundle = options.bundle === true && codes.length === 10;
    const message = options.message || 'Guárdalo fuera de este dispositivo y no lo compartas. Si lo pierdes, no podremos restablecer la contraseña por correo.';
    const codeCurrent = options.codeCurrent !== false && Boolean(codeText);
    const codePending = options.codePending === true && Boolean(codeText);
    const codeVisible = codeCurrent || codePending;
    const retry = options.retryAvailable
      ? `<button class="btn btn-soft btn-block" type="button" data-action="retry-recovery-operation" style="margin-top:9px">${escapeHtml(options.retryLabel || 'Reintentar operación')}</button>`
      : '';
    const pendingNotice = codePending
      ? `<div class="form-notice recovery-pending-notice" role="status">${bundle ? 'Los diez códigos se generaron y se conservan temporalmente en este navegador, pero el servidor todavía no ha confirmado si el conjunto quedó activo.' : 'Este código se generó y se conserva en este navegador, pero el servidor todavía no ha confirmado si quedó activo.'} Completa o reintenta exactamente la misma operación.</div>`
      : '';
    const codesMarkup = bundle
      ? `<ol class="recovery-code-list">${codes.map((item, index) => `<li><span>${index + 1}.</span><code>${escapeHtml(item)}</code></li>`).join('')}</ol>`
      : `<pre class="recovery-list">${escapeHtml(codeText)}</pre>`;
    const exportVault = bundle && codeVisible
      ? `<form id="recovery-vault-export-form" class="recovery-vault-export"><h3>Descargar copia protegida</h3><p>El archivo se cifra en este navegador con AES-256-GCM. La frase secreta no se envía al servidor ni se guarda; sin ella no podrás abrir el archivo.</p><div class="field"><label for="recovery-vault-export-passphrase">Frase secreta (mínimo 14 caracteres)</label><input id="recovery-vault-export-passphrase" name="passphrase" type="password" autocomplete="new-password" minlength="14" maxlength="256" required></div><div class="field"><label for="recovery-vault-export-confirm">Repite la frase secreta</label><input id="recovery-vault-export-confirm" name="confirmPassphrase" type="password" autocomplete="new-password" minlength="14" maxlength="256" required></div><button class="btn btn-soft btn-block" type="submit">Descargar copia cifrada</button></form>`
      : '';
    const copy = codeVisible
      ? `${pendingNotice}<div class="recovery-code-display">${codesMarkup}</div><button class="btn btn-primary btn-block" type="button" data-action="copy-recovery">${bundle ? 'Copiar los diez códigos' : 'Copiar código'}</button>${exportVault}`
      : '<div class="form-notice" role="status">El código mostrado anteriormente ya no está activo. Inicia sesión y genera un conjunto nuevo desde Configuración → Seguridad.</div>';
    const continueLabel = options.continueLabel || 'Ya lo guardé';
    const title = codePending ? 'Códigos pendientes de confirmación' : codeCurrent ? (bundle ? 'Tus diez códigos de respaldo' : 'Tu código de recuperación') : 'Tus códigos necesitan renovarse';
    const storyCopy = bundle
      ? 'Estos diez códigos permiten recuperar tu cuenta si pierdes la contraseña. Cada uno funciona una sola vez; guárdalos fuera de este dispositivo.'
      : 'Este código permite recuperar tu cuenta si olvidas la contraseña. Guárdalo fuera de este dispositivo.';
    view.root.innerHTML = `<main class="auth-page"><section class="auth-story"><div class="brand-lockup"><span class="brand-seal">N</span><div><span class="brand-name">Nuestro Rincón</span><span class="brand-tagline">Correspondencia privada</span></div></div><div class="story-copy"><span class="eyebrow">Guárdalo ahora</span><h1>Una copia de seguridad para tu acceso.</h1><p>${escapeHtml(storyCopy)}</p></div></section><section class="auth-panel-wrap"><div class="auth-card"><span class="eyebrow">Códigos personales</span><h2>${title}</h2><p>${escapeHtml(message)}</p>${copy}${retry}<button class="btn btn-soft btn-block" type="button" data-action="continue-after-recovery" style="margin-top:9px">${escapeHtml(continueLabel)}</button></div></section></main>`;
    view._recoveryCode = codeVisible ? codeText : '';
}
