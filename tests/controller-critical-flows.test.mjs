import test from 'node:test';
import assert from 'node:assert/strict';
import { NavigationController } from '../assets/js/controllers/navigation-controller.js';
import { LetterController } from '../assets/js/controllers/letter-controller.js';
import { DraftController } from '../assets/js/controllers/draft-controller.js';
import { SettingsController } from '../assets/js/controllers/settings-controller.js';

const previousGlobals = {};
function installGlobal(name, value) {
  if (!(name in previousGlobals)) previousGlobals[name] = Object.getOwnPropertyDescriptor(globalThis, name);
  Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
}
function restoreGlobals() {
  for (const [name, descriptor] of Object.entries(previousGlobals)) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else delete globalThis[name];
  }
  for (const name of Object.keys(previousGlobals)) delete previousGlobals[name];
}

const node = (initial = {}) => ({
  value: '', textContent: '', innerHTML: '', attributes: {}, classes: new Set(),
  classList: { add(name) { this.owner.classes.add(name); }, remove(name) { this.owner.classes.delete(name); } },
  setAttribute(name, value) { this.attributes[name] = value; },
  ...initial
});

test('NavigationController usa una caché aislada por cuenta y deduplica cartas por id', () => {
  const controller = Object.create(NavigationController.prototype);
  controller.session = { user: { id: 'user-a' } };
  assert.equal(controller.routeCacheKey('inbox'), 'inbox:user-a');
  controller.session.user.id = 'user-b';
  assert.equal(controller.routeCacheKey('inbox'), 'inbox:user-b');
  const items = [{ id: 1 }, { id: '1' }, { id: 2 }, { id: null }, {}, { id: 2 }];
  assert.deepEqual(controller.uniqueLetters(items), [{ id: 1 }, { id: 2 }]);
});

test('NavigationController encuentra una carta en listas, dashboard o hilo sin duplicados', () => {
  const controller = Object.create(NavigationController.prototype);
  controller.state = {
    letters: [{ id: 'a', title: 'Lista' }],
    dashboard: { recent: [{ id: 'b', title: 'Reciente' }] },
    selectedLetter: { letter: { id: 'c', title: 'Activa' }, thread: [{ id: 'b' }, { id: 'd' }] }
  };
  assert.equal(controller.letterSummary('a').title, 'Lista');
  assert.equal(controller.letterSummary('b').title, 'Reciente');
  assert.equal(controller.letterSummary('c').title, 'Activa');
  assert.equal(controller.letterSummary('d').id, 'd');
  assert.equal(controller.letterSummary('missing'), null);
});

test('NavigationController obtiene datos para listas, notificaciones y ajustes', async () => {
  const calls = [];
  const controller = Object.create(NavigationController.prototype);
  controller.state = { search: 'prueba', notifications: [{ id: 'cached' }] };
  controller.session = { user: { id: 'u' }, api: { auth: async action => { calls.push(action); return { status: 'active' }; } } };
  controller.repository = {
    list: async (...args) => { calls.push(['list', ...args]); return { items: [] }; },
    notifications: async (...args) => { calls.push(['notifications', ...args]); return { items: [] }; },
    settings: async () => { calls.push('settings'); return { settings: {} }; },
    sessions: async () => { calls.push('sessions'); return { sessions: [] }; },
    dashboard: async () => { calls.push('dashboard'); return { drafts: 1 }; }
  };
  assert.deepEqual(await controller.fetchRouteData('drafts'), { letters: { items: [] } });
  assert.deepEqual(await controller.fetchRouteData('notifications'), { notifications: { items: [] } });
  const settings = await controller.fetchRouteData('settings');
  assert.deepEqual(settings, { settings: { settings: {} }, sessions: { sessions: [] }, invitation: { status: 'active' }, themePreferenceVersion: 0 });
  const home = await controller.fetchRouteData('home');
  assert.equal(home.dashboard.drafts, 1);
  assert.deepEqual(calls.filter(item => item === 'settings' || item === 'sessions' || item === 'invitation:status').sort(), ['invitation:status','sessions','settings']);
});

test('NavigationController invalida marcas de tiempo y descarta prefetches', () => {
  const controller = Object.create(NavigationController.prototype);
  controller.routeCacheVersion = 4;
  controller.routeCache = new Map([['inbox:u', { at: Date.now(), data: { letters: [] } }]]);
  controller.routePrefetches = new Map([['sent:u', Promise.resolve()]]);
  controller.invalidateRouteCache();
  assert.equal(controller.routeCacheVersion, 5);
  assert.equal(controller.routeCache.get('inbox:u').at, 0);
  assert.equal(controller.routePrefetches.size, 0);
});

