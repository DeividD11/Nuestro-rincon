import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { AppController } from '../assets/js/controllers/app-controller.js';
import { DraftSyncQueue } from '../assets/js/services/draft-sync-queue.js';
import { AdaptivePoller } from '../assets/js/services/adaptive-poller.js';
import { NotificationController } from '../assets/js/controllers/notification-controller.js';

const read = path => readFile(new URL(path, import.meta.url), 'utf8');

test('AppController compone los métodos reales de los seis controladores especializados', async () => {
  const expectedMethods = [
    'openRoute', 'prefetchRoute', 'loadMoreLetters',
    'getRegistrationRecoveryHandoff', 'continueAfterRecoverySaved', 'forceLogout',
    'openLetter', 'confirmSend', 'downloadHtml',
    'saveDraft', 'discardLetter', 'syncDraftSnapshot',
    'applyTheme', 'refreshSessions', 'checkCurrentSession',
    'refreshNotifications', 'startNotificationPolling'
  ];
  for (const method of expectedMethods) {
    assert.equal(typeof AppController.prototype[method], 'function', `Falta método compuesto: ${method}`);
  }
  const main = await read('../assets/js/controllers/app-controller.js');
  assert.ok(main.split('\n').length < 800, 'el controlador principal debe quedar como orquestador');
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
      total: 3, offset: 0, nextOffset: 1, limit: 30, hasMore: true
    })
  };
  controller.state = {
    route: 'write',
    notifications: [
      { id: 'old-2', read_at: '2026-11-19T10:00:00Z', created_at: '2026-11-19T10:00:00Z' },
      { id: 'old-3', read_at: '2026-11-18T10:00:00Z', created_at: '2026-11-18T10:00:00Z' }
    ],
    notificationPagination: { nextOffset: 60, limit: 30 }
  };
  controller.root = { querySelector: () => button };
  controller.render = () => { throw new Error('NO_FULL_RENDER_DURING_BACKGROUND_POLL'); };
  controller.renderCurrentRoute = () => { throw new Error('NO_ROUTE_RENDER_OUTSIDE_NOTIFICATIONS'); };

  await controller.refreshNotifications();
  assert.deepEqual(controller.state.notifications.map(item => item.id), ['new-1', 'old-2', 'old-3']);
  assert.equal(controller.state.notificationPagination.nextOffset, 3);
  assert.equal(button['aria-label'], 'Notificaciones, 1 sin leer');
  assert.equal(dot.removed, undefined);
});
