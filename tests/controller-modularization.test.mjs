import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { AppController } from '../assets/js/controllers/app-controller.js';
import { DraftSyncQueue } from '../assets/js/services/draft-sync-queue.js';
import { AdaptivePoller } from '../assets/js/services/adaptive-poller.js';
import { NotificationController } from '../assets/js/controllers/notification-controller.js';

const read = path => readFile(new URL(path, import.meta.url), 'utf8');

test('AppController compone módulos de dominio, inicialización, eventos y ciclo de sesión', async () => {
  const expectedMethods = [
    'openRoute', 'prefetchRoute', 'loadMoreLetters',
    'getRegistrationRecoveryHandoff', 'continueAfterRecoverySaved', 'forceLogout',
    'openLetter', 'confirmSend', 'downloadHtml',
    'saveDraft', 'discardLetter', 'syncDraftSnapshot',
    'applyTheme', 'refreshSessions', 'checkCurrentSession',
    'refreshNotifications', 'startNotificationPolling', 'init', 'bindEvents',
    'restoreInitialSession', 'resetPrivateSessionState', 'localDraftKeyFor', 'syncResponsiveAccessibility'
  ];
  for (const method of expectedMethods) {
    assert.equal(typeof AppController.prototype[method], 'function', `Falta método compuesto: ${method}`);
  }
  const main = await read('../assets/js/controllers/app-controller.js');
  assert.ok(main.split('\n').length < 120, 'el controlador principal debe limitarse a construir el contexto y componer módulos');
  const initialization = await read('../assets/js/controllers/app-initialization-controller.js');
  const events = await read('../assets/js/controllers/app-event-coordinator-controller.js');
  const lifecycle = await read('../assets/js/controllers/session-lifecycle-controller.js');
  assert.match(initialization, /async init\(\)[\s\S]*await this\.restoreInitialSession\(\)/);
  assert.doesNotMatch(initialization, /addEventListener/);
  assert.match(events, /root\.addEventListener\('click'/);
  assert.match(events, /root\.addEventListener\('submit'/);
  assert.match(lifecycle, /async restoreInitialSession\(\)/);
  assert.match(events, /handleSubmit\.call\(this, event\)/);
  assert.match(events, /handleClick\.call\(this, event\)/);
  assert.match(lifecycle, /setupSessionLifecycle\(\)/);
  assert.match(lifecycle, /restoreInitialSession\(\)/);
  assert.match(lifecycle, /resetPrivateSessionState\(user = null\)/);
  const submit = await read('../assets/js/controllers/app-submit-handler.js');
  const click = await read('../assets/js/controllers/app-click-handler.js');
  assert.ok(submit.split('\n').length > 200);
  assert.ok(click.split('\n').length > 200);
  assert.match(submit, /export async function handleSubmit/);
  assert.match(click, /export async function handleClick/);
  const view = await read('../assets/js/views/app-view.js');
  assert.ok(view.split('\n').length < 150, 'AppView debe conservar solo el contrato de renderizado y composición');
  assert.match(main, /Object\.getOwnPropertyDescriptors\(modulePrototype\)/);
});

test('la cola de sincronización serializa tareas y permite continuar después de un fallo', async () => {
  const queue = new DraftSyncQueue();
  const order = [];
  const first = queue.enqueue('account-1', async () => {
    order.push('first:start');
    await new Promise(resolve => setTimeout(resolve, 5));
    order.push('first:end');
    return 'done';
  });
  const failed = queue.enqueue('account-1', async () => {
    order.push('second');
    throw new Error('expected');
  });
  const third = queue.enqueue('account-1', async () => {
    order.push('third');
    return 'recovered';
  });
  await assert.rejects(failed, /expected/);
  assert.equal(await first, 'done');
  assert.equal(await third, 'recovered');
  assert.deepEqual(order, ['first:start', 'first:end', 'second', 'third']);
  assert.equal(queue.isPending('account-1'), false);
});

function installFakeBrowser() {
  const windowListeners = new Map();
  const documentListeners = new Map();
  const timers = new Map();
  let nextId = 0;
  const previous = {
    window: globalThis.window,
    document: globalThis.document,
    navigator: Object.getOwnPropertyDescriptor(globalThis, 'navigator')
  };
  const add = (map, type, callback) => {
    if (!map.has(type)) map.set(type, new Set());
    map.get(type).add(callback);
  };
  const remove = (map, type, callback) => map.get(type)?.delete(callback);
  globalThis.window = {
    addEventListener: (type, callback) => add(windowListeners, type, callback),
    removeEventListener: (type, callback) => remove(windowListeners, type, callback),
    setTimeout: (callback, delay) => {
      const id = ++nextId;
      timers.set(id, { callback, delay });
      return id;
    },
    clearTimeout: id => timers.delete(id)
  };
  globalThis.document = {
    hidden: false,
    addEventListener: (type, callback) => add(documentListeners, type, callback),
    removeEventListener: (type, callback) => remove(documentListeners, type, callback)
  };
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: { onLine: true }
  });
  return {
    timers,
    dispatchWindow(type) { for (const callback of windowListeners.get(type) || []) callback(); },
    dispatchDocument(type) { for (const callback of documentListeners.get(type) || []) callback(); },
    restore() {
      if (previous.window === undefined) delete globalThis.window;
      else globalThis.window = previous.window;
      if (previous.document === undefined) delete globalThis.document;
      else globalThis.document = previous.document;
      if (previous.navigator) Object.defineProperty(globalThis, 'navigator', previous.navigator);
      else delete globalThis.navigator;
    }
  };
}