test('NavigationController aplica páginas y resetea los metadatos de paginación', () => {
  const controller = Object.create(NavigationController.prototype);
  controller.state = { route: 'inbox', letters: [], localDraftPreview: null, pagination: {}, notifications: [], settings: {}, profile: {}, invitation: {} };
  controller.uniqueLetters = NavigationController.prototype.uniqueLetters;
  controller.applyRouteData('inbox', { letters: { items: [{ id: '1' }, { id: '1' }, { id: '2' }], loaded: 2, limit: 40, hasMore: true, nextCursor: { id: '2' } } });
  assert.deepEqual(controller.state.letters.map(item => item.id), ['1','2']);
  assert.equal(controller.state.pagination.loadedCount, 2);
  assert.equal(controller.state.pagination.hasMore, true);
  controller.applyRouteData('notifications', { notifications: { items: [{ id: 'n' }], loaded: 1, hasMore: false } });
  assert.equal(controller.state.notifications[0].id, 'n');
  assert.equal(controller.state.notificationPagination.hasMore, false);
});

test('NavigationController reemplaza solo el contenedor de resultados de búsqueda', () => {
  const results = { innerHTML: '', attributes: {}, classes: new Set(), classList: { remove(name) { this.owner.classes.delete(name); } }, setAttribute(name, value) { this.attributes[name] = value; } };
  results.classList.owner = results;
  const controller = Object.create(NavigationController.prototype);
  controller.state = { route: 'drafts' };
  controller.root = { querySelector: selector => selector === '#letter-list-results' ? results : null };
  controller.view = { renderListResults: () => '<article>solo resultados</article>' };
  controller.observePaginationSentinel = () => { controller.observed = true; };
  controller.hydrateLetterStampPreviews = () => { controller.hydrated = true; };
  assert.equal(controller.renderListResultsOnly(), true);
  assert.equal(results.innerHTML, '<article>solo resultados</article>');
  assert.equal(results.attributes['aria-busy'], 'false');
  assert.equal(controller.observed, true);
  assert.equal(controller.hydrated, true);
});

test('LetterController conserva el hilo por cuenta y mantiene un límite de caché', () => {
  const controller = Object.create(LetterController.prototype);
  controller.session = { user: { id: 'u1' } };
  controller.letterThreadCache = new Map();
  controller.cacheLetterThread({ letter: { thread_id: 't1' }, thread: [{ id: 'l1' }] });
  assert.deepEqual(controller.letterThreadCache.get('u1:t1'), [{ id: 'l1' }]);
  controller.cacheLetterThread({ letter: { thread_id: 't2' }, thread: [{ id: 'l2' }] });
  assert.equal(controller.letterThreadCache.size, 2);
  controller.letterThreadCache = new Map(Array.from({ length: 20 }, (_, index) => [`old:${index}`, []]));
  controller.cacheLetterThread({ letter: { thread_id: 'latest' }, thread: [{ id: 'last' }] });
  assert.equal(controller.letterThreadCache.size, 20);
  assert.equal(controller.letterThreadCache.has('old:0'), false);
});

test('LetterController aplica cambios optimistas de carta y puede retirarla de la lista', () => {
  const controller = Object.create(LetterController.prototype);
  controller.state = {
    letters: [{ id: 'l1', favorite: false }, { id: 'l2' }],
    selectedLetter: { letter: { id: 'l1', favorite: false }, thread: [{ id: 'l1' }, { id: 'l2' }] }
  };
  controller.patchLetterState('l1', { favorite: true });
  assert.equal(controller.state.letters[0].favorite, true);
  assert.equal(controller.state.selectedLetter.letter.favorite, true);
  assert.equal(controller.state.selectedLetter.thread[0].favorite, true);
  controller.patchLetterState('l2', { archived: true }, { removeFromList: true });
  assert.deepEqual(controller.state.letters.map(item => item.id), ['l1']);
  assert.equal(controller.state.selectedLetter.thread.find(item => item.id === 'l2').archived, true);
});

