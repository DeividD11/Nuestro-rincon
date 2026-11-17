import { escapeHtml, sanitizeRichHtml } from '../utils/dom.js';
import { formatDate, greeting, initials, relativeDate } from '../utils/format.js';

const NAV = [
  { id: 'home', icon: '⌂', label: 'Inicio' },
  { id: 'inbox', icon: '✉', label: 'Mi buzón' },
  { id: 'sent', icon: '↗', label: 'Enviadas' },
  { id: 'write', icon: '✎', label: 'Escribir carta' },
  { id: 'drafts', icon: '▤', label: 'Borradores' },
  { id: 'favorites', icon: '♡', label: 'Favoritos' },
  { id: 'archive', icon: '⌑', label: 'Archivo' },
  { id: 'trash', icon: '⌫', label: 'Papelera' },
  { id: 'settings', icon: '⚙', label: 'Configuración' }
];

const PAGE_LABELS = {
  home: 'Nuestro espacio', inbox: 'Mi buzón', sent: 'Cartas enviadas', write: 'Escribir una carta',
  drafts: 'Borradores', favorites: 'Favoritos', archive: 'Archivo', trash: 'Papelera',
  letter: 'Una carta para recordar', notifications: 'Notificaciones', settings: 'Configuración'
};

const fmtBody = html => sanitizeRichHtml(html || '').replace(/^$/, '<p></p>');

export class AppView {
  constructor(root) { this.root = root; }

  renderBoot() {
    this.root.innerHTML = '<div class="boot-screen" role="status"><span class="brand-seal">N</span><p>Abriendo nuestro rincón…</p></div>';
  }

