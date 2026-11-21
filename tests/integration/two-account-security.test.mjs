import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';

const productionProjectRef = 'tiqbmuubpbmxqvtkcdhq';
const env = process.env;
const required = [
  'NR_TEST_SUPABASE_URL', 'NR_TEST_PROJECT_REF', 'NR_TEST_PUBLISHABLE_KEY',
  'NR_TEST_CONFIRM_ISOLATED', 'NR_TEST_BOOTSTRAP_INVITATION',
  'NR_TEST_ACCOUNT_A_USERNAME', 'NR_TEST_ACCOUNT_A_PASSWORD', 'NR_TEST_ACCOUNT_A_DISPLAY_NAME',
  'NR_TEST_ACCOUNT_B_USERNAME', 'NR_TEST_ACCOUNT_B_PASSWORD', 'NR_TEST_ACCOUNT_B_DISPLAY_NAME'
];
const configured = required.every(name => Boolean(env[name]));

function recoveryCode() {
  const bytes = randomBytes(24);
  const hex = bytes.toString('hex').toUpperCase();
  return hex.match(/.{6}/g).join('-');
}

function assertIsolatedTarget() {
  assert.equal(env.NR_TEST_CONFIRM_ISOLATED, 'YES', 'Debes confirmar que el proyecto es desechable con NR_TEST_CONFIRM_ISOLATED=YES.');
  assert.notEqual(env.NR_TEST_PROJECT_REF, productionProjectRef, 'Bloqueado: no se permite ejecutar pruebas destructivas contra producción.');
  const url = new URL(env.NR_TEST_SUPABASE_URL);
  assert.equal(url.protocol, 'https:');
  assert.equal(url.hostname, `${env.NR_TEST_PROJECT_REF}.supabase.co`, 'El host no coincide con NR_TEST_PROJECT_REF.');
  assert.notEqual(url.hostname, `${productionProjectRef}.supabase.co`, 'Bloqueado: proyecto de producción.');
}

async function post(functionName, action, payload = {}, accessToken = null) {
  const headers = {
    'Content-Type': 'application/json',
    apikey: env.NR_TEST_PUBLISHABLE_KEY
  };
  if (accessToken) headers.Authorization = `Bearer ${accessToken}`;
  const response = await fetch(`${env.NR_TEST_SUPABASE_URL.replace(/\/$/, '')}/functions/v1/${functionName}`, {
    method: 'POST', headers, body: JSON.stringify({ action, ...payload }), cache: 'no-store'
  });
  let data = {};
  try { data = await response.json(); } catch { data = {}; }
  return { status: response.status, ok: response.ok && data.ok !== false, data };
}

const auth = (action, payload, token) => post('auth-api', action, payload, token);
const letters = (action, payload, token) => post('letters-api', action, payload, token);

async function registerAccount({ invite, username, password, displayName }) {
  const code = recoveryCode();
  const requestId = randomUUID();
  const payload = {
    invitationCode: invite,
    username,
    password,
    displayName,
    requestId,
    recoveryCode: code
  };
  const result = await auth('register', payload);
  assert.equal(result.status, 200, `Registro de ${username}: ${JSON.stringify(result.data)}`);
  assert.equal(result.data.accountCreated, true);
  assert.equal(result.data.authenticated, true);
  assert.ok(result.data.accessToken && result.data.refreshToken && result.data.sessionId);
  return { ...result.data, recoveryCode: code, registrationPayload: payload };
}

async function expectDenied(response, label) {
  assert.ok(response.status >= 400, `${label} debía rechazarse, pero respondió ${response.status}: ${JSON.stringify(response.data)}`);
}

