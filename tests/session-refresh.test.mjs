import test from 'node:test';
import assert from 'node:assert/strict';
import { SessionService } from '../assets/js/services/session-service.js';
import { ApiClient } from '../assets/js/services/api-client.js';
import { APP_CONFIG } from '../assets/js/config/app-config.js';

function createStorage() {
  const values = new Map();
  return {
    getItem: key => values.has(key) ? values.get(key) : null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: key => values.delete(key)
  };
}

test('las renovaciones simultáneas comparten una sola rotación del refresh token', async t => {
  const previousStorage = globalThis.sessionStorage;
  globalThis.sessionStorage = createStorage();
  t.after(() => { globalThis.sessionStorage = previousStorage; });

  let refreshCalls = 0;
  let releaseRefresh;
  const api = {
    auth: async (action, payload) => {
      assert.equal(action, 'refresh');
      assert.equal(payload.refreshToken, 'refresh-old');
      refreshCalls++;
      await new Promise(resolve => { releaseRefresh = resolve; });
      return {
        accessToken: 'access-new', refreshToken: 'refresh-new', sessionId: 'session-1',
        user: { id: 'user-1', username: 'persona', displayName: 'Persona' }
      };
    }
  };
  const session = new SessionService(api);
  session.refreshToken = 'refresh-old';

  const first = session.refreshSession();
  const concurrent = Array.from({ length: 7 }, () => session.refreshSession());
  assert.equal(refreshCalls, 1);
  releaseRefresh();
  await Promise.all([first, ...concurrent]);

  assert.equal(refreshCalls, 1);
  assert.equal(session.accessToken, 'access-new');
  assert.equal(session.refreshToken, 'refresh-new');
  assert.equal(session.sessionId, 'session-1');
});

test('una respuesta 401 de una petición antigua reutiliza el token nuevo sin rotar otra vez', async t => {
  const previousWindow = globalThis.window;
  const previousFetch = globalThis.fetch;
  globalThis.window = { setTimeout, clearTimeout };
  let requests = 0;
  let refreshCalls = 0;
  const session = {
    accessToken: 'access-old',
    refreshToken: 'refresh-current',
    refreshSession: async () => { refreshCalls++; }
  };
  globalThis.fetch = async (_url, options) => {
    requests++;
    if (requests === 1) {
      assert.equal(options.headers.Authorization, 'Bearer access-old');
      session.accessToken = 'access-new';
      return new Response(JSON.stringify({ ok: false, code: 'SESSION_EXPIRED' }), { status: 401 });
    }
    assert.equal(options.headers.Authorization, 'Bearer access-new');
    return new Response(JSON.stringify({ ok: true, result: 'ok' }), { status: 200 });
  };
  t.after(() => {
    globalThis.window = previousWindow;
    globalThis.fetch = previousFetch;
  });

  const client = new ApiClient(session);
  const result = await client.call(APP_CONFIG.lettersFunction, { action: 'list' });
  assert.equal(result.result, 'ok');
  assert.equal(requests, 2);
  assert.equal(refreshCalls, 0);
});

test('una renovación pendiente no puede resucitar una sesión cerrada', async t => {
  const previousStorage = globalThis.sessionStorage;
  globalThis.sessionStorage = createStorage();
  t.after(() => { globalThis.sessionStorage = previousStorage; });

  let releaseRefresh;
  const session = new SessionService({
    auth: async () => new Promise(resolve => {
      releaseRefresh = () => resolve({
        accessToken: 'late-access', refreshToken: 'late-refresh', sessionId: 'late-session',
        user: { id: 'user-1', username: 'persona', displayName: 'Persona' }
      });
    })
  });
  session.refreshToken = 'refresh-old';
  const refreshing = session.refreshSession();
  session.clearSession();
  releaseRefresh();
  await refreshing;

  assert.equal(session.accessToken, null);
  assert.equal(session.refreshToken, null);
  assert.equal(session.user, null);
});
