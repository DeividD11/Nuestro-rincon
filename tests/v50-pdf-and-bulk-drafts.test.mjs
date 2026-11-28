import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = path => readFile(new URL(path, import.meta.url), 'utf8');

test('el PDF vuelve a pedir la conversación completa y usa URLs firmadas recientes', async () => {
  const controller = await read('../assets/js/controllers/letter-controller.js');
  assert.match(controller, /repository\.get\(letterId, null, 100\)/);
  assert.match(controller, /while \(hasMore\)/);
  assert.match(controller, /repository\.get\(letterId, cursor, 100\)/);
  assert.match(controller, /renderLetterBodyHtml\(item\.body \|\| '', \{ eagerImages: true, showPlaceholder: false \}\)/);
  assert.match(controller, /Una imagen tardó demasiado en cargar/);
  assert.match(controller, /if \(image\.naturalWidth <= 0\) throw new Error/);
  assert.match(controller, /await image\.decode\(\)/);
  assert.match(controller, /window\.print\(\)/);
});

test('el PDF oculta los placeholders y limita imágenes y firma para no crear páginas huérfanas', async () => {
  const controller = await read('../assets/js/controllers/letter-controller.js');
  const helper = await read('../assets/js/utils/letter-images.js');
  assert.match(helper, /showPlaceholder = options\.showPlaceholder !== false/);
  assert.match(helper, /eagerImages \|\| index === 0 \? 'eager' : 'lazy'/);
  assert.match(helper, /export function renderEditorBodyHtml/);
  assert.doesNotMatch(helper.split('export function renderEditorBodyHtml')[1], /\beagerImages\b/);
  assert.match(controller, /@page\{size:A4;margin:0\}/);
  assert.match(controller, /letter-image-placeholder\{display:none!important\}/);
  assert.match(controller, /max-height:100mm!important/);
  assert.match(controller, /max-width:84%/);
  assert.match(controller, /<footer class="pdf-closing">/);
  assert.match(controller, /pdf-closing\{[^}]*break-inside:avoid-page;page-break-inside:avoid/);
  assert.match(controller, /pdf-letter \+ \.pdf-letter\{break-before:page;page-break-before:always/);
  assert.match(controller, /pdf-body\{[^}]*break-after:avoid-page;page-break-after:avoid/);
  assert.doesNotMatch(controller, /Cargando imagen…/);
});

test('los borradores locales cuentan con una acción de descarte accesible', async () => {
  const view = await read('../assets/js/views/correspondence-view.js');
  const clicks = await read('../assets/js/controllers/app-click-handler.js');
  const draft = await read('../assets/js/controllers/draft-controller.js');
  assert.match(view, /data-action="discard-local-draft"/);
  assert.match(clicks, /case 'discard-local-draft': await this\.discardLocalDraft/);
  assert.match(draft, /async discardLocalDraft\(/);
  assert.match(draft, /deleteLocalDraftStrict\(key\)/);
  assert.match(draft, /discardedLocalDraftKeys\.add\(key\)/);
  assert.match(draft, /draftSyncQueue\.enqueue\(this\.draftSyncQueueKey\(\)/);
});

test('la acción masiva está en Papelera y procesa todas sus páginas sin afectar Borradores', async () => {
  const view = await read('../assets/js/views/correspondence-view.js');
  const clicks = await read('../assets/js/controllers/app-click-handler.js');
  const draft = await read('../assets/js/controllers/draft-controller.js');
  assert.match(view, /state\.route === 'trash'[\s\S]*?data-action=\"delete-all-trash\"/);
  assert.match(view, /: '<button class=\"btn btn-primary\" data-route=\"write\">/);
  assert.doesNotMatch(view, /data-action=\"delete-all-drafts\"/);
  assert.match(clicks, /case 'delete-all-trash'/);
  assert.match(clicks, /title: 'Eliminar todo de la Papelera'/);
  assert.match(clicks, /if \(this\._bulkPurgingTrash\) break;/);
  assert.match(draft, /async deleteAllTrash\(\)/);
  assert.match(draft, /repository\.list\('trash', '', cursor, 100\)/);
  assert.match(draft, /repository\.purge\(id\)/);
  assert.match(draft, /pending_other_participant/);
  assert.match(draft, /already_confirmed_waiting/);
  assert.doesNotMatch(draft.slice(draft.indexOf('async deleteAllTrash'), draft.indexOf('async discardLetter')), /repository\.list\('drafts'/);
});

test('el vaciado masivo conserva en Papelera los elementos cuya purga no fue confirmada', async () => {
  const draft = await read('../assets/js/controllers/draft-controller.js');
  const bulk = draft.slice(draft.indexOf('async deleteAllTrash'), draft.indexOf('async discardLetter'));
  assert.match(bulk, /failedIds\.add\(id\)/);
  assert.match(bulk, /pendingIds\.add\(id\)/);
  assert.match(bulk, /this\.state\.letters = \(this\.state\.letters \|\| \[\]\)\.filter\(row => String\(row\.id\) !== id\)/);
  assert.match(bulk, /this\.openRoute\('trash'/);
  assert.match(bulk, /no se pudieron procesar/i);
  assert.doesNotMatch(bulk, /deleteLocalDraft|discardedLocalDraftKeys/);
});