  renderLogin(error = '') {
    this.root.innerHTML = `
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

  renderRegister(error = '') {
    this.root.innerHTML = `
      <main class="auth-page"><section class="auth-story"><div class="brand-lockup"><span class="brand-seal">N</span><div><span class="brand-name">Nuestro Rincón</span><span class="brand-tagline">Correspondencia privada</span></div></div><div class="story-copy"><span class="eyebrow">Un espacio para dos</span><h1>Todo comienza con una cuenta.</h1><p>Crea tu acceso para empezar a escribir, recibir y conservar cartas.</p></div><p class="story-note">No necesitas correo electrónico ni claves de instalación.</p></section>
      <section class="auth-panel-wrap"><form class="auth-card" id="register-form"><span class="eyebrow">Crear cuenta</span><h2>Preparar tu espacio</h2><p>Elige tus datos de acceso. Este espacio admite hasta dos cuentas.</p>
        <div class="field"><label for="register-display">Cómo te llamamos</label><input id="register-display" name="displayName" required maxlength="80" autocomplete="name" placeholder="Tu nombre"></div>
        <div class="field"><label for="register-username">Nombre de usuario</label><input id="register-username" name="username" required minlength="3" maxlength="48" autocomplete="username" autocapitalize="none" spellcheck="false" placeholder="deivid.ñ_2026"><small class="muted">Admite letras, acentos, números y los símbolos punto, guion, guion bajo, @ y +. Sin espacios.</small></div>
        <div class="field"><label for="register-password">Contraseña</label><input id="register-password" name="password" type="password" required minlength="12" maxlength="128" autocomplete="new-password" placeholder="12 caracteres o más"><small class="muted">Usa una contraseña larga y única.</small></div>
        <div class="form-error" role="alert">${escapeHtml(error)}</div><button class="btn btn-primary btn-block" type="submit">Crear cuenta y entrar <span aria-hidden="true">→</span></button>
        <div class="auth-switch"><button class="text-button" type="button" data-action="show-login">Volver al inicio de sesión</button></div>
      </form></section></main>`;
  }

  renderRecovery(error = '') {
    this.root.innerHTML = `<main class="auth-page"><section class="auth-story"><div class="brand-lockup"><span class="brand-seal">N</span><div><span class="brand-name">Nuestro Rincón</span><span class="brand-tagline">Correspondencia privada</span></div></div><div class="story-copy"><span class="eyebrow">Volver a entrar</span><h1>Tu acceso sigue estando a salvo.</h1><p>Recupera tu cuenta con el código que guardaste al registrarte.</p></div><p class="story-note">El código se puede utilizar una sola vez.</p></section><section class="auth-panel-wrap"><form class="auth-card" id="recovery-form"><span class="eyebrow">Recuperación</span><h2>Restablecer contraseña</h2><p>Introduce tu usuario, tu código de recuperación y una contraseña nueva.</p><div class="field"><label for="recovery-username">Nombre de usuario</label><input id="recovery-username" name="username" autocomplete="username" autocapitalize="none" maxlength="48" required></div><div class="field"><label for="recovery-code">Código de recuperación</label><input id="recovery-code" name="recoveryCode" required autocomplete="off" autocapitalize="characters" spellcheck="false"></div><div class="field"><label for="recovery-password">Nueva contraseña</label><input id="recovery-password" name="password" type="password" minlength="12" maxlength="128" required autocomplete="new-password"></div><div class="form-error" role="alert">${escapeHtml(error)}</div><button class="btn btn-primary btn-block" type="submit">Cambiar contraseña</button><div class="auth-switch"><button class="text-button" type="button" data-action="show-login">Volver</button></div></form></section></main>`;
  }

  renderRecoveryCode(code) {
    this.root.innerHTML = `<main class="auth-page"><section class="auth-story"><div class="brand-lockup"><span class="brand-seal">N</span><div><span class="brand-name">Nuestro Rincón</span><span class="brand-tagline">Correspondencia privada</span></div></div><div class="story-copy"><span class="eyebrow">Guárdalo ahora</span><h1>Una copia de seguridad para tu acceso.</h1><p>Este código permite recuperar tu cuenta si olvidas la contraseña. Se muestra una sola vez.</p></div></section><section class="auth-panel-wrap"><div class="auth-card"><span class="eyebrow">Código personal</span><h2>Tu código de recuperación</h2><p>Guárdalo fuera de este dispositivo y no lo compartas. Si lo pierdes, no podremos restablecer la contraseña por correo.</p><pre class="recovery-list">${escapeHtml(code)}</pre><button class="btn btn-primary btn-block" type="button" data-action="copy-recovery">Copiar código</button><button class="btn btn-soft btn-block" type="button" data-action="continue-after-recovery" style="margin-top:9px">Ya lo guardé</button></div></section></main>`;
    this._recoveryCode = code;
  }

  renderShell(state) {
    const unread = state.dashboard?.unread || 0;
    const nav = NAV.map(item => `<a class="nav-link ${state.route === item.id ? 'active' : ''}" href="#/${item.id}" data-route="${item.id}"><span class="nav-icon" aria-hidden="true">${item.icon}</span><span>${item.label}</span>${item.id === 'inbox' && unread ? `<span class="nav-count">${unread}</span>` : ''}</a>`).join('');
    const displayName = escapeHtml(state.user?.displayName || state.user?.display_name || 'Mi cuenta');
    this.root.innerHTML = `
      <div class="mobile-scrim ${state.mobileNavOpen ? 'show' : ''}" data-action="close-mobile-nav"></div>
      <div class="app-shell">
        <aside class="sidebar ${state.mobileNavOpen ? 'open' : ''}" aria-label="Navegación principal">
          <div class="sidebar-brand"><span class="brand-seal">N</span><div><span class="brand-name">Nuestro Rincón</span><span class="brand-tagline">Cartas entre nosotros</span></div></div>
          <div class="nav-label">Correspondencia</div><nav class="nav-list">${nav}</nav>
          <div class="sidebar-bottom"><div class="user-mini"><span class="avatar">${escapeHtml(initials(displayName))}</span><div><strong>${displayName}</strong><small>Espacio privado</small></div></div><button class="btn btn-ghost" data-action="logout">↪ Cerrar sesión</button></div>
        </aside>
        <main class="main-area" id="main-content">
          <header class="topbar"><div class="topbar-left"><button class="icon-btn mobile-menu" data-action="open-mobile-nav" aria-label="Abrir menú">☰</button><div><div class="topbar-kicker">Nuestro Rincón</div><h1>${escapeHtml(PAGE_LABELS[state.route] || 'Correspondencia')}</h1></div></div><div class="topbar-actions"><button class="icon-btn" data-action="open-notifications" aria-label="Notificaciones" title="Notificaciones">♧${state.notifications.some(item => !item.read_at) ? '<span class="notification-dot"></span>' : ''}</button><button class="btn btn-primary" data-route="write">＋ Escribir</button></div></header>
          <div class="content-wrap">${this.renderRoute(state)}</div>
        </main>
      </div>`;
  }

  renderRoute(state) {
    if (state.routeLoading) return '<div class="route-skeleton" role="status" aria-label="Cargando contenido"><span class="skeleton-line wide"></span><span class="skeleton-line medium"></span><div class="skeleton-card"></div><div class="skeleton-card"></div><div class="skeleton-card short"></div></div>';
    if (state.routeError) return `<div class="route-error" role="alert"><span class="route-error-icon">↻</span><h2>No pudimos abrir esta sección</h2><p>${escapeHtml(state.routeError)}</p><div class="route-error-actions"><button class="btn btn-primary" data-action="retry-route">Volver a intentar</button><button class="btn btn-ghost" data-route="home">Ir al inicio</button></div></div>`;
    let content;
    switch (state.route) {
      case 'home': content = this.renderHome(state); break;
      case 'write': content = this.renderEditor(state); break;
      case 'letter': content = this.renderLetter(state); break;
      case 'notifications': content = this.renderNotifications(state); break;
      case 'settings': content = this.renderSettings(state); break;
      default: content = this.renderList(state);
    }
    const notice = state.routeNotice ? `<div class="route-notice" role="status"><span>${escapeHtml(state.routeNotice)}</span><button class="btn btn-ghost" data-action="retry-route">Actualizar</button></div>` : '';
    return notice + content;
  }

  renderHome(state) {
    const stats = state.dashboard || {};
    const recent = (stats.recent || []).slice(0, 4);
    const recentMarkup = recent.length ? `<div class="letter-list">${recent.map(item => this.letterCard(item, true)).join('')}</div>` : this.emptyState('✉', 'Aún no hay cartas', 'La primera carta puede comenzar cuando quieras.', '<button class="btn btn-primary" data-route="write">Escribir la primera carta</button>');
    return `<section class="greeting-card"><div class="greeting-copy"><span class="eyebrow">Un pequeño espacio para dos</span><h2>${greeting()}, ${escapeHtml(state.user?.displayName || 'qué alegría verte')}.</h2><p>Las palabras bonitas no tienen prisa. Aquí siempre hay un lugar para ellas.</p></div><div class="greeting-art" aria-hidden="true"><span class="greeting-art-glow"></span><span class="greeting-art-paper"></span><span class="greeting-art-envelope"></span><span class="greeting-art-seal">N</span><span class="greeting-art-spark greeting-art-spark-one">✦</span><span class="greeting-art-spark greeting-art-spark-two">✧</span></div></section>
      <div class="stat-grid"><div class="stat-card"><span>Cartas recibidas</span><strong>${Number(stats.received || 0)}</strong></div><div class="stat-card"><span>Por leer</span><strong>${Number(stats.unread || 0)}</strong></div><div class="stat-card"><span>Cartas enviadas</span><strong>${Number(stats.sent || 0)}</strong></div><div class="stat-card"><span>Borradores</span><strong>${Number(stats.drafts || 0)}</strong></div></div>
      <div class="two-col"><section><div class="section-head"><h3>Las últimas palabras</h3><a href="#/inbox" data-route="inbox">Ver buzón →</a></div>${recentMarkup}</section><aside class="panel"><h3>Un gesto sencillo</h3><p class="muted" style="font-size:12px;line-height:1.8">No hace falta esperar una fecha especial para decir algo importante. A veces, una carta pequeña se convierte en un recuerdo enorme.</p><button class="btn btn-soft btn-block" data-route="write">✎ Escribir con calma</button><div class="section-head"><h3>Tu espacio</h3></div><div style="font:italic 16px/1.8 var(--serif);color:#8b6f63">“Hay cosas que solo se entienden bien cuando se leen despacio.”</div></aside></div>`;
  }

  letterCard(item, compact = false) {
    const unread = Boolean(item.isUnread);
    const title = escapeHtml(item.title || 'Sin título');
    const other = escapeHtml(item.otherName || (item.status === 'draft' ? 'Borrador personal' : 'Correspondencia'));
    const date = item.sent_at || item.updated_at || item.created_at;
    const badge = item.isInTrash ? 'En papelera' : item.status === 'draft' ? 'Borrador' : item.isArchived ? 'Archivada' : item.isFavorite ? 'Favorita' : 'Carta';
    const icon = item.isInTrash ? '⌫' : item.status === 'draft' ? '✎' : item.isArchived ? '⌑' : '✉';
    const main = `<button type="button" class="letter-card-main" data-action="open-letter" data-letter-id="${escapeHtml(item.id)}" aria-label="Abrir ${title}"><span class="letter-info"><strong>${title}</strong><small>${item.status === 'draft' ? 'Borrador personal' : other} · ${escapeHtml(relativeDate(date))}</small></span><span class="letter-meta"><time>${escapeHtml(formatDate(date, {time:false}))}</time>${unread ? '<span class="status-pill unread">Sin leer</span>' : compact ? '' : `<span class="status-pill">${badge}</span>`}</span></button>`;
    if (compact) return `<article class="letter-card compact"><div class="letter-stamp" aria-hidden="true">${icon}</div>${main}</article>`;
    let actions = '';
    if (item.isInTrash) {
      actions = `<button type="button" class="btn btn-soft btn-small" data-action="restore-letter" data-letter-id="${escapeHtml(item.id)}">↶ Recuperar</button><button type="button" class="btn btn-danger btn-small" data-action="purge-letter" data-letter-id="${escapeHtml(item.id)}">Eliminar</button>`;
    } else if (item.status === 'draft') {
      actions = `<button type="button" class="btn btn-soft btn-small" data-action="edit-draft" data-letter-id="${escapeHtml(item.id)}">Seguir escribiendo</button><button type="button" class="btn btn-danger btn-small" data-action="trash-letter" data-letter-id="${escapeHtml(item.id)}" data-letter-status="${escapeHtml(item.status)}">Descartar</button>`;
    } else {
      actions = `<button type="button" class="btn btn-soft btn-small" data-action="toggle-favorite" data-favorite="${Boolean(item.isFavorite)}" data-letter-id="${escapeHtml(item.id)}">${item.isFavorite ? '♥ Favorita' : '♡ Favorito'}</button><button type="button" class="btn btn-soft btn-small" data-action="toggle-archive" data-archived="${Boolean(item.isArchived)}" data-letter-id="${escapeHtml(item.id)}">${item.isArchived ? '↶ Desarchivar' : '⌑ Archivar'}</button><button type="button" class="btn btn-danger btn-small" data-action="trash-letter" data-letter-id="${escapeHtml(item.id)}" data-letter-status="${escapeHtml(item.status)}">Descartar</button>`;
    }
    return `<article class="letter-card ${item.isInTrash ? 'in-trash' : ''}"><div class="letter-stamp" aria-hidden="true">${icon}</div>${main}<div class="letter-card-actions">${actions}</div></article>`;
  }

  emptyState(icon, title, description, action = '') {
    return `<div class="empty-state"><div class="empty-icon" aria-hidden="true">${icon}</div><strong>${title}</strong><p>${description}</p>${action}</div>`;
  }

  renderList(state) {
    const names = {
      inbox: ['Mi buzón', 'Las cartas que te han escrito'],
      sent: ['Cartas enviadas', 'Las palabras que ya compartiste'],
      drafts: ['Borradores', 'Cartas que aún están tomando forma'],
      favorites: ['Favoritos', 'Tus cartas más especiales'],
      archive: ['Archivo', 'Correspondencia que decidiste conservar'],
      trash: ['Papelera', 'Cartas descartadas; puedes recuperarlas o eliminarlas']
    };
    const [title, subtitle] = names[state.route] || names.inbox;
    const items = state.letters || [];
    const folderCopy = {
      drafts: ['✎', 'Todavía en preparación', 'Las cartas de aquí no se han enviado. Puedes continuar editándolas.'],
      archive: ['⌑', 'Guardadas aparte', 'Archivar oculta una carta de las bandejas principales, pero no la elimina.'],
      trash: ['⌫', 'Elementos descartados', 'Recupera una carta para devolverla a su sección o elimínala definitivamente.']
    }[state.route];
    const context = folderCopy ? `<aside class="folder-context folder-${state.route}"><span class="folder-context-icon">${folderCopy[0]}</span><div><strong>${folderCopy[1]}</strong><p>${folderCopy[2]}</p></div></aside>` : '';
    const empty = state.route === 'trash'
      ? this.emptyState('⌫', 'La papelera está vacía', 'Las cartas que descartes aparecerán aquí antes de su eliminación definitiva.')
      : state.route === 'archive'
        ? this.emptyState('⌑', 'Todavía no has archivado cartas', 'Usa la opción “Archivar” en una carta enviada o recibida para guardarla aquí.')
        : state.route === 'drafts'
          ? this.emptyState('✎', 'Todavía no hay borradores', 'Al guardar una carta como borrador, aparecerá aquí para que puedas continuar escribiéndola.', '<button class="btn btn-primary" data-route="write">Escribir carta</button>')
          : this.emptyState('✉', 'Todavía no hay cartas aquí', 'Cuando haya correspondencia en esta sección, la encontrarás aquí.');
    const cards = items.length ? `<div class="letter-list">${items.map(item => this.letterCard(item)).join('')}</div>` : empty;
    return `<div class="page-heading"><div><span class="eyebrow">Correspondencia</span><h2>${title}</h2><p>${subtitle}</p></div>${state.route === 'trash' ? '' : '<button class="btn btn-primary" data-route="write">＋ Escribir carta</button>'}</div>${context}<div class="search-row"><input id="letter-search" type="search" value="${escapeHtml(state.search)}" placeholder="Buscar por título o contenido…" aria-label="Buscar cartas"></div>${cards}`;
  }

  renderEditor(state) {
    const editor = state.editor || {};
    const title = escapeHtml(editor.title || '');
    const body = sanitizeRichHtml(editor.body || '');
    const status = editor.saving ? 'Guardando…' : editor.saved ? 'Guardado' : 'Se guardará automáticamente';
    return `<div class="page-heading"><div><span class="eyebrow">Una página en blanco</span><h2>${editor.letterId ? 'Continuar borrador' : 'Escribe algo bonito'}</h2><p>Escribe sin prisa. Tu borrador se guarda automáticamente.</p></div><button class="btn btn-ghost" data-action="cancel-editor">← Volver</button></div>
      <section class="editor-shell"><div class="editor-top"><span class="editor-overline">PARA TU PERSONA FAVORITA</span><strong id="save-status" class="editor-save-status">${status}</strong></div><div class="editor-title-field"><label for="editor-title">Asunto de tu carta</label><input id="editor-title" class="editor-input" maxlength="180" placeholder="Ponle un título especial…" value="${title}" aria-label="Título de la carta"></div><div class="editor-toolbar" role="toolbar" aria-label="Formato del texto"><div class="editor-toolbar-group"><button type="button" class="tool-btn" data-action="format-bold" title="Negrita" aria-label="Negrita"><b>B</b></button><button type="button" class="tool-btn" data-action="format-italic" title="Cursiva" aria-label="Cursiva"><i>I</i></button><button type="button" class="tool-btn" data-action="format-underline" title="Subrayado" aria-label="Subrayado"><u>U</u></button></div><span class="editor-toolbar-divider" aria-hidden="true"></span><div class="editor-toolbar-group"><button type="button" class="tool-btn" data-action="format-left" title="Alinear a la izquierda" aria-label="Alinear a la izquierda">☰</button><button type="button" class="tool-btn" data-action="format-center" title="Centrar" aria-label="Centrar">≡</button><button type="button" class="tool-btn" data-action="format-right" title="Alinear a la derecha" aria-label="Alinear a la derecha">☷</button></div><span class="editor-toolbar-hint">Formato sencillo</span></div><div class="editor-writing-surface"><div class="editor-writing-heading"><span>Tu carta</span><small>Escribe con calma</small></div><div id="letter-editor" class="letter-editor" contenteditable="true" role="textbox" aria-multiline="true" data-placeholder="Querida…

Hoy quería escribirte porque…">${body}</div></div><div class="editor-footer"><small>Se sincroniza automáticamente y mantiene una copia local de respaldo.</small><div class="btn-group"><button class="btn btn-soft" data-action="save-draft">Guardar borrador</button><button class="btn btn-primary" data-action="preview-send">Revisar y enviar →</button></div></div></section>`;
  }

