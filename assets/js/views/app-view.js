import { escapeHtml } from '../utils/dom.js';
import { initials } from '../utils/format.js';
import { renderBoot, renderLogin, renderRegister, renderRecovery, renderRecoveryCode } from './auth-view.js';
import { renderHome, letterCard, emptyState, renderPagination, renderList, renderListResults, renderEditor, renderLetter, renderLetterDetail, renderLetterContent, renderNotifications } from './correspondence-view.js';
import { renderSettings } from './settings-view.js';
import { AvatarNodeCache } from './avatar-node-cache.js';

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

export class AppView {
  constructor(root) {
    this.root = root;
    this.avatarNodeCache = new AvatarNodeCache(root);
  }

  renderBoot() { return renderBoot(this); }

  renderLogin(error = '') { return renderLogin(this, error); }

  renderRegister(error = '', pending = null) { return renderRegister(this, error, pending); }

  renderRecovery(error = '') { return renderRecovery(this, error); }

  renderRecoveryCode(code, options = {}) { return renderRecoveryCode(this, code, options); }

  renderShell(state) {
    this.avatarNodeCache.capture(state.profile);

    const unread = state.dashboard?.unread || 0;
    const nav = NAV.map(item => `<a class="nav-link ${state.route === item.id ? 'active' : ''}" href="#/${item.id}" data-route="${item.id}" ${state.route === item.id ? 'aria-current="page"' : ''}><span class="nav-icon" aria-hidden="true">${item.icon}</span><span>${item.label}</span>${item.id === 'inbox' && unread ? `<span class="nav-count">${unread}</span>` : ''}</a>`).join('');
    const displayName = escapeHtml(state.user?.displayName || state.user?.display_name || 'Mi cuenta');
    const avatarInitials = escapeHtml(initials(state.user?.displayName || state.user?.display_name || state.user?.username || 'NR'));
    const avatarUrl = state.profile?.previewUrl || state.profile?.avatarUrl || '';
    const reuseSidebarAvatar = this.avatarNodeCache.hasSidebar(state.profile);
    const avatarMarkup = reuseSidebarAvatar
      ? '<span class="avatar" aria-hidden="true"></span>'
      : avatarUrl
        ? `<span class="avatar has-image is-loading" aria-hidden="true"><span class="avatar-image-placeholder" aria-hidden="true">${avatarInitials}</span><img src="${escapeHtml(avatarUrl)}" alt="" loading="eager" decoding="async" fetchpriority="high" referrerpolicy="no-referrer"></span>`
        : `<span class="avatar" aria-hidden="true">${avatarInitials}</span>`;
    this.root.innerHTML = `
      <a class="skip-link" href="#main-content">Saltar al contenido principal</a>
      <div class="mobile-scrim ${state.mobileNavOpen ? 'show' : ''}" data-action="close-mobile-nav" aria-hidden="true"></div>
      <div class="app-shell">
        <aside class="sidebar ${state.mobileNavOpen ? 'open' : ''}" aria-label="Menú de navegación">
          <div class="sidebar-brand"><span class="brand-seal" aria-hidden="true">N</span><div><span class="brand-name">Nuestro Rincón</span><span class="brand-tagline">Cartas entre nosotros</span></div><button class="icon-btn mobile-nav-close" type="button" data-action="close-mobile-nav" aria-label="Cerrar menú">×</button></div>
          <div class="nav-label">Correspondencia</div><nav id="primary-navigation" class="nav-list" aria-label="Principal">${nav}</nav>
          <div class="sidebar-bottom"><div class="user-mini">${avatarMarkup}<div><strong>${displayName}</strong><small>Espacio privado</small></div></div><button class="btn btn-ghost" type="button" data-action="logout">↪ Cerrar sesión</button></div>
        </aside>
        <main class="main-area" id="main-content" tabindex="-1" aria-labelledby="page-heading">
          <header class="topbar"><div class="topbar-left"><button class="icon-btn mobile-menu" type="button" data-action="open-mobile-nav" aria-label="Abrir menú" aria-expanded="${Boolean(state.mobileNavOpen)}" aria-controls="primary-navigation">☰</button><div><div class="topbar-kicker">Nuestro Rincón</div><h1 id="page-heading" tabindex="-1">${escapeHtml(PAGE_LABELS[state.route] || 'Correspondencia')}</h1></div></div><div class="topbar-actions"><button class="icon-btn" type="button" data-action="open-notifications" aria-label="Notificaciones" title="Notificaciones">♧${state.notifications.some(item => !item.read_at) ? '<span class="notification-dot" aria-hidden="true"></span>' : ''}</button><button class="btn btn-primary" type="button" data-route="write">＋ Escribir</button></div></header>
          <div class="content-wrap">${this.renderRoute(state)}</div>
        </main>
      </div>`;

    this.avatarNodeCache.restore(state.route, { restoreSidebar: reuseSidebarAvatar });
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
    const retryAction = state.route === 'letter' ? 'retry-letter' : 'retry-route';
    const notice = state.routeNotice ? `<div class="route-notice" role="status"><span>${escapeHtml(state.routeNotice)}</span><button class="btn btn-ghost" data-action="${retryAction}">Actualizar</button></div>` : '';
    return notice + content;
  }

  renderHome(state) { return renderHome(this, state); }

  letterCard(item, compact = false, state = {}) { return letterCard(this, item, compact, state); }

  emptyState(icon, title, description, action = '') { return emptyState(this, icon, title, description, action); }

  renderPagination(pagination, action, noun) { return renderPagination(this, pagination, action, noun); }

  renderList(state) { return renderList(this, state); }

  renderListResults(state) { return renderListResults(this, state); }

  renderEditor(state) { return renderEditor(this, state); }

  renderLetter(state) { return renderLetter(this, state); }

  renderLetterDetail(state) { return renderLetterDetail(this, state); }

  renderLetterContent(state) { return renderLetterContent(this, state); }

  renderNotifications(state) { return renderNotifications(this, state); }

  renderSettings(state) { return renderSettings(this, state); }

}