test('seguridad real con dos cuentas en un proyecto Supabase aislado', { skip: !configured }, async () => {
  assertIsolatedTarget();

  // El proyecto debe estar vacío salvo por la invitación bootstrap, que se
  // genera manualmente en la base de pruebas con el rol postgres.
  const accountA = await registerAccount({
    invite: env.NR_TEST_BOOTSTRAP_INVITATION,
    username: env.NR_TEST_ACCOUNT_A_USERNAME,
    password: env.NR_TEST_ACCOUNT_A_PASSWORD,
    displayName: env.NR_TEST_ACCOUNT_A_DISPLAY_NAME
  });

  // Repetir exactamente la misma petición debe reanudar el alta, no crear
  // otra cuenta ni consumir una segunda invitación.
  const replayA = await auth('register', accountA.registrationPayload);
  assert.equal(replayA.status, 200, `Reintento idempotente A: ${JSON.stringify(replayA.data)}`);
  assert.equal(replayA.data.accountCreated, true);
  assert.equal(replayA.data.user?.id, accountA.user.id, 'El reintento debe devolver la misma cuenta, no crear otra.');

  // Una clave de petición distinta no puede reutilizar la invitación consumida.
  const reusedInvite = await auth('register', {
    ...accountA.registrationPayload,
    username: `reuso-${randomUUID().slice(0, 8)}`,
    requestId: randomUUID(),
    recoveryCode: recoveryCode()
  });
  await expectDenied(reusedInvite, 'Reutilización de invitación');

  const invitation = await auth('invitation:create', {}, accountA.accessToken);
  assert.equal(invitation.status, 200, `Crear invitación B: ${JSON.stringify(invitation.data)}`);
  assert.match(invitation.data.code || '', /^NR1-/);

  const accountB = await registerAccount({
    invite: invitation.data.code,
    username: env.NR_TEST_ACCOUNT_B_USERNAME,
    password: env.NR_TEST_ACCOUNT_B_PASSWORD,
    displayName: env.NR_TEST_ACCOUNT_B_DISPLAY_NAME
  });

  // Cuenta A crea un borrador privado. Repetir la clave creationRequestId
  // simula que el backend confirmó el guardado pero se perdió la respuesta.
  const creationRequestId = randomUUID();
  const draftPayload = {
    creationRequestId,
    title: `Prueba privada ${creationRequestId.slice(0, 8)}`,
    body: '<p>Contenido de prueba, no sensible.</p>',
    userId: accountB.user?.id // Identidad falsificada deliberadamente; debe ignorarse.
  };
  const draftFirst = await letters('draft:create', draftPayload, accountA.accessToken);
  assert.equal(draftFirst.status, 200, `Crear borrador A: ${JSON.stringify(draftFirst.data)}`);
  const draftId = draftFirst.data.draft?.id;
  assert.ok(draftId);
  assert.equal(draftFirst.data.draft.senderId || draftFirst.data.draft.sender_id, accountA.user.id);

  const draftReplay = await letters('draft:create', draftPayload, accountA.accessToken);
  assert.equal(draftReplay.status, 200);
  assert.equal(draftReplay.data.draft?.id, draftId, 'El reintento no debe duplicar el borrador.');

  const bDrafts = await letters('list', { folder: 'drafts' }, accountB.accessToken);
  assert.equal(bDrafts.status, 200);
  assert.equal((bDrafts.data.items || []).some(item => item.id === draftId), false);

  const draftBResult = await letters('draft:create', {
    creationRequestId: randomUUID(), title: 'Borrador privado de B', body: '<p>Solo B puede verlo.</p>'
  }, accountB.accessToken);
  assert.equal(draftBResult.status, 200);
  const draftBId = draftBResult.data.draft?.id;
  const draftBThread = draftBResult.data.draft?.threadId || draftBResult.data.draft?.thread_id;
  assert.ok(draftBId && draftBThread);
  await expectDenied(await letters('get', { letterId: draftBId }, accountA.accessToken), 'A lee borrador privado de B');
  await expectDenied(await letters('draft:save', { letterId: draftBId, title: 'intrusión', body: '<p>x</p>', expectedRevision: 1 }, accountA.accessToken), 'A modifica borrador de B');
  await expectDenied(await letters('draft:send', { letterId: draftBId, expectedRevision: 1 }, accountA.accessToken), 'A envía borrador de B');
  await expectDenied(await letters('read', { threadId: draftBThread }, accountA.accessToken), 'A marca como leída una conversación provisional de B');

  await expectDenied(await letters('get', { letterId: draftId }, accountB.accessToken), 'B lee borrador privado de A');
  await expectDenied(await letters('draft:save', { letterId: draftId, title: 'intrusión', body: '<p>x</p>', expectedRevision: 1 }, accountB.accessToken), 'B modifica borrador de A');
  await expectDenied(await letters('draft:send', { letterId: draftId, expectedRevision: 1 }, accountB.accessToken), 'B envía borrador de A');
  await expectDenied(await letters('favorite', { letterId: draftId, favorite: true }, accountB.accessToken), 'B marca favorito el borrador de A');
  await expectDenied(await letters('archive', { letterId: draftId, archived: true }, accountB.accessToken), 'B archiva borrador de A');
  await expectDenied(await letters('trash', { letterId: draftId }, accountB.accessToken), 'B mueve a papelera borrador de A');
  await expectDenied(await letters('purge', { letterId: draftId }, accountB.accessToken), 'B elimina borrador de A');

  // Repite el mismo autosave con revisión antigua, simulando que se perdió la
  // respuesta HTTP después del COMMIT. Debe conservar el contenido y no crear
  // una revisión/conflicto duplicado.
  const autosavePayload = {
    letterId: draftId, title: 'Autosave confirmado', body: '<p>Contenido guardado antes de perder la respuesta.</p>',
    expectedRevision: 1
  };
  const autosaveFirst = await letters('draft:save', autosavePayload, accountA.accessToken);
  assert.equal(autosaveFirst.status, 200, `Primer autosave: ${JSON.stringify(autosaveFirst.data)}`);
  const autosaveReplay = await letters('draft:save', autosavePayload, accountA.accessToken);
  assert.equal(autosaveReplay.status, 200, `Reintento del autosave: ${JSON.stringify(autosaveReplay.data)}`);
  const afterAutosave = await letters('get', { letterId: draftId }, accountA.accessToken);
  assert.equal(afterAutosave.status, 200);
  assert.equal(afterAutosave.data.letter?.title, 'Autosave confirmado');

  // A no puede listar ni revocar sesiones de B, ni aunque conozca el UUID.
  const bSessions = await letters('sessions', {}, accountB.accessToken);
  assert.equal(bSessions.status, 200);
  const bCurrentSession = (bSessions.data.sessions || []).find(item => item.isCurrent);
  assert.ok(bCurrentSession?.id);
  const aSessions = await letters('sessions', {}, accountA.accessToken);
  assert.equal(aSessions.status, 200);
  assert.equal((aSessions.data.sessions || []).some(item => item.id === bCurrentSession.id), false);
  await expectDenied(await letters('session:revoke', { sessionId: bCurrentSession.id }, accountA.accessToken), 'A revoca sesión de B');
  const aCurrentSession = (aSessions.data.sessions || []).find(item => item.isCurrent);
  assert.ok(aCurrentSession?.id);
  assert.equal((bSessions.data.sessions || []).some(item => item.id === aCurrentSession.id), false);
  await expectDenied(await letters('session:revoke', { sessionId: aCurrentSession.id }, accountB.accessToken), 'B revoca sesión de A');
  const bStillActive = await auth('session', {}, accountB.accessToken);
  assert.equal(bStillActive.status, 200);

  // B abre una segunda sesión; su propia sesión inicial puede revocarla.
  const bSecondLogin = await auth('login', {
    identifier: env.NR_TEST_ACCOUNT_B_USERNAME,
    password: env.NR_TEST_ACCOUNT_B_PASSWORD
  });
  assert.equal(bSecondLogin.status, 200);
  assert.notEqual(bSecondLogin.data.sessionId, accountB.sessionId);
  const revokeOwn = await letters('session:revoke', { sessionId: bSecondLogin.data.sessionId }, accountB.accessToken);
  assert.equal(revokeOwn.status, 200);
  const revokedSessionUse = await auth('session', {}, bSecondLogin.data.accessToken);
  await expectDenied(revokedSessionUse, 'Una sesión revocada intenta operar');

  // A envía la carta; solo el destinatario B puede responder y marcarla leída.
  const send = await letters('draft:send', { letterId: draftId, expectedRevision: 2 }, accountA.accessToken);
  assert.equal(send.status, 200, `Enviar carta A: ${JSON.stringify(send.data)}`);
  assert.equal(send.data.status, 'sent');
  const sentLetter = send.data.letter;
  assert.ok(sentLetter?.thread_id);
  assert.equal(sentLetter.sender_id, accountA.user.id);
  assert.equal(sentLetter.recipient_id, accountB.user.id);

  const bInbox = await letters('list', { folder: 'inbox' }, accountB.accessToken);
  assert.equal(bInbox.status, 200);
  assert.equal((bInbox.data.items || []).some(item => item.id === draftId), true);
  await expectDenied(await letters('reply', {
    parentLetterId: draftId, title: 'Respuesta falsificada', body: '<p>no</p>'
  }, accountA.accessToken), 'El remitente intenta responder a su propia carta');

  const reply = await letters('reply', {
    parentLetterId: draftId,
    creationRequestId: randomUUID(),
    title: 'Respuesta de B',
    body: '<p>Respuesta desde la cuenta destinataria.</p>'
  }, accountB.accessToken);
  assert.equal(reply.status, 200, `Respuesta B: ${JSON.stringify(reply.data)}`);
  const threadId = sentLetter.thread_id;
  // Que el remitente intente marcar la conversación como leída no debe tocar
  // el estado de lectura del destinatario.
  const senderReadAttempt = await letters('read', { threadId }, accountA.accessToken);
  assert.equal(senderReadAttempt.status, 200);
  const stillUnread = await letters('list', { folder: 'sent' }, accountA.accessToken);
  const stillUnreadLetter = (stillUnread.data.items || []).find(item => item.id === draftId);
  assert.equal(stillUnreadLetter?.readByRecipientAt || null, null);

  const markRead = await letters('read', { threadId }, accountB.accessToken);
  assert.equal(markRead.status, 200);
  // El destinatario puede archivar su copia, pero no modifica la organización
  // personal que el remitente ve en Enviadas.
  const bArchive = await letters('archive', { letterId: draftId, archived: true }, accountB.accessToken);
  assert.equal(bArchive.status, 200);
  const bInboxAfterArchive = await letters('list', { folder: 'inbox' }, accountB.accessToken);
  assert.equal((bInboxAfterArchive.data.items || []).some(item => item.id === draftId), false);
  const aBundle = await letters('get', { letterId: draftId }, accountA.accessToken);
  assert.equal(aBundle.status, 200);
  const bundleText = JSON.stringify(aBundle.data);
  assert.match(bundleText, /Respuesta de B|Respuesta desde la cuenta destinataria/);
  const aSent = await letters('list', { folder: 'sent' }, accountA.accessToken);
  const sentFromA = (aSent.data.items || []).find(item => item.id === draftId);
  assert.ok(sentFromA?.readByRecipientAt, 'El destinatario B debe ser el único que marque su lectura.');

  // Código de recuperación de un solo uso: se consume una vez y se rechaza
  // al reutilizarlo. La cuenta B se autentica de nuevo con la contraseña nueva.
  const recoveredPassword = `NR-Test-${randomUUID()}-Aa9!`;
  const crossAccountRecovery = await auth('recover-with-code', {
    username: env.NR_TEST_ACCOUNT_A_USERNAME,
    recoveryCode: accountB.recoveryCode,
    password: `NR-Cross-${randomUUID()}-Cc7!`
  });
  await expectDenied(crossAccountRecovery, 'B usa su código para recuperar la cuenta A');
  const recovery = await auth('recover-with-code', {
    username: env.NR_TEST_ACCOUNT_B_USERNAME,
    recoveryCode: accountB.recoveryCode,
    password: recoveredPassword
  });
  assert.equal(recovery.status, 200, `Recuperación B: ${JSON.stringify(recovery.data)}`);
  const replayRecovery = await auth('recover-with-code', {
    username: env.NR_TEST_ACCOUNT_B_USERNAME,
    recoveryCode: accountB.recoveryCode,
    password: `NR-Replay-${randomUUID()}-Bb8!`
  });
  await expectDenied(replayRecovery, 'Reutilización del código de recuperación');
  const bAfterRecovery = await auth('login', {
    identifier: env.NR_TEST_ACCOUNT_B_USERNAME,
    password: recoveredPassword
  });
  assert.equal(bAfterRecovery.status, 200, 'La contraseña nueva debe permitir el acceso.');

  // Eliminar B no debe destruir la carta que ya conserva el buzón de A.
  const deleted = await auth('account:delete', {
    currentPassword: recoveredPassword,
    confirmation: 'ELIMINAR'
  }, bAfterRecovery.data.accessToken);
  assert.equal(deleted.status, 200, `Eliminar B: ${JSON.stringify(deleted.data)}`);
  assert.equal(deleted.data.sharedLettersPreserved, true);
  const retained = await letters('get', { letterId: draftId }, accountA.accessToken);
  assert.equal(retained.status, 200);
  const retainedThread = retained.data.thread || [];
  assert.ok(retainedThread.some(item => item.id === draftId), 'La carta original debe conservarse.');
  assert.ok(retainedThread.some(item => /Respuesta de B/.test(String(item.title || '') + String(item.body || ''))), 'La respuesta compartida de B también debe conservarse.');
  assert.match(JSON.stringify(retained.data), /Cuenta eliminada/);

  // Rate limit de IP con identificadores inexistentes: se evita bloquear una
  // cuenta real y se comprueba el límite agregado al variar el username.
  let ipLimited = false;
  for (let i = 0; i < 40; i++) {
    const attempt = await auth('login', {
      identifier: `no-existe-${randomUUID()}`,
      password: `Bad-${randomUUID()}-Aa1!`
    });
    if (attempt.status === 429) {
      ipLimited = true;
      assert.ok(Number(attempt.data.retryAfterSeconds) > 0);
      break;
    }
    assert.equal(attempt.status, 401, `Intento inesperado: ${JSON.stringify(attempt.data)}`);
  }
  assert.equal(ipLimited, true, 'El bucket de IP debía limitar la ráfaga de identificadores distintos. Revisa que cf-connecting-ip llegue al Edge Function.');
});