test('LetterController guarda y restaura una instantánea de estado sin compartir referencias', () => {
  const calls = [];
  const controller = Object.create(LetterController.prototype);
  controller.state = {
    route: 'inbox', letters: [{ id: 'l1' }],
    selectedLetter: { letter: { id: 'l1' }, thread: [{ id: 'l1' }] },
    dashboard: { recent: [{ id: 'l1' }] }
  };
  const snapshot = controller.snapshotLetterState();
  controller.state.letters[0].changed = true;
  assert.equal(snapshot.letters[0].changed, undefined);
  installGlobal('history', { replaceState: (...args) => calls.push(args) });
  controller.renderCurrentRoute = () => calls.push('render');
  controller.restoreLetterState(snapshot);
  assert.equal(controller.state.route, 'inbox');
  assert.deepEqual(calls[0], [null, '', '#/inbox']);
  assert.equal(calls[1], 'render');
  restoreGlobals();
});

test('LetterController normaliza nombres de archivo de carta sin acentos ni caracteres inseguros', () => {
  const controller = Object.create(LetterController.prototype);
  assert.equal(controller.fileName('Mi carta: Acción / verano'), 'mi-carta-accion-verano');
  assert.equal(controller.fileName('   '), 'carta');
});

test('LetterController cambia de carta dentro de un hilo ya cargado sin petición de red', () => {
  const controller = Object.create(LetterController.prototype);
  const letterA = { id: 'a', thread_id: 'thread' };
  const letterB = { id: 'b', thread_id: 'thread' };
  controller.state = { route: 'letter', selectedLetter: { letter: letterA, thread: [letterA, letterB] }, mobileNavOpen: false };
  controller.routeRequestId = 1;
  controller.session = { user: { id: 'u' } };
  controller.view = { renderLetterDetail: state => { controller.rendered = state.selectedLetter.letter.id; return true; } };
  controller.markThreadReadInBackground = () => { controller.marked = true; };
  controller.focusPageHeading = () => { controller.focused = true; };
  installGlobal('location', { hash: '#/letter' });
  installGlobal('history', { replaceState() {} });
  return controller.openLetter('b').then(() => {
    assert.equal(controller.state.selectedLetter.letter.id, 'b');
    assert.equal(controller.rendered, 'b');
    assert.equal(controller.marked, true);
    assert.equal(controller.focused, true);
    restoreGlobals();
  });
});

test('DraftController descarta búsquedas obsoletas y actualiza solo una página vigente', async () => {
  const results = { innerHTML: '', attributes: {}, classList: { remove() {} }, setAttribute(name, value) { this.attributes[name] = value; } };
  const status = { textContent: '' };
  const controller = Object.create(DraftController.prototype);
  controller.state = { route: 'drafts', search: 'carta', letters: [] };
  controller.searchRequestId = 8;
  controller.uniqueLetters = NavigationController.prototype.uniqueLetters;
  controller.root = { querySelector: selector => selector === '#letter-list-results' ? results : status };
  controller.repository = { list: async () => ({ items: [{ id: '1' }, { id: '1' }], loaded: 1, limit: 40 }) };
  controller.renderListResultsOnly = () => { controller.rendered = true; };
  await controller.runLetterSearch('drafts', 'anterior', 7);
  assert.equal(controller.rendered, undefined);
  await controller.runLetterSearch('drafts', 'carta', 8);
  assert.deepEqual(controller.state.letters.map(item => item.id), ['1']);
  assert.equal(controller.rendered, true);
  assert.equal(status.textContent, 'Resultados actualizados');
});

test('DraftController usa una cola por usuario y permite marcar sincronización de un borrador', async () => {
  const controller = Object.create(DraftController.prototype);
  controller.session = { user: { id: 'user-1' } };
  controller.localDraftKeyFor = value => `${controller.session.user.id}:${value}`;
  controller.state = {};
  controller.discardedDraftIds = new Set();
  controller.draftSyncQueue = { enqueue: async (key, task) => { controller.queueKey = key; return task(); } };
  controller.syncDraftSnapshot = async (snapshot, storageKey, options) => ({ snapshot, storageKey, options });
  const result = await controller.enqueueDraftSync({ letterId: 'l1' }, 'user-1:letter:l1', { immediate: true });
  assert.equal(controller.queueKey, 'user-1:__draft-sync__');
  assert.equal(result.storageKey, 'user-1:letter:l1');
  controller.discardedDraftIds.add('l1');
  controller.clearLocalDraftForLetter = async (id, key) => ({ id, key, status: 'discarded' });
  const discarded = await controller.enqueueDraftSync({ letterId: 'l1' }, 'key');
  assert.equal(discarded.status, 'discarded');
});