test('AdaptivePoller aplica backoff, intervalos por inactividad y suspensión por pestaña oculta', async () => {
  const browser = installFakeBrowser();
  let calls = 0;
  const poller = new AdaptivePoller({
    enabled: () => true,
    task: async () => { calls++; if (calls === 1) throw new Error('network'); return true; },
    activeIntervalMs: 2_000,
    idleIntervalMs: 6_000,
    idleAfterMs: 1_000,
    minRefreshGapMs: 0,
    maxBackoffMs: 20_000
  });
  try {
    poller.lastActivityAt = Date.now() - 5_000;
    poller.start();
    let [firstId, firstTimer] = [...browser.timers.entries()][0];
    assert.equal(firstTimer.delay, 0);
    browser.timers.delete(firstId);
    await firstTimer.callback();
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(calls, 1);
    assert.equal(poller.failures, 1);
    let scheduled = [...browser.timers.values()][0];
    assert.equal(scheduled.delay, 12_000, 'backoff duplica el intervalo inactivo');

    browser.dispatchWindow('pointerdown');
    scheduled = [...browser.timers.values()][0];
    assert.equal(scheduled.delay, 4_000, 'la actividad vuelve al intervalo activo sin borrar el backoff');

    globalThis.document.hidden = true;
    browser.dispatchDocument('visibilitychange');
    assert.equal(browser.timers.size, 0, 'una pestaña oculta no mantiene un temporizador activo');

    globalThis.document.hidden = false;
    browser.dispatchDocument('visibilitychange');
    scheduled = [...browser.timers.values()][0];
    assert.equal(scheduled.delay, 0, 'al volver a la pestaña se programa una comprobación inmediata');
  } finally {
    poller.stop();
    browser.restore();
  }
});

