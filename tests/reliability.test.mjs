import test from 'node:test';
import assert from 'node:assert/strict';
import { readCssBundle } from './helpers/style-source.mjs';
import { readFile } from 'node:fs/promises';

const read = path => readFile(new URL(path, import.meta.url), 'utf8');
import { readControllerSource } from './helpers/controller-source.mjs';

test('la sesión revocada desaparece inmediatamente y se vuelve a verificar en Configuración', async () => {
  const controller = await readControllerSource();
  assert.match(controller, /this\.state\.sessions = \(this\.state\.sessions \|\| \[\]\)\.filter\(item => item\.id !== sessionId\)/);
  assert.match(controller, /async refreshSessions\(\)/);
  assert.match(controller, /checkCurrentSession\(\)/);
  assert.match(controller, /activeIntervalMs: 5 \* 60_000/);
  assert.match(controller, /idleIntervalMs: 15 \* 60_000/);
  assert.match(controller, /auth\('session'\)/);
  assert.match(controller, /BroadcastChannel\('nuestro-rincon-session-events'\)/);
  assert.match(controller, /postMessage\(\{ type: 'session-revoked', sessionId \}\)/);
  assert.match(controller, /!sessions\.some\(item => item\.isCurrent\)/);
});

test('la eliminación de cuenta requiere contraseña y confirmación reforzada', async () => {
  const view = await read('../assets/js/views/app-view.js');
  const controller = await readControllerSource();
  const auth = await read('../supabase/functions/auth-api/index.ts');
  const migrations = await read('../supabase/migrations/20261117033226_secure_account_deletion.sql');
  assert.match(view, /id="delete-account-form"/);
  assert.match(view, /name="currentPassword"/);
  assert.match(view, /name="confirmation"[^>]*pattern="ELIMINAR"/);
  assert.match(controller, /form\.id === 'delete-account-form'/);
  assert.match(auth, /action === 'account:delete'/);
  assert.match(auth, /confirmation !== 'ELIMINAR'/);
  assert.match(auth, /verifyPassword\(currentPassword/);
  assert.match(migrations, /create or replace function public\.delete_app_account/);
  assert.match(migrations, /status = 'disabled'/);
  assert.match(migrations, /shared_letters_preserved/);
  assert.match(migrations, /revoke execute[\s\S]*from public, anon, authenticated/i);
  assert.match(migrations, /grant execute[\s\S]*to service_role/i);
});

test('el borrador se respalda localmente al salir y se reanuda al volver a abrir la app', async () => {
  const controller = await readControllerSource();
  const localDrafts = await read('../assets/js/services/local-drafts.js');
  const api = await read('../assets/js/services/api-client.js');
  assert.match(controller, /persistEmergencyDraft\(/);
  assert.match(controller, /restoreEmergencyDraft\(/);
  assert.match(controller, /addEventListener\('pagehide'/);
  assert.match(controller, /addEventListener\('beforeunload'/);
  assert.match(controller, /visibilitychange/);
  assert.match(controller, /syncPendingLocalDrafts\(/);
  assert.match(controller, /getLocalDraftsForUser/);
  assert.match(controller, /enqueueDraftSync\(/);
  assert.match(localDrafts, /getLocalDraftsForUser\(/);
  assert.match(localDrafts, /deleteLocalDraftsForUser\(/);
  assert.match(api, /keepalive/);
  assert.match(api, /requestBody\.length <= 60000/);
});

test('las escrituras de borradores se serializan y un ID remoto desaparecido se recupera sin borrar la copia local', async () => {
  const controller = await readControllerSource();
  const draftSync = await read('../assets/js/services/draft-sync-service.js');
  const api = await read('../assets/js/services/api-client.js');
  assert.match(controller, /this\.draftSyncQueue = new DraftSyncQueue\(\)/);
  assert.match(controller, /this\.draftSyncQueue\.enqueue\(queueKey/);
  assert.doesNotMatch(controller, /this\.draftQueues = new Map\(\)/);
  assert.match(draftSync, /if \(error\.status !== 404 && error\.code !== 'DRAFT_NOT_FOUND'\) throw error/);
  assert.match(draftSync, /const replacementRequestId = crypto\.randomUUID\(\)/);
  assert.match(draftSync, /No se pudo recuperar la copia local como un nuevo borrador/);
  assert.match(draftSync, /await deleteLocalDraft\(oldStorageKey\)/);
  assert.match(api, /safeToRetry: RETRYABLE_READ_ACTIONS\.has\(action\)/);
});

test('el guardado automático nunca restaura un borrador que ya está en Papelera', async () => {
  const letters = await read('../supabase/functions/letters-api/index.ts');
  const start = letters.indexOf("case 'draft:save':");
  const end = letters.indexOf("case 'draft:send':", start);
  const saveCase = letters.slice(start, end);
  assert.match(saveCase, /letter_user_state/);
  assert.match(saveCase, /if \(state\?\.trashed_at\) return \{ status: 'discarded'/);
  assert.doesNotMatch(saveCase, /restore_letter_from_trash/);
  const sendStart = letters.indexOf("case 'draft:send':");
  const sendEnd = letters.indexOf("case 'reply':", sendStart);
  const sendCase = letters.slice(sendStart, sendEnd);
  assert.match(sendCase, /letter_user_state/);
  assert.match(sendCase, /if \(state\?\.trashed_at\) return \{ status: 'discarded'/);
  assert.match(letters, /case 'restore':/);
});

test('descartar un borrador es de una sola pulsación y retira la tarjeta sin esperar la cola', async () => {
  const controller = await readControllerSource();
  const view = await read('../assets/js/views/app-view.js');
  assert.match(controller, /if \(!isDraft && !\(await showConfirmDialog\(/);
  assert.match(controller, /this\.discardedDraftIds\.add\(letterId\)/);
  assert.doesNotMatch(controller, /waitForDraftSyncQueue/);
  const discard = controller.slice(controller.indexOf('async discardLetter('), controller.indexOf('  queueDraftSync(snapshot'));
  assert.ok(discard.indexOf('this.state.letters = (this.state.letters || []).filter') < discard.indexOf('await this.repository.moveToTrash'));
  assert.match(discard, /this\.restoreLetterState\(before\)/);
  assert.match(view, /data-letter-status="\$\{escapeHtml\(item\.status\)\}"/);
});

test('los guardados se serializan por cuenta y descartan copias locales de una carta en Papelera', async () => {
  const controller = await readControllerSource();
  const draftSync = await read('../assets/js/services/draft-sync-service.js');
  const localDrafts = await read('../assets/js/services/local-drafts.js');
  assert.match(controller, /draftSyncQueueKey\(\)/);
  assert.match(controller, /const queueKey = this\.draftSyncQueueKey\(\)/);
  assert.match(controller, /clearLocalDraftForLetter\(/);
  assert.match(draftSync, /result\.status === 'discarded'/);
  assert.match(controller, /this\.discardedDraftIds\.has\(snapshot\.letterId\)/);
  assert.match(localDrafts, /savedAt: draft\.savedAt \|\| new Date\(\)\.toISOString\(\)/);
});

test('un reintento idéntico de guardado no genera conflicto por una revisión antigua', async () => {
  const sql = await read('../supabase/migrations/20261117051628_idempotent_draft_revision_conflicts.sql');
  const same = sql.indexOf('v_letter.title is not distinct from p_title');
  const conflict = sql.indexOf('if v_letter.revision <> p_expected_revision');
  assert.ok(same >= 0 && conflict > same, 'la igualdad del contenido debe comprobarse antes de la revisión');
  assert.match(sql, /grant execute[\s\S]*to service_role/i);
});

test('la vinculación inicial de destinatario está permitida una sola vez y no desactiva la inmutabilidad', async () => {
  const migration = await read('../supabase/migrations/20261117035219_allow_provisional_draft_recipient_binding.sql');
  assert.match(migration, /old\.status = 'draft'/);
  assert.match(migration, /old\.recipient_id is null/);
  assert.match(migration, /new\.recipient_id is not null/);
  assert.match(migration, /v_recipient_binding_allowed/);
  assert.match(migration, /LETTER_IDENTITY_IMMUTABLE/);
});

test('el diseño cubre los siete anchos requeridos y ofrece un enlace de salto coherente', async () => {
  const css = await readCssBundle();
  const html = await read('../index.html');
  const appView = await read('../assets/js/views/app-view.js');
  const widths = [
    { width: 320, rule: /@media \(max-width: 360px\)/ },
    { width: 375, rule: /@media \(max-width: 720px\)/ },
    { width: 425, rule: /@media \(max-width: 720px\)/ },
    { width: 768, rule: /@media \(min-width: 721px\) and \(max-width: 820px\)/ },
    { width: 1024, rule: /@media \(min-width: 821px\) and \(max-width: 1199px\)/ },
    { width: 1440, rule: /@media \(min-width: 1440px\) and \(max-width: 2199px\)/ },
    { width: 2560, rule: /@media \(min-width: 2200px\)/ }
  ];
  for (const item of widths) assert.match(css, item.rule, `Falta una regla para ${item.width}px`);
  assert.match(appView, /class="skip-link" href="#main-content"/);
  assert.match(css, /\.skip-link:focus/);
});


test('las claves antiguas de borradores purgados generan una nueva carta idempotente', async () => {
  const sql = await read('../supabase/migrations/20261117041103_idempotent_recovery_for_purged_drafts.sql');
  const controller = await readControllerSource();
  const draftSync = await read('../assets/js/services/draft-sync-service.js');
  assert.match(sql, /v_letter\.status <> 'purged'/);
  assert.match(sql, /nuestro-rincon-purged-draft/);
  assert.match(sql, /v_effective_request_id/);
  assert.match(draftSync, /created\?\.draft\?\.status === 'purged'/);
  assert.match(draftSync, /DRAFT_CREATE_UNCONFIRMED/);
});

test('la cuenta eliminada libera uno de los dos espacios de registro', async () => {
  const sql = await read('../supabase/migrations/20261117041205_reuse_account_slot_after_deletion.sql');
  assert.match(sql, /where status in \('active', 'pending_email'\)/);
  assert.doesNotMatch(sql, /select count\(\*\)::integer into v_account_count from public\.app_users;/);
});

test('la sesión revocada se valida globalmente y las pestañas comparten el evento de revocación', async () => {
  const controller = await readControllerSource();
  const session = await read('../assets/js/services/session-service.js');
  const auth = await read('../supabase/functions/auth-api/index.ts');
  assert.match(controller, /async checkCurrentSession\(\)/);
  assert.match(controller, /this\.session\.api\.auth\('session'\)/);
  assert.match(controller, /this\.forceLogout\(\)/);
  assert.match(controller, /activeIntervalMs: 5 \* 60_000/);
  assert.match(controller, /idleIntervalMs: 15 \* 60_000/);
  assert.match(controller, /BroadcastChannel\('nuestro-rincon-session-events'\)/);
  assert.match(session, /this\.sessionId = payload\.sessionId/);
  assert.match(session, /this\.sessionId = null/);
  assert.match(auth, /sessionId: session\.sessionId/);
});

test('la copia local se actualiza en cada pulsación y se hidrata sin bloquear la sección de escritura', async () => {
  const controller = await readControllerSource();
  assert.match(controller, /this\.persistLocalDraft\(\)\.catch\(\(\) => \{\}\)/);
  assert.match(controller, /hydrateEditorFromLocal\(/);
  assert.match(controller, /readEmergencyDraft\(draftKey\)/);
  assert.match(controller, /No retrasar el cambio de sección esperando IndexedDB/);
});


test('la sincronización de un borrador no elimina la copia de emergencia de otra carta abierta', async () => {
  const controller = await readControllerSource();
  const draftSync = await read('../assets/js/services/draft-sync-service.js');
  assert.match(draftSync, /emergencyLatest && !\(controller\.state\.editor && controller\.state\.route === 'write' && !currentMatches\)/);
  assert.match(draftSync, /No borres la emergencia de una carta diferente que se esté editando/);
});
