import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  createPendingRegistration,
  createPendingRotation,
  readPendingRecovery,
  savePendingRecovery,
  markPendingRecoveryConfirmed,
  clearPendingRecovery,
  isUncertainRequestError,
  PENDING_RECOVERY_STORAGE_KEY
} from '../assets/js/services/recovery-handoff.js';

const read = path => readFile(new URL(path, import.meta.url), 'utf8');
import { readControllerSource } from './helpers/controller-source.mjs';

function withLocalRecoveryStorage(run) {
  const values = new Map();
  const previous = globalThis.localStorage;
  globalThis.localStorage = {
    getItem: key => values.has(key) ? values.get(key) : null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: key => values.delete(key)
  };
  try { return run(values); }
  finally {
    if (previous === undefined) delete globalThis.localStorage;
    else globalThis.localStorage = previous;
  }
}

test('el traspaso del código de registro se persiste de forma duradera antes de la petición y nunca guarda la contraseña', () => withLocalRecoveryStorage(values => {
  const pending = createPendingRegistration({
    invitationCode: 'NR1-PRIVATE-CODE', displayName: 'Persona', username: 'persona', password: 'NO-GUARDAR-ESTA-CONTRASEÑA'
  });
  assert.match(pending.requestId, /^[0-9a-f-]{36}$/i);
  assert.match(pending.recoveryCode, /^(?:[A-F0-9]{6}-){7}[A-F0-9]{6}$/);
  const stored = JSON.parse(values.get(PENDING_RECOVERY_STORAGE_KEY));
  assert.equal(stored.requestId, pending.requestId);
  assert.equal(stored.recoveryCode, pending.recoveryCode);
  assert.equal(stored.password, undefined);
  assert.equal(globalThis.localStorage.getItem(PENDING_RECOVERY_STORAGE_KEY) !== null, true);
  assert.equal(stored.purpose, 'registration');
}));

test('el código y la clave de idempotencia se recuperan después de cerrar y reabrir el navegador', () => withLocalRecoveryStorage(() => {
  const first = createPendingRegistration({ invitationCode: 'NR1-CODE', displayName: 'Persona', username: 'persona' });
  const afterReload = readPendingRecovery();
  assert.equal(afterReload.requestId, first.requestId);
  assert.equal(afterReload.recoveryCode, first.recoveryCode);
  assert.equal(afterReload.invitationCode, first.invitationCode);
}));


test('la confirmación del backend sobrevive a una recarga sin confundirse con un resultado incierto', () => withLocalRecoveryStorage(() => {
  const pending = createPendingRegistration({ invitationCode: 'NR1-CODE', displayName: 'Persona', username: 'persona' });
  assert.equal(readPendingRecovery().serverConfirmed, false);
  markPendingRecoveryConfirmed();
  const afterReload = readPendingRecovery();
  assert.equal(afterReload.requestId, pending.requestId);
  assert.equal(afterReload.recoveryCode, pending.recoveryCode);
  assert.equal(afterReload.serverConfirmed, true);
}));

test('una rotación nueva tiene su propio identificador idempotente y se puede limpiar al confirmar que fue guardada', () => withLocalRecoveryStorage(() => {
  const pending = createPendingRotation();
  assert.equal(pending.purpose, 'rotation');
  assert.ok(pending.requestId);
  assert.ok(pending.recoveryCode);
  savePendingRecovery(pending);
  clearPendingRecovery();
  assert.equal(readPendingRecovery(), null);
}));

test('un error de red o 5xx se trata como resultado incierto que exige conservar el código', () => {
  assert.equal(isUncertainRequestError({ status: 0, code: 'NETWORK_ERROR' }), true);
  assert.equal(isUncertainRequestError({ status: 503, code: 'SERVICE_UNAVAILABLE' }), true);
  assert.equal(isUncertainRequestError({ status: 400, code: 'INVITATION_INVALID' }), false);
});