test('el cambio de perfil se ejecuta mediante un único RPC transaccional protegido', async () => {
  const letters = await read('../supabase/functions/letters-api/index.ts');
  const migration = await read('../supabase/migrations/20261120235900_transactional_profile_rename.sql');
  const start = letters.indexOf("case 'profile:rename':");
  const end = letters.indexOf("case 'sessions':", start);
  const handler = letters.slice(start, end);
  assert.match(handler, /rpc<unknown>\('rename_app_profile'/);
  assert.match(handler, /p_user_id: userId/);
  assert.doesNotMatch(handler, /Promise\.all|patchRows/);
  assert.match(migration, /for update/);
  assert.match(migration, /update public\.app_users[\s\S]*insert into public\.user_profiles[\s\S]*on conflict \(user_id\) do update/);
  assert.match(migration, /revoke execute[\s\S]*from public, anon, authenticated/i);
  assert.match(migration, /grant execute[\s\S]*to service_role/i);
});


test('el sondeo de notificaciones no reconstruye otras vistas ni descarta páginas ya cargadas', async () => {
  const dot = { remove() { this.removed = true; } };
  const button = {
    querySelector: selector => selector === '.notification-dot' ? dot : null,
    setAttribute(name, value) { this[name] = value; }
  };
  const controller = Object.create(NotificationController.prototype);
  controller.session = { user: { id: 'account-a' } };
  controller.repository = {
    notifications: async () => ({
      items: [{ id: 'new-1', read_at: null, created_at: '2026-11-20T10:00:00Z' }],
      nextCursor: { sortAt: '2026-11-20T10:00:00Z', id: '11111111-1111-4111-8111-111111111111' },
      loaded: 1, limit: 30, hasMore: true
    })
  };
  controller.state = {
    route: 'write',
    notifications: [
      { id: 'old-2', read_at: '2026-11-19T10:00:00Z', created_at: '2026-11-19T10:00:00Z' },
      { id: 'old-3', read_at: '2026-11-18T10:00:00Z', created_at: '2026-11-18T10:00:00Z' }
    ],
    notificationPagination: { cursor: { sortAt: '2026-11-18T10:00:00Z', id: '22222222-2222-4222-8222-222222222222' }, loadedCount: 60, limit: 30 }
  };
  controller.root = { querySelector: () => button };
  controller.render = () => { throw new Error('NO_FULL_RENDER_DURING_BACKGROUND_POLL'); };
  controller.renderCurrentRoute = () => { throw new Error('NO_ROUTE_RENDER_OUTSIDE_NOTIFICATIONS'); };

  await controller.refreshNotifications();
  assert.deepEqual(controller.state.notifications.map(item => item.id), ['new-1', 'old-2', 'old-3']);
  assert.equal(controller.state.notificationPagination.loadedCount, 3);
  assert.deepEqual(controller.state.notificationPagination.cursor, { sortAt: '2026-11-20T10:00:00Z', id: '11111111-1111-4111-8111-111111111111' });
  assert.equal(button['aria-label'], 'Notificaciones, 1 sin leer');
  assert.equal(dot.removed, undefined);
});


test('la sincronización remota de borradores vive en un servicio independiente', async () => {
  const draft = await read('../assets/js/controllers/draft-controller.js');
  const service = await read('../assets/js/services/draft-sync-service.js');
  assert.match(draft, /syncDraftSnapshot\(this, initialSnapshot, initialStorageKey, options\)/);
  assert.doesNotMatch(draft, /async syncDraftSnapshot\([\s\S]{1000,}/);
  assert.match(service, /export async function syncDraftSnapshot\(controller/);
  assert.match(service, /controller\.repository\.createDraft/);
  assert.match(service, /controller\.draftIdentity/);
  assert.match(service, /controller\.invalidateRouteCache/);
});


test('la persistencia local de borradores también está aislada del controlador', async () => {
  const draft = await read('../assets/js/controllers/draft-controller.js');
  const service = await read('../assets/js/services/draft-persistence-service.js');
  assert.match(draft, /persistLocalDraft\(this\)/);
  assert.match(draft, /persistEmergencyDraft\(this, snapshot\)/);
  assert.match(draft, /async hydrateEditorFromLocal\(storageKey, identity\) \{ return hydrateEditorFromLocal\(this, storageKey, identity\); \}/);
  assert.match(service, /export async function persistLocalDraft\(controller\)/);
  assert.match(service, /export function persistEmergencyDraft\(controller/);
  assert.match(service, /export async function hydrateEditorFromLocal\(controller/);
});