test('DraftController actualiza el estado de guardado sin reconstruir el editor', () => {
  const status = { textContent: '' };
  const controller = Object.create(DraftController.prototype);
  controller.state = {};
  controller.root = { querySelector: selector => selector === '#save-status' ? status : null };
  controller.updateSaveStatus('Guardado localmente');
  assert.equal(status.textContent, 'Guardado localmente');
});

test('SettingsController separa preferencias de tema por usuario y valida valores', () => {
  const memory = new Map();
  installGlobal('localStorage', {
    getItem: key => memory.get(key) ?? null,
    setItem: (key, value) => memory.set(key, String(value))
  });
  const controller = Object.create(SettingsController.prototype);
  controller.session = { user: { id: 'u1' } };
  assert.equal(controller.themeStorageKey(), 'nuestro-rincon:theme:u1');
  controller.cacheTheme('dark');
  assert.equal(controller.readCachedTheme(), 'dark');
  assert.equal(controller.readLastTheme(), 'dark');
  controller.cacheTheme('invalid');
  assert.equal(controller.readCachedTheme(), 'dark');
  controller.session.user.id = 'u2';
  assert.equal(controller.readCachedTheme(), null);
  restoreGlobals();
});

test('SettingsController aplica tema y prefiere el sistema solo cuando corresponde', () => {
  const dataset = {};
  const root = { dataset, style: {} };
  installGlobal('document', { documentElement: root });
  const controller = Object.create(SettingsController.prototype);
  controller.state = { settings: {} };
  controller.session = { user: { id: 'u' } };
  controller.systemThemeMedia = { matches: true };
  controller.cacheTheme = theme => { controller.cached = theme; };
  controller.applyTheme('system');
  assert.equal(dataset.theme, 'dark');
  assert.equal(dataset.themePreference, 'system');
  assert.equal(root.style.colorScheme, 'dark');
  assert.equal(controller.cached, 'system');
  controller.applyTheme('invalid');
  assert.equal(dataset.themePreference, 'system');
  restoreGlobals();
});

test('SettingsController renueva el avatar cuando falta el nodo y adopta el mismo avatar sano', () => {
  let adopted = null;
  let updates = 0;
  const avatar = { querySelector: () => null };
  const controller = Object.create(SettingsController.prototype);
  controller.session = { user: { displayName: 'Deivid Aldemar' } };
  controller.root = { querySelector: selector => selector === '.user-mini .avatar' ? avatar : null };
  controller.view = { avatarNodeCache: {
    avatarIdentity: profile => profile.avatarPath || '',
    hasSidebarImage: () => false,
    adopt: profile => { adopted = profile; }
  } };
  controller.updateAvatarPreview = () => { updates++; };
  controller.syncAvatarFromProfile({ avatarPath: 'u/a.webp', avatarUrl: 'old' }, { avatarPath: 'u/a.webp', avatarUrl: 'new' });
  assert.equal(updates, 1, 'renueva si la imagen del nodo falta aunque la ruta sea la misma');
  controller.root.querySelector = () => ({ querySelector: () => ({ complete: false, naturalWidth: 0 }) });
  controller.syncAvatarFromProfile({ avatarPath: 'u/a.webp', avatarUrl: 'same' }, { avatarPath: 'u/a.webp', avatarUrl: 'same' });
  assert.equal(adopted.avatarUrl, 'same');
  assert.equal(updates, 1);
});

test('SettingsController detiene el poller al abandonar la sesión', () => {
  let stopped = 0;
  const controller = Object.create(SettingsController.prototype);
  controller.sessionPoller = { stop: () => { stopped++; } };
  controller.stopSessionRefreshPolling();
  assert.equal(stopped, 1);
  assert.equal(controller.sessionPoller, null);
});

test('NavigationController gestiona foco ausente, foco preventScroll y fallback si el navegador no lo admite', () => {
  const controller = Object.create(NavigationController.prototype);
  controller.root = { querySelector: () => null };
  assert.equal(controller.focusPageHeading(), false);

  const calls = [];
  controller.root = { querySelector: () => ({ focus: options => calls.push(options) }) };
  assert.equal(controller.focusPageHeading(), true);
  assert.deepEqual(calls, [{ preventScroll: true }]);

  calls.length = 0;
  controller.root = { querySelector: () => ({ focus: options => {
    calls.push(options);
    if (options) throw new TypeError('preventScroll unsupported');
  } }) };
  assert.equal(controller.focusPageHeading(), true);
  assert.deepEqual(calls, [{ preventScroll: true }, undefined]);
});