  renderLetter(state) {
    const data = state.selectedLetter;
    if (!data) return this.emptyState('✉', 'No encontramos esta carta', 'Puede que ya no esté disponible.');
    const letter = data.letter;
    const isDraft = letter.status === 'draft';
    const senderName = escapeHtml(letter.senderName || 'Remitente');
    const recipientName = escapeHtml(letter.recipientName || 'Destinatario');
    const deliveryStatus = isDraft ? 'Borrador privado'
      : letter.readByRecipientAt ? `Leída el ${formatDate(letter.readByRecipientAt)}`
      : letter.sender_id === state.user?.id ? 'Entregada · pendiente de lectura'
      : 'Recibida · pendiente de lectura';
    const actions = letter.isInTrash
      ? `<button class="btn btn-primary" data-action="restore-letter" data-letter-id="${escapeHtml(letter.id)}">↶ Recuperar carta</button><button class="btn btn-danger" data-action="purge-letter" data-letter-id="${escapeHtml(letter.id)}">Eliminar definitivamente</button>`
      : isDraft
        ? `<button class="btn btn-soft" data-action="edit-draft" data-letter-id="${escapeHtml(letter.id)}">Seguir escribiendo</button><button class="btn btn-primary" data-action="preview-send-draft" data-letter-id="${escapeHtml(letter.id)}">Revisar y enviar</button><button class="btn btn-danger" data-action="trash-letter" data-letter-id="${escapeHtml(letter.id)}" data-letter-status="${escapeHtml(letter.status)}">Descartar</button>`
        : `<button class="btn btn-soft" data-action="toggle-favorite" data-favorite="${Boolean(letter.isFavorite)}" data-letter-id="${escapeHtml(letter.id)}">${letter.isFavorite ? '♥ Quitar favorito' : '♡ Guardar favorito'}</button><button class="btn btn-soft" data-action="toggle-archive" data-archived="${Boolean(letter.isArchived)}" data-letter-id="${escapeHtml(letter.id)}">${letter.isArchived ? '↶ Quitar del archivo' : '⌑ Archivar'}</button><button class="btn btn-soft" data-action="download-txt" data-letter-id="${escapeHtml(letter.id)}">↓ Descargar TXT</button><button class="btn btn-soft" data-action="download-html" data-letter-id="${escapeHtml(letter.id)}">↓ Descargar HTML</button><button class="btn btn-soft" data-action="print-letter">▤ Guardar como PDF</button><button class="btn btn-danger" data-action="trash-letter" data-letter-id="${escapeHtml(letter.id)}" data-letter-status="${escapeHtml(letter.status)}">Descartar</button>`;
    const timeline = (data.thread || []).map(item => `<article class="conversation-item"><div class="conversation-head"><span>${escapeHtml(item.senderName)} → ${escapeHtml(item.recipientName)}</span><time>${escapeHtml(formatDate(item.sent_at || item.created_at))}</time></div><h3>${escapeHtml(item.title || 'Sin título')}</h3><div class="letter-body">${fmtBody(item.body)}</div><div class="letter-actions no-print"><button class="btn btn-ghost" data-action="open-letter" data-letter-id="${escapeHtml(item.id)}">Abrir esta carta</button></div></article>`).join('');
    const paper = `<article class="letter-paper" id="printable-letter"><div class="letter-paper-inner"><span class="eyebrow">${isDraft ? 'Borrador privado' : 'Correspondencia personal'}</span><h2>${escapeHtml(letter.title || 'Sin título')}</h2><div class="letter-byline"><span>De: ${senderName}</span><span>Para: ${recipientName}</span><span>${escapeHtml(formatDate(letter.sent_at || letter.created_at))}</span>${!isDraft ? `<span class="delivery-status">${escapeHtml(deliveryStatus)}</span>` : ''}</div><div class="letter-body">${fmtBody(letter.body)}</div><p style="font:italic 15px var(--serif);color:#92766a;margin-top:32px">Con cariño, ${senderName}</p></div></article>`;
    return `<div class="page-heading"><div><span class="eyebrow">${isDraft ? 'En preparación' : 'Una carta recibida o enviada'}</span><h2>${escapeHtml(letter.title || 'Sin título')}</h2><p>${isDraft ? 'Este borrador solo tú puedes verlo.' : `${senderName} · ${escapeHtml(formatDate(letter.sent_at))} · ${escapeHtml(deliveryStatus)}`}</p></div><button class="btn btn-ghost" data-action="back-to-list">← Volver</button></div>${paper}<div class="letter-actions">${actions}${!isDraft && !letter.isInTrash ? `<button class="btn btn-primary" data-action="reply-letter" data-letter-id="${escapeHtml(letter.id)}">↩ Responder</button>` : ''}</div>${data.thread?.length > 1 ? `<section class="panel" style="margin-top:22px"><h3>Esta correspondencia</h3><div class="conversation-list">${timeline}</div></section>` : ''}`;
  }

