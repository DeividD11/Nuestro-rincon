import test from 'node:test';
import { readAppViewSource } from './helpers/view-source.mjs';
import assert from 'node:assert/strict';
import { readCssBundle } from './helpers/style-source.mjs';
import { readFile } from 'node:fs/promises';

const read = path => readFile(new URL(path, import.meta.url), 'utf8');
import { readControllerSource } from './helpers/controller-source.mjs';

const LETTER_ID = '11111111-1111-4111-8111-111111111111';

 test('la caché privada está aislada por cuenta y el cambio de identidad vacía los datos visibles', async () => {
  const source = await readControllerSource();
  assert.match(source, /return `\$\{route\}:\$\{accountId\}:/);
  const reset = source.slice(source.indexOf('resetPrivateSessionState(user = null)'), source.indexOf('uniqueLetters(items = [])'));
  for (const state of ['this.routeCache.clear()', 'this.routePrefetches.clear()', 'this.state.letters = []', 'this.state.selectedLetter = null', 'this.state.notifications = []']) {
    assert.ok(reset.includes(state), `Falta limpiar ${state}`);
  }
  assert.match(source, /await this\.session\.login\([\s\S]*?resetPrivateSessionState\(this\.session\.user\)/);
  assert.match(source, /forceLogout\(\)[\s\S]*?resetPrivateSessionState\(null\)/);
});

test('la lista y el inicio eliminan duplicados por ID antes de renderizar', async () => {
  const { AppView } = await import('../assets/js/views/app-view.js');
  const view = new AppView({});
  const duplicate = { id: LETTER_ID, status: 'sent', title: 'Una sola carta', body: 'Contenido', isFavorite: false, isArchived: false, isInTrash: false, updated_at: '2026-11-19T00:00:00Z' };
  const markup = view.renderList({ route: 'inbox', search: '', letters: [duplicate, { ...duplicate }] });
  assert.equal((markup.match(/<article class="letter-card/g) || []).length, 1);
  const home = view.renderHome({ user: { displayName: 'Cuenta' }, dashboard: { recent: [duplicate, { ...duplicate }] } });
  assert.equal((home.match(new RegExp(`data-letter-id="${LETTER_ID}"`, 'g')) || []).length, 1);
});

test('la apertura muestra primero el resumen local y no espera a marcar leído ni a recargar el dashboard', async () => {
  const source = await readControllerSource();
  const method = source.slice(source.indexOf('async openLetter(letterId'), source.indexOf('async openLetterForSend'));
  assert.match(method, /if \(sameThread\)[\s\S]*this\.view\.renderLetterDetail\(this\.state\)[\s\S]*return/);
  assert.match(method, /const data = await this\.repository\.get\(targetId\)/);
  assert.doesNotMatch(method, /await this\.repository\.markRead/);
  assert.match(method, /this\.markThreadReadInBackground\(data\)/);
  assert.match(source, /markThreadReadInBackground\(data\)[\s\S]*?await this\.repository\.dashboard\(\)/);
});

test('las operaciones de estado de una carta se serializan para evitar doble pulsación', async () => {
  const source = await readControllerSource();
  assert.match(source, /this\.pendingLetterActions = new Set\(\)/);
  assert.match(source, /if \(guardedLetterId && this\.pendingLetterActions\.has\(guardedLetterId\)\) return/);
  assert.match(source, /guardedButtons\.forEach\(button => \{ button\.disabled = true/);
  assert.match(source, /finally \{[\s\S]*this\.pendingLetterActions\.delete\(guardedLetterId\)/);
});

test('las acciones de Papelera muestran claramente la confirmación compartida y evitan repetirla', async () => {
  const { AppView } = await import('../assets/js/views/app-view.js');
  const view = new AppView({});
  const item = { id: LETTER_ID, status: 'sent', title: 'Carta compartida', body: 'Contenido', isInTrash: true, purgeConfirmedAt: '2026-11-19T01:00:00Z' };
  const markup = view.letterCard(item);
  assert.match(markup, /Tu confirmación está guardada/);
  assert.match(markup, /Esperando confirmación/);
  assert.match(markup, /disabled aria-disabled="true"/);
  const source = await readControllerSource();
  assert.match(source, /result\.status === 'already_confirmed_waiting'/);
  assert.match(source, /La carta seguirá en Papelera hasta que la otra persona confirme/);
});

test('las listas y la vista de conversación deduplican mensajes por ID', async () => {
  const source = await readAppViewSource();
  assert.match(source, /const items = \[\.\.\.new Map\(\(state\.letters \|\| \[\]\)/);
  assert.match(source, /const threadItems = \[\.\.\.new Map\(\(data\.thread \|\| \[\]\)/);
  assert.match(source, /threadItems\.length > 1/);
  const api = await read('../supabase/functions/letters-api/index.ts');
  assert.match(api, /const rows = page\.items\.map\(entry => entry\.letter\)/);
  assert.match(api, /if \(items\.length !== value\.items\.length\) throw new Error\('LETTER_LIST_RESPONSE_INVALID'\)/);
  assert.match(api, /purgeConfirmedAt: state\?\.purge_confirmed_at/);
});

test('la eliminación definitiva distingue la confirmación pendiente de la eliminación completada', async () => {
  const source = await readControllerSource();
  assert.match(source, /result\.status === 'pending_other_participant'/);
  assert.match(source, /result\.status === 'purged' \|\| result\.status === 'already_purged'/);
  assert.match(source, /No se pudo confirmar la eliminación/);
  const migration = await read('../supabase/migrations/20261119090000_shared_letter_purge_and_reply_guard.sql');
  assert.match(migration, /already_confirmed_waiting/);
  assert.match(migration, /confirmedParticipants/);
});

test('se puede purgar una respuesta aunque su carta padre ya esté purgada', async () => {
  const migration = await read('../supabase/migrations/20261119090000_shared_letter_purge_and_reply_guard.sql');
  assert.match(migration, /if tg_op = 'INSERT' then[\s\S]*else[\s\S]*new\.reply_to_letter_id is distinct from old\.reply_to_letter_id/);
  assert.match(migration, /if v_validate_reply_parent and new\.reply_to_letter_id is not null then/);
  assert.match(migration, /old\.status = 'sent'[\s\S]*new\.status <> 'purged'/);
  const letters = await read('../supabase/functions/letters-api/index.ts');
  assert.match(letters, /case 'purge':[\s\S]*confirm_letter_permanent_deletion/);
});

test('conversation-item y sus botones tienen estados claros en temas claro y oscuro', async () => {
  const css = await readCssBundle();
  assert.match(css, /\.conversation-item\{[^}]*background:var\(--paper-2\)/);
  assert.match(css, /\.conversation-item \.btn-ghost,\.btn-ghost\{[^}]*border:1px solid/);
  assert.match(css, /html\[data-theme="dark"\] \.conversation-item/);
  assert.match(css, /html\[data-theme="dark"\] \.conversation-item \.btn-ghost/);
  assert.match(css, /\.btn:disabled/);
});


test('cambiar entre cartas del mismo hilo actualiza solo el detalle y conserva el shell', async () => {
  const controller = await readControllerSource();
  const view = await readAppViewSource();
  const method = controller.slice(controller.indexOf('async openLetter(letterId'), controller.indexOf('async openLetterForSend'));
  const partial = view.slice(view.indexOf('export function renderLetterDetail(view, state) {'), view.indexOf('export function renderLetterContent(view, state) {'));
  assert.match(method, /const sameThread = Boolean\(cachedItem/);
  assert.match(method, /if \(sameThread\)[\s\S]*this\.state\.selectedLetter = \{ \.\.\.currentBundle, letter: cachedItem, thread: currentThread \}/);
  assert.match(method, /if \(!this\.view\.renderLetterDetail\(this\.state\)\) this\.render\(\)/);
  assert.doesNotMatch(method.slice(method.indexOf('if (sameThread)'), method.indexOf('const userId')), /repository\.get/);
  assert.match(partial, /querySelector\('#letter-detail-content'\)/);
  assert.doesNotMatch(partial, /renderShell\(/);
});

test('el hilo muestra todas las cartas con una única lista de navegación', async () => {
  const view = await readAppViewSource();
  assert.match(view, /const renderThreadItem = item => \{/);
  assert.match(view, /const olderTimeline = threadItems\.slice\(0, threadBoundary\)\.map\(renderThreadItem\)/);
  assert.match(view, /const newerTimeline = threadItems\.slice\(threadBoundary\)\.map\(renderThreadItem\)/);
  assert.match(view, /class="conversation-item \$\{active \? 'is-active' : ''\}"/);
  assert.match(view, /data-action="open-letter" data-letter-id="\$\{escapeHtml\(item\.id\)\}"/);
  assert.match(view, /\$\{active \? 'Carta abierta' : 'Abrir carta'\}/);
});

test('un borrador nuevo no se persiste ni se crea sin texto en el cuerpo', async () => {
  const controller = await readControllerSource();
  const view = await readAppViewSource();
  const api = await read('../supabase/functions/letters-api/index.ts');
  assert.match(controller, /hasDraftBody\(body\)[\s\S]*plainTextFromHtml/);
  assert.match(controller, /const canPersist = Boolean\(this\.state\.editor\.letterId \|\| hasBody\)/);
  assert.match(controller, /if \(!editor\.letterId && !this\.hasDraftBody\(editor\.body\)\)/);
  assert.match(api, /case 'draft:create':[\s\S]*if \(!stripTags\(html\)\.replace\(\/&nbsp;\/g, ' '\)\.trim\(\)\) return \{ status: 'empty' \}/);
  assert.match(view, /Editor|write|Escribir carta/);
});

test('el descarte es optimista y el autoguardado SQL respeta el estado de Papelera', async () => {
  const controller = await readControllerSource();
  const migration = await read('../supabase/migrations/20261119090000_shared_letter_purge_and_reply_guard.sql');
  const discard = controller.slice(controller.indexOf('async discardLetter('), controller.indexOf('  queueDraftSync(snapshot'));
  assert.doesNotMatch(controller, /waitForDraftSyncQueue/);
  assert.ok(discard.indexOf('this.state.letters = (this.state.letters || []).filter') < discard.indexOf('await this.repository.moveToTrash'));
  assert.match(migration, /select \* into v_state[\s\S]*for update[\s\S]*v_state\.trashed_at is not null[\s\S]*'status','discarded'/);
  assert.match(migration, /grant execute on function public\.save_letter_draft\([\s\S]*to service_role/);
});

test('favoritos y archivo actualizan la interfaz antes de esperar al servidor', async () => {
  const controller = await readControllerSource();
  const favorite = controller.slice(controller.indexOf("case 'toggle-favorite': {"), controller.indexOf("case 'toggle-archive': {"));
  const archive = controller.slice(controller.indexOf("case 'toggle-archive': {"), controller.indexOf("case 'trash-letter': {"));
  for (const block of [favorite, archive]) {
    assert.match(block, /this\.patchLetterState\(letterId/);
    assert.match(block, /this\.renderCurrentRoute\(\)[\s\S]*await this\.repository/);
    assert.match(block, /this\.restoreLetterState\(before\)/);
    assert.doesNotMatch(block, /await this\.openRoute|await this\.openLetter/);
  }
});

test('las secciones comparten una escala de tipografía, superficies, controles y movimiento', async () => {
  const css = await readCssBundle();
  assert.match(css, /--nr-title-size/);
  assert.match(css, /--nr-section-size/);
  assert.match(css, /--nr-card-padding/);
  assert.match(css, /--nr-button-height/);
  assert.match(css, /--nr-motion/);
  assert.match(css, /\.app-shell \.panel,[\s\S]*\.app-shell \.setting-card,[\s\S]*\.app-shell \.conversation-panel/);
  assert.match(css, /prefers-reduced-motion:reduce[\s\S]*\.app-shell \.letter-card/);
});
