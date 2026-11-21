import { showToast } from '../utils/dom.js';

export class NavigationController {
    routeFromHash() {
      const match = location.hash.match(/^#\/?([a-z-]+)/i);
      return match?.[1] || null;
    }

    focusPageHeading() {
      const heading = this.root?.querySelector?.('#page-heading');
      if (!heading || typeof heading.focus !== 'function') return false;
      try { heading.focus({ preventScroll: true }); } catch { heading.focus(); }
      return true;
    }

    async openRoute(route, updateHash = true, options = {}) {
      const shouldFocus = options?.focus === true;
      const focusHeading = () => {
        if (shouldFocus && this.state.route === route) this.focusPageHeading();
      };
      const previousRoute = this.state.route;
      const allowed = new Set(['home','inbox','sent','write','drafts','favorites','archive','trash','letter','notifications','settings']);
      if (!allowed.has(route) || route === 'letter') route = 'home';
  
      // La copia local ya se actualiza en cada pulsación. Al cambiar de sección,
      // no esperamos la red: persistimos la última instantánea y sincronizamos en segundo plano.
      if (this.state.route === 'write' && route !== 'write' && this.state.editor) {
        window.clearTimeout(this.autosaveTimer);
        const snapshot = { ...this.state.editor, ...this.readEditorFromDom() };
        const storageKey = this.localDraftKey || this.localDraftKeyFor(snapshot.letterId ? `letter:${snapshot.letterId}` : 'new');
        this.state.editor = null;
        this.localDraftKey = storageKey;
        // Entrar y salir del editor sin escribir el cuerpo no genera un borrador.
        // Una carta ya existente sigue guardando incluso si se vacía para editarla.
        if (snapshot.letterId || this.hasDraftBody(snapshot.body)) {
          // No retrasar el cambio de sección esperando IndexedDB: la cola se resuelve aparte.
          this.queueDraftSync(snapshot, storageKey);
        } else {
          this.clearEmptyNewDraft(storageKey).catch(() => {});
        }
      }
  
      let editorHydration = null;
      if (route === 'write' && !this.state.editor) {
        if (!this.localDraftKey) this.localDraftKey = this.localDraftKeyFor('new');
        const draftKey = this.localDraftKey;
        const emergency = this.readEmergencyDraft(draftKey);
        const initialEditor = {
          letterId: null,
          creationRequestId: crypto.randomUUID(),
          title: '',
          body: '',
          revision: 1,
          parentLetterId: null,
          saving: false,
          saved: false,
          pendingSync: false
        };
        this.state.editor = emergency
          ? { ...initialEditor, ...emergency, creationRequestId: emergency.creationRequestId || initialEditor.creationRequestId }
          : initialEditor;
        editorHydration = { key: draftKey, identity: this.state.editor.creationRequestId };
      }
  
      if (route !== 'letter' && route !== 'write' && route !== 'notifications' && route !== 'settings') this.previousListRoute = route;
      if (previousRoute !== route && ['inbox','sent','drafts','favorites','archive','trash'].includes(route)) {
        // No mostrar ni un frame de la lista anterior mientras llega el nuevo buzón.
        this.state.letters = [];
        this.state.pagination = { cursor: null, loadedCount: 0, limit: 40, hasMore: false, loading: false };
      }
      this.state.route = route;
      this.state.routeError = null;
      this.state.routeNotice = null;
      this.state.mobileNavOpen = false;
      if (updateHash && location.hash !== `#/${route}`) history.replaceState(null, '', `#/${route}`);
  
      if (route === 'write') {
        this.state.routeLoading = false;
        this.render();
        focusHeading();
        if (editorHydration) this.hydrateEditorFromLocal(editorHydration.key, editorHydration.identity).catch(() => {});
        if (this.state.editor?.pendingSync || this.state.editor?.localOnly) {
          this.saveDraft(true).catch(() => {});
        }
        return;
      }
  
      const cacheKey = this.routeCacheKey(route);
      const cached = this.routeCache.get(cacheKey);
      const requestId = ++this.routeRequestId;
      const hasVisited = this.seenRoutes.has(route);
      this.seenRoutes.add(route);
  
      // Primero se muestra la última vista disponible. La red actualiza después
      // sin vaciar la página ni volver a mostrar placeholders al navegar.
      if (cached && Date.now() - cached.at <= this.routeCacheTtl) {
        this.applyRouteData(route, cached.data);
        this.state.routeError = null;
        this.state.routeLoading = false;
        this.render();
        focusHeading();
        return;
      }
  
      const prefetched = this.routePrefetches.get(cacheKey);
      if (prefetched) {
        this.state.routeLoading = !hasVisited || (['inbox','sent','drafts','favorites','archive','trash'].includes(route) && !this.state.letters.length);
        this.render();
        await prefetched;
        if (requestId !== this.routeRequestId || this.state.route !== route) return;
        const ready = this.routeCache.get(cacheKey);
        if (ready) {
          this.applyRouteData(route, ready.data);
          this.state.routeError = null;
          this.state.routeLoading = false;
          this.render();
          focusHeading();
          return;
        }
      }
  
      this.state.routeLoading = !hasVisited || (['inbox','sent','drafts','favorites','archive','trash'].includes(route) && !this.state.letters.length);
      // En rutas ya visitadas conservamos el contenido anterior mientras llega la
      // consulta nueva. Así no parpadea una lista vacía ni reaparece el placeholder.
      this.render();
      await this.refreshRouteData(route, cacheKey, requestId, hasVisited);
      focusHeading();
    }

    routeCacheKey(route) {
      const accountId = this.session?.user?.id || 'guest';
      return `${route}:${accountId}:${['inbox','sent','drafts','favorites','archive','trash'].includes(route) ? this.state.search : ''}`;
    }

    uniqueLetters(items = []) {
      const seen = new Set();
      return items.filter(item => {
        const id = item?.id == null ? '' : String(item.id);
        if (!id || seen.has(id)) return false;
        seen.add(id);
        return true;
      });
    }

    letterSummary(letterId) {
      const id = String(letterId || '');
      return this.uniqueLetters([
        ...(this.state.letters || []),
        ...(this.state.dashboard?.recent || []),
        ...(this.state.selectedLetter?.thread || []),
        ...(this.state.selectedLetter?.letter ? [this.state.selectedLetter.letter] : [])
      ]).find(item => String(item.id) === id) || null;
    }

    prefetchRoute(route) {
      if (!route || route === 'write' || route === 'letter' || route === 'settings' && !this.session.user) return;
      const allowed = new Set(['home','inbox','sent','drafts','favorites','archive','trash','notifications','settings']);
      if (!allowed.has(route)) return;
      const key = this.routeCacheKey(route);
      const cached = this.routeCache.get(key);
      if (cached && Date.now() - cached.at <= this.routeCacheTtl) return;
      if (this.routePrefetches.has(key)) return;
      const cacheVersion = this.routeCacheVersion;
      const task = this.fetchRouteData(route)
        .then(data => {
          if (cacheVersion !== this.routeCacheVersion) return;
          this.routeCache.set(key, { data, at: Date.now() });
          if (this.routeCache.size > 30) this.routeCache.delete(this.routeCache.keys().next().value);
        })
        .catch(() => {})
        .finally(() => this.routePrefetches.delete(key));
      this.routePrefetches.set(key, task);
    }

    invalidateRouteCache() {
      // Conserva los datos para que la navegación siga siendo inmediata; marca
      // las vistas como caducadas y las sincroniza de nuevo al abrirlas.
      this.routeCacheVersion++;
      for (const [key, entry] of this.routeCache.entries()) {
        this.routeCache.set(key, { ...entry, at: 0 });
      }
      this.routePrefetches.clear();
    }

    async fetchRouteData(route) {
      if (route === 'home') {
        const [dashboard, notifications] = await Promise.all([
          this.repository.dashboard(),
          this.repository.notifications().catch(() => ({ items: this.state.notifications }))
        ]);
        return { dashboard, notifications };
      }
      if (['inbox','sent','drafts','favorites','archive','trash'].includes(route)) {
        return { letters: await this.repository.list(route, this.state.search, null, 40) };
      }
      if (route === 'notifications') return { notifications: await this.repository.notifications(null, 30) };
      if (route === 'settings') {
        const [settings, sessions, invitation] = await Promise.all([
          this.repository.settings(), this.repository.sessions(), this.session.api.auth('invitation:status')
        ]);
        return { settings, sessions, invitation };
      }
      return {};
    }

    applyRouteData(route, data) {
      if (route === 'home') {
        this.state.dashboard = data.dashboard || this.state.dashboard;
        this.state.notifications = data.notifications?.items || this.state.notifications;
        this.state.notificationPagination = {
          cursor: data.notifications?.nextCursor || null,
          loadedCount: Number(data.notifications?.loaded ?? data.notifications?.items?.length ?? 0),
          limit: data.notifications?.limit || 30,
          hasMore: Boolean(data.notifications?.hasMore), loading: false
        };
      } else if (['inbox','sent','drafts','favorites','archive','trash'].includes(route)) {
        this.state.letters = this.uniqueLetters(data.letters?.items || []);
        this.state.pagination = {
          cursor: data.letters?.nextCursor || null,
          loadedCount: Number(data.letters?.loaded ?? data.letters?.items?.length ?? 0),
          limit: data.letters?.limit || 40,
          hasMore: Boolean(data.letters?.hasMore), loading: false
        };
      } else if (route === 'notifications') {
        this.state.notifications = data.notifications?.items || [];
        this.state.notificationPagination = {
          cursor: data.notifications?.nextCursor || null,
          loadedCount: Number(data.notifications?.loaded ?? data.notifications?.items?.length ?? 0),
          limit: data.notifications?.limit || 30,
          hasMore: Boolean(data.notifications?.hasMore), loading: false
        };
      } else if (route === 'settings') {
        this.state.settings = { ...this.state.settings, ...(data.settings?.settings || {}) };
        this.state.sessions = data.sessions?.sessions || [];
        this.state.invitation = {
          ...(data.invitation || {}),
          // El código recién generado vive solo en memoria; la API de estado nunca lo devuelve.
          revealedCode: this.state.invitation?.revealedCode || ''
        };
        this.cacheTheme(this.state.settings.theme);
        this.applyTheme(this.state.settings.theme);
      }
    }

    async refreshRouteData(route, cacheKey, requestId, background) {
      const cacheVersion = this.routeCacheVersion;
      try {
        const data = await this.fetchRouteData(route);
        if (cacheVersion !== this.routeCacheVersion) return;
        this.routeCache.set(cacheKey, { data, at: Date.now() });
        if (this.routeCache.size > 30) this.routeCache.delete(this.routeCache.keys().next().value);
        if (requestId !== this.routeRequestId || this.state.route !== route) return;
        this.applyRouteData(route, data);
        this.state.routeError = null;
        this.state.routeNotice = null;
        this.state.routeLoading = false;
        this.render();
      } catch (error) {
        if (requestId !== this.routeRequestId || this.state.route !== route) return;
        this.state.routeLoading = false;
        if (error.status === 401) { this.forceLogout(); return; }
        if (background) {
          this.state.routeNotice = 'No pudimos actualizar esta sección. Se conserva la última copia disponible.';
        } else {
          this.state.routeError = error.message || 'No se pudo cargar esta sección.';
        }
        this.render();
      }
    }

    render() {
      this.state.user = this.session.user;
      this.state.pendingLetterActions = this.pendingLetterActions;
      this.view.renderShell(this.state);
      this.syncResponsiveAccessibility?.();
      this.observePaginationSentinel();
    }

    renderCurrentRoute() {
      this.state.user = this.session.user;
      this.state.pendingLetterActions = this.pendingLetterActions;
      if (this.state.route === 'letter' && this.view.renderLetterDetail(this.state)) {
        this.observePaginationSentinel();
        return;
      }
      this.view.renderShell(this.state);
      this.syncResponsiveAccessibility?.();
      this.observePaginationSentinel();
    }

    observePaginationSentinel() {
      this.paginationObserver?.disconnect?.();
      this.paginationObserver = null;
      if (typeof IntersectionObserver !== 'function') return;
      const sentinel = this.root.querySelector('[data-pagination-sentinel]');
      if (!sentinel) return;
      this.paginationObserver = new IntersectionObserver(entries => {
        if (!entries.some(entry => entry.isIntersecting)) return;
        if (this.state.route === 'notifications') this.loadMoreNotifications().catch(() => {});
        else if (['inbox','sent','drafts','favorites','archive','trash'].includes(this.state.route)) this.loadMoreLetters().catch(() => {});
        else if (this.state.route === 'letter') this.loadOlderThread().catch(() => {});
      }, { root: null, rootMargin: '420px 0px' });
      this.paginationObserver.observe(sentinel);
    }

    async loadMoreLetters() {
      const route = this.state.route;
      const pagination = this.state.pagination;
      if (!['inbox','sent','drafts','favorites','archive','trash'].includes(route)
        || !pagination?.hasMore || pagination.loading || !pagination.cursor) return;
      const userId = this.session?.user?.id;
      const search = this.state.search;
      const cursor = pagination.cursor;
      this.state.pagination = { ...pagination, loading: true };
      this.renderCurrentRoute();
      try {
        const page = await this.repository.list(route, search, cursor, pagination.limit || 40);
        if (this.state.route !== route || this.session?.user?.id !== userId || this.state.search !== search) return;
        const priorCount = Number(pagination.loadedCount || this.state.letters.length);
        this.state.letters = this.uniqueLetters([...(this.state.letters || []), ...(page.items || [])]);
        this.state.pagination = {
          cursor: page.nextCursor || null,
          loadedCount: priorCount + (page.items || []).length,
          limit: page.limit || pagination.limit || 40,
          hasMore: Boolean(page.hasMore), loading: false
        };
        const scrollY = window.scrollY;
        this.renderCurrentRoute();
        window.scrollTo(0, scrollY);
      } catch (error) {
        this.state.pagination = { ...pagination, loading: false };
        this.renderCurrentRoute();
        showToast(error.message || 'No se pudieron cargar más cartas.', 'error');
      }
    }

    async loadMoreNotifications() {
      const pagination = this.state.notificationPagination;
      if (this.state.route !== 'notifications' || !pagination?.hasMore || pagination.loading || !pagination.cursor) return;
      const userId = this.session?.user?.id;
      const cursor = pagination.cursor;
      this.state.notificationPagination = { ...pagination, loading: true };
      this.renderCurrentRoute();
      try {
        const page = await this.repository.notifications(cursor, pagination.limit || 30);
        if (this.state.route !== 'notifications' || this.session?.user?.id !== userId) return;
        const merged = [...(this.state.notifications || []), ...(page.items || [])];
        this.state.notifications = [...new Map(merged.filter(item => item?.id).map(item => [String(item.id), item])).values()];
        this.state.notificationPagination = {
          cursor: page.nextCursor || null,
          loadedCount: Number(pagination.loadedCount || 0) + (page.items || []).length,
          limit: page.limit || pagination.limit || 30,
          hasMore: Boolean(page.hasMore), loading: false
        };
        const scrollY = window.scrollY;
        this.renderCurrentRoute();
        window.scrollTo(0, scrollY);
      } catch (error) {
        this.state.notificationPagination = { ...pagination, loading: false };
        this.renderCurrentRoute();
        showToast(error.message || 'No se pudieron cargar más notificaciones.', 'error');
      }
    }

    async loadOlderThread() {
      const bundle = this.state.selectedLetter;
      if (this.state.route !== 'letter' || !bundle?.threadHasMore || bundle.threadLoading) return;
      const userId = this.session?.user?.id;
      const letterId = String(bundle.letter?.id || '');
      const nextCursor = bundle.threadNextCursor || null;
      this.state.selectedLetter = { ...bundle, threadLoading: true };
      this.renderCurrentRoute();
      try {
        const page = await this.repository.get(letterId, nextCursor, 40);
        if (this.state.route !== 'letter' || this.session?.user?.id !== userId
          || String(this.state.selectedLetter?.letter?.id || '') !== letterId) return;
        const previousThread = this.state.selectedLetter.thread || [];
        const previousIds = new Set(previousThread.map(item => String(item.id)));
        const newlyLoadedOlderCount = (page.thread || []).filter(item => item?.id && !previousIds.has(String(item.id))).length;
        const thread = [...new Map([...previousThread, ...(page.thread || [])]
          .filter(item => item?.id).map(item => [String(item.id), item])).values()]
          .sort((a, b) => new Date(String(a.sent_at || a.created_at)).getTime()
            - new Date(String(b.sent_at || b.created_at)).getTime() || String(a.id).localeCompare(String(b.id)));
        this.state.selectedLetter = {
          ...this.state.selectedLetter, thread,
          threadHasMore: Boolean(page.threadHasMore), threadNextCursor: page.threadNextCursor || null,
          threadLoadedOlderCount: Math.min(thread.length, Number(bundle.threadLoadedOlderCount || 0) + newlyLoadedOlderCount),
          threadLoading: false
        };
        this.cacheLetterThread(this.state.selectedLetter);
        this.renderCurrentRoute();
      } catch (error) {
        this.state.selectedLetter = { ...bundle, threadLoading: false };
        this.renderCurrentRoute();
        showToast(error.message || 'No se pudieron cargar cartas anteriores.', 'error');
      }
    }
}