  renderNotifications(state) {
    const items = state.notifications || [];
    const markup = items.length ? `<div class="notification-list">${items.map(item => `<article class="notification-item ${item.read_at ? '' : 'unread'}"><div class="letter-stamp">${item.notification_type?.includes('reply') ? '↩' : '✉'}</div><div style="flex:1;min-width:0"><p>${escapeHtml(item.message || 'Tienes una novedad en tu correspondencia.')}</p><small>${escapeHtml(formatDate(item.created_at))}</small></div>${item.read_at ? '' : `<button class="btn btn-ghost" data-action="read-notification" data-notification-id="${escapeHtml(item.id)}">Marcar leída</button>`}</article>`).join('')}</div>` : this.emptyState('♧', 'Todo está en calma', 'Cuando llegue una carta o una respuesta, aparecerá aquí.');
    return `<div class="page-heading"><div><span class="eyebrow">Avisos del buzón</span><h2>Notificaciones</h2><p>Solo las novedades de tu correspondencia.</p></div></div>${markup}`;
  }

  renderSettings(state) {
    const settings = state.settings || {};
    const sessions = state.sessions || [];
    const displayName = state.user?.displayName || '';
    const username = state.user?.username || '';
    const storedEmail = String(state.user?.email || '');
    const contactEmail = storedEmail.endsWith('@accounts.nuestro-rincon.invalid') ? '' : storedEmail;
    return `<div class="page-heading"><div><span class="eyebrow">Tu espacio privado</span><h2>Configuración</h2><p>Personaliza tu perfil, seguridad y preferencias de visualización.</p></div></div>
      <div class="settings-grid">
        <section class="setting-card profile-card"><div class="setting-card-heading"><span class="setting-card-icon">◎</span><div><h3>Perfil personal</h3><p>El nombre que aparece en tus cartas y dentro de la aplicación.</p></div></div><form id="profile-form"><div class="field"><label for="profile-name">Nombre para mostrar</label><input id="profile-name" name="displayName" value="${escapeHtml(displayName)}" maxlength="80" autocomplete="name" required></div><button class="btn btn-primary" type="submit">Guardar nombre</button></form></section>

        <section class="setting-card account-card"><div class="setting-card-heading"><span class="setting-card-icon">＠</span><div><h3>Datos de la cuenta</h3><p>Actualiza tu usuario o tu correo de contacto. Se requiere tu contraseña actual para confirmar.</p></div></div><form id="account-form"><div class="field"><label for="account-username">Nombre de usuario</label><input id="account-username" name="username" value="${escapeHtml(username)}" minlength="3" maxlength="48" autocomplete="username" autocapitalize="none" spellcheck="false" required><small class="muted">Letras, acentos, números y . _ @ + - (sin espacios).</small></div><div class="field"><label for="account-email">Correo electrónico de contacto</label><input id="account-email" name="email" type="email" value="${escapeHtml(contactEmail)}" maxlength="254" autocomplete="email" placeholder="tucorreo@ejemplo.com"><small class="muted">Es informativo: este proyecto no envía correos ni usa el correo para iniciar sesión o recuperar la cuenta.</small></div><div class="field"><label for="account-current-password">Contraseña actual</label><input id="account-current-password" name="currentPassword" type="password" autocomplete="current-password" minlength="12" maxlength="128" required></div><button class="btn btn-primary" type="submit">Guardar datos de cuenta</button></form></section>

        <section class="setting-card security-card"><div class="setting-card-heading"><span class="setting-card-icon">⌑</span><div><h3>Seguridad</h3><p>Cambia tu contraseña. Se cerrarán las demás sesiones activas y este dispositivo seguirá conectado.</p></div></div><form id="password-form"><div class="field"><label for="password-current">Contraseña actual</label><input id="password-current" name="currentPassword" type="password" autocomplete="current-password" minlength="12" maxlength="128" required></div><div class="field"><label for="password-new">Nueva contraseña</label><input id="password-new" name="newPassword" type="password" autocomplete="new-password" minlength="12" maxlength="128" required><small class="muted">Utiliza entre 12 y 128 caracteres y evita reutilizar una contraseña anterior.</small></div><div class="field"><label for="password-confirm">Confirmar nueva contraseña</label><input id="password-confirm" name="confirmPassword" type="password" autocomplete="new-password" minlength="12" maxlength="128" required></div><button class="btn btn-primary" type="submit">Actualizar contraseña</button></form></section>

        <section class="setting-card preferences-card"><div class="setting-card-heading"><span class="setting-card-icon">◐</span><div><h3>Preferencias</h3><p>Tu apariencia preferida se conserva en tu cuenta y se aplica también al acceso y registro.</p></div></div><form id="settings-form"><div class="field"><label for="settings-theme">Tema de la aplicación</label><select id="settings-theme" name="theme"><option value="light" ${settings.theme === 'light' ? 'selected' : ''}>Claro</option><option value="dark" ${settings.theme === 'dark' ? 'selected' : ''}>Oscuro</option><option value="system" ${settings.theme === 'system' ? 'selected' : ''}>Sistema (seguir dispositivo)</option></select><small class="muted">Sistema cambia automáticamente cuando cambias el tema de tu dispositivo.</small></div><div class="field"><label for="settings-timezone">Zona horaria</label><select id="settings-timezone" name="timeZone"><option value="America/Bogota" ${settings.time_zone === 'America/Bogota' ? 'selected' : ''}>Bogotá (Colombia)</option><option value="UTC" ${settings.time_zone === 'UTC' ? 'selected' : ''}>UTC</option><option value="America/Mexico_City" ${settings.time_zone === 'America/Mexico_City' ? 'selected' : ''}>Ciudad de México</option><option value="Europe/Madrid" ${settings.time_zone === 'Europe/Madrid' ? 'selected' : ''}>Madrid</option></select></div><div class="field setting-toggle-field"><label class="setting-toggle" for="settings-notifications"><span class="setting-toggle-copy"><strong>Notificaciones dentro de la aplicación</strong><small>Mostrar avisos de cartas y respuestas nuevas.</small></span><input id="settings-notifications" class="toggle-input" type="checkbox" name="notifications" ${settings.in_app_notifications_enabled ? 'checked' : ''}><span class="toggle-track" aria-hidden="true"></span></label></div><button class="btn btn-primary" type="submit">Guardar preferencias</button></form></section>

        <section class="setting-card sessions-card"><div class="setting-card-heading"><span class="setting-card-icon">▣</span><div><h3>Sesiones y dispositivos</h3><p>Sesiones activas de tu cuenta. Puedes cerrar las que ya no reconozcas.</p></div></div>${sessions.length ? `<div class="session-list">${sessions.map(item => `<article class="session-row ${item.isCurrent ? 'is-current' : ''}"><span class="session-device-icon" aria-hidden="true">${/mobile|android|iphone|ipad/i.test(item.device_label || item.user_agent || '') ? '▯' : '▣'}</span><div class="session-info"><div class="session-title"><strong>${escapeHtml(item.device_label || 'Navegador')}</strong>${item.isCurrent ? '<span class="status-pill current-session">Este dispositivo</span>' : ''}</div><small>Última actividad: ${escapeHtml(formatDate(item.last_seen_at))}</small><small>Sesión iniciada: ${escapeHtml(formatDate(item.created_at))}</small></div><div class="session-actions">${item.isCurrent ? '<span class="session-current-label">Sesión actual</span>' : `<button class="btn btn-danger btn-small" data-action="revoke-session" data-session-id="${escapeHtml(item.id)}">Revocar</button>`}</div></article>`).join('')}</div>` : '<div class="empty-sessions"><span>▣</span><p>No se encontraron sesiones activas.</p></div>'}</section>

        <section class="setting-card danger-zone-card"><div class="setting-card-heading"><span class="setting-card-icon danger-icon">!</span><div><h3>Eliminar mi cuenta</h3><p>Acción permanente: no podrás volver a iniciar sesión con esta cuenta.</p></div></div><div class="danger-explainer"><p>Se eliminarán tu perfil, preferencias, sesiones, avisos y borradores privados. Las cartas que ya enviaste podrán permanecer en el buzón de la otra persona, identificadas como <strong>Cuenta eliminada</strong>.</p><p>Para continuar, confirma tu contraseña actual y escribe <strong>ELIMINAR</strong>.</p></div><form id="delete-account-form" class="delete-account-form"><div class="field"><label for="delete-account-password">Contraseña actual</label><input id="delete-account-password" name="currentPassword" type="password" autocomplete="current-password" minlength="12" maxlength="128" required></div><div class="field"><label for="delete-account-confirmation">Escribe ELIMINAR para confirmar</label><input id="delete-account-confirmation" name="confirmation" type="text" autocomplete="off" autocapitalize="characters" spellcheck="false" pattern="ELIMINAR" required></div><button class="btn btn-danger" type="submit">Eliminar mi cuenta permanentemente</button></form></section>
      </div>`;
  }
}