test('registro reintentable, entrega separada de sesión y rotación autenticada están protegidos en backend y frontend', async () => {
  const auth = await read('../supabase/functions/auth-api/index.ts');
  const sql = await read('../supabase/migrations/20261119050910_idempotent_registration_recovery_handoff.sql');
  const controller = await readControllerSource();
  const session = await read('../assets/js/services/session-service.js');
  const view = await read('../assets/js/views/app-view.js');
  assert.match(auth, /registration_request_receipts/);
  assert.match(auth, /register_app_user_with_invite_idempotent/);
  assert.match(auth, /resumeRegistrationFromReceipt/);
  const registerStart = auth.indexOf("if (action === 'register')");
  const invitationRateLimit = auth.indexOf('start_app_registration_invite_attempt', registerStart);
  const receiptResume = auth.indexOf('resumeRegistrationFromReceipt(req, headers, {', registerStart);
  assert.ok(invitationRateLimit > registerStart && receiptResume > invitationRateLimit,
    'la reanudación idempotente debe estar detrás del limitador de intentos');
  assert.match(auth, /verifyPassword\(password/);
  assert.match(auth, /authenticated: false/);
  assert.match(auth, /action === 'recovery-code:rotate'/);
  assert.match(auth, /verifyPassword\(currentPassword/);
  assert.match(sql, /request_hash text primary key/);
  assert.match(sql, /recovery_code_hash text not null/);
  assert.match(sql, /pg_advisory_xact_lock\(hashtextextended\('registration-request:'/);
  assert.match(sql, /status', 'already_created'/);
  assert.match(sql, /delete from public\.user_recovery_codes where user_id = p_user_id/);
  assert.match(sql, /previous_codes_invalidated/);
  assert.match(sql, /revoke all on function public\.register_app_user_with_invite[\s\S]*service_role/i);
  assert.match(controller, /createPendingRegistration/);
  assert.match(controller, /requestId: pending\.requestId/);
  assert.match(controller, /isUncertainRequestError/);
  assert.match(controller, /createPendingRotation/);
  assert.match(view, /id="recovery-code-form"/);
  assert.match(view, /data-action="retry-recovery-operation"/);
  assert.match(view, /Código pendiente de confirmación/);
  assert.match(view, /codePending/);
  assert.match(session, /payload\.authenticated === true && payload\.accessToken && payload\.refreshToken/);
});

test('un 503 después del alta reintenta exactamente la misma petición idempotente', async () => {
  const { ApiClient } = await import('../assets/js/services/api-client.js');
  const originalWindow = globalThis.window;
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.window = { setTimeout, clearTimeout };
  globalThis.fetch = async (_url, options) => {
    calls.push(JSON.parse(options.body));
    if (calls.length === 1) return new Response(JSON.stringify({ ok: false }), { status: 503 });
    return new Response(JSON.stringify({
      ok: true, accountCreated: true, authenticated: false, recoveryCodeCurrent: true
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  try {
    const client = new ApiClient({ accessToken: null });
    const payload = {
      requestId: '4c36e77f-93ad-4cd8-945e-74bcf83f4a8c',
      recoveryCode: 'ABCDEF-123456-ABCDEF-123456-ABCDEF-123456-ABCDEF-123456',
      invitationCode: 'NR1-PRIVATE', username: 'persona', password: 'una contraseña muy segura'
    };
    const result = await client.auth('register', payload);
    assert.equal(result.accountCreated, true);
    assert.equal(result.authenticated, false);
    assert.equal(calls.length, 2);
    assert.deepEqual(calls[0], calls[1]);
    assert.equal(calls[1].requestId, payload.requestId);
    assert.equal(calls[1].recoveryCode, payload.recoveryCode);
  } finally {
    if (originalWindow === undefined) delete globalThis.window;
    else globalThis.window = originalWindow;
    globalThis.fetch = originalFetch;
  }
});

test('una cuenta creada sin sesión no se presenta al navegador como sesión autenticada', async () => {
  const { SessionService } = await import('../assets/js/services/session-service.js');
  const previous = globalThis.sessionStorage;
  const stored = new Map();
  globalThis.sessionStorage = {
    getItem: key => stored.get(key) ?? null,
    setItem: (key, value) => stored.set(key, String(value)),
    removeItem: key => stored.delete(key)
  };
  try {
    const service = new SessionService({ auth: async () => ({
      ok: true, accountCreated: true, authenticated: false,
      recoveryCodeCurrent: true, user: { id: 'created-user' }
    }) });
    const result = await service.register({ requestId: 'idempotent-request' });
    assert.equal(result.accountCreated, true);
    assert.equal(result.authenticated, false);
    assert.equal(service.user, null);
    assert.equal(service.accessToken, null);
    assert.equal(service.refreshToken, null);
    assert.equal(stored.size, 0);
  } finally {
    if (previous === undefined) delete globalThis.sessionStorage;
    else globalThis.sessionStorage = previous;
  }
});

test('un fallo al leer usuario o crear sesión después del COMMIT devuelve alta confirmada sin convertirla en error', async () => {
  const auth = await read('../supabase/functions/auth-api/index.ts');
  const start = auth.indexOf('async function registrationSessionResponse(');
  const end = auth.indexOf('\nasync function resumeRegistrationFromReceipt', start);
  const response = auth.slice(start, end);
  assert.ok(start >= 0 && end > start);
  assert.match(response, /catch \(error\)[\s\S]*accountCreated: true[\s\S]*authenticated: false/);
  assert.match(response, /registration user lookup deferred/);
  assert.match(response, /registration session deferred/);
  assert.match(response, /recoveryCodeCurrent/);
});


test('los errores definitivos del registro no se confunden con fallos de red y se pueden explicar al usuario', async () => {
  const core = await read('../supabase/functions/_shared/core.ts');
  assert.match(core, /REGISTRATION_RETRY_CREDENTIALS_INVALID[\s\S]*status: 401/);
  assert.match(core, /INVITATION_INVALID[\s\S]*status: 409/);
  assert.match(core, /CURRENT_PASSWORD_INVALID[\s\S]*status: 400/);
});


test('los códigos de resultado incierto se presentan como pendientes y no como activos', async () => {
  const view = await read('../assets/js/views/app-view.js');
  const controller = await readControllerSource();
  assert.match(view, /const codePending = options\.codePending === true/);
  assert.match(view, /Este código se generó y se conserva en este navegador, pero el servidor todavía no ha confirmado si quedó activo/);
  assert.match(controller, /codePending: true/);
  assert.doesNotMatch(controller, /este código sigue siendo el código de recuperación activo/);
});


test('la pantalla del código permanece estable hasta la confirmación manual de guardado', async () => {
  const controller = await readControllerSource();
  const view = await read('../assets/js/views/app-view.js');
  const registerStart = controller.indexOf("} else if (form.id === 'register-form') {");
  const sessionReady = controller.indexOf("if (this.session.user) {", registerStart);
  const codeDisplay = controller.indexOf('this.view.renderRecoveryCode(this._lastRecoveryCode', sessionReady);
  const stableDisplay = controller.slice(sessionReady, codeDisplay);
  assert.ok(registerStart >= 0 && sessionReady > registerStart && codeDisplay > sessionReady);
  assert.match(stableDisplay, /stopSessionRefreshPolling\(\)/);
  assert.match(stableDisplay, /stopNotificationPolling\(\)/);
  assert.doesNotMatch(stableDisplay, /startSessionRefreshPolling\(\)/);
  assert.match(controller, /async checkCurrentSession\(\) \{[\s\S]*?if \(readPendingRecovery\(\) \|\| !this\.session\?\.user/);
  assert.match(controller, /async refreshSessions\(\) \{[\s\S]*?if \(readPendingRecovery\(\)/);
  assert.match(controller, /startSessionRefreshPolling\(\) \{[\s\S]*?if \(readPendingRecovery\(\) \|\| !this\.session\?\.user\) return/);
  assert.match(controller, /startNotificationPolling\(\) \{[\s\S]*?if \(readPendingRecovery\(\) \|\| !this\.session\?\.user\) return/);
  assert.match(controller, /document.addEventListener\('visibilitychange',[\s\S]*?if \(readPendingRecovery\(\) \|\| !this\.session\.user\) return/);
  assert.match(controller, /async refreshNotifications\(\) \{\s*if \(readPendingRecovery\(\) \|\| !this\.session\?\.user\) return/);
  assert.match(controller, /async syncPendingLocalDrafts\(\) \{\s*if \(readPendingRecovery\(\)/);
  assert.match(controller, /this\.session\.restore\(\)/);
  assert.match(controller, /document\.execCommand\('copy'\)/);
  assert.match(controller, /El código quedó seleccionado para copiarlo manualmente/);
  const rotationStart = controller.indexOf("} else if (form.id === 'recovery-code-form') {");
  const rotationDisplay = controller.indexOf('this.view.renderRecoveryCode(pending.recoveryCode', rotationStart);
  assert.match(controller.slice(rotationStart, rotationDisplay), /stopSessionRefreshPolling\(\)/);
  const continuationStart = controller.indexOf('async continueAfterRecoverySaved()');
  const continuationEnd = controller.indexOf('async retryRecoveryOperation()', continuationStart);
  assert.match(controller.slice(continuationStart, continuationEnd), /startSessionRefreshPolling\(\)/);
  assert.match(view, /data-action="copy-recovery"/);
  assert.match(view, /Permanecerá aquí hasta que confirmes que lo guardaste/);
  assert.match(view, /data-action="continue-after-recovery"/);
  assert.match(controller, /title: '¿Ya guardaste el código\?'[\s\S]*?cancelLabel: 'Seguir en esta pantalla'/);
  const initStart = controller.indexOf('async init()');
  const pendingRead = controller.indexOf('const pendingRecovery = readPendingRecovery()', initStart);
  const restoreAfterPending = controller.indexOf('const restored = await this.session.restore()', initStart);
  assert.ok(pendingRead > initStart && restoreAfterPending > pendingRead,
    'la pantalla del código pendiente debe mostrarse antes de cualquier restauración remota de sesión');
  assert.match(controller, /serverConfirmed === true/);
  assert.match(controller, /markPendingRecoveryConfirmed\(\)/);
});

test('una sesión revocada durante la entrega no interrumpe la copia, pero tampoco se restaura al continuar', async () => {
  const controller = await readControllerSource();
  const callbackStart = controller.indexOf('this.sessionChannel.onmessage = event => {');
  const callbackEnd = controller.indexOf('\n      };', callbackStart);
  const callback = controller.slice(callbackStart, callbackEnd);
  assert.match(callback, /if \(readPendingRecovery\(\)\) \{[\s\S]*?_sessionRevokedWhileRecoveryPending = true;[\s\S]*?return;/);
  const continueStart = controller.indexOf('async continueAfterRecoverySaved()');
  const continueEnd = controller.indexOf('async retryRecoveryOperation()', continueStart);
  const continuation = controller.slice(continueStart, continueEnd);
  assert.match(continuation, /if \(this\._sessionRevokedWhileRecoveryPending\) \{[\s\S]*?this\.session\.clearSession\(\)[\s\S]*?renderLogin/);
  const css = await read('../assets/css/app.css');
  assert.match(css, /\.recovery-list[^}]*-webkit-user-select:all/);
});
