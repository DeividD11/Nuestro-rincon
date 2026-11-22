import { showToast } from '../utils/dom.js';
import { readPendingRecovery } from '../services/recovery-handoff.js';
import { handleSubmit } from './app-submit-handler.js';
import { handleClick } from './app-click-handler.js';

export class AppEventCoordinatorController {
  bindEvents() {
    this.root.addEventListener('click', event => this.onClick(event));
    this.root.addEventListener('submit', event => this.onSubmit(event));
    this.root.addEventListener('input', event => this.onInput(event));
    this.root.addEventListener('change', event => {
      if (event.target?.id === 'settings-theme') this.applyTheme(event.target.value);
      if (event.target?.id === 'recovery-vault-code-select') {
        const input = this.root.querySelector('#recovery-code');
        if (input) input.value = event.target.value;
      }
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

  async onSubmit(event) { return handleSubmit.call(this, event); }

  async onClick(event) { return handleClick.call(this, event); }
}
