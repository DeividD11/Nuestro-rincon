import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = path => readFile(new URL(path, import.meta.url), 'utf8');

test('guardar una respuesta como borrador conserva el cuerpo local, la separa del editor nuevo y lleva a Borradores', async () => {
  const click = await read('../assets/js/controllers/app-click-handler.js');
  const navigation = await read('../assets/js/controllers/navigation-controller.js');
  const draft = await read('../assets/js/controllers/draft-controller.js');
  const letter = await read('../assets/js/controllers/letter-controller.js');
  const view = await read('../assets/js/views/correspondence-view.js');
  assert.match(click, /case 'save-draft':[\s\S]*?\['saved', 'created', 'local'\][\s\S]*?openRoute\('drafts'/);
  assert.match(draft, /if \(editor\.parentLetterId\)[\s\S]*?putLocalDraft\(\{ key: storageKey, \.\.\.this\.state\.editor \}\)/);
  assert.match(draft, /loadLocalReplyDrafts\(\)/);
  assert.match(draft, /item\.editingSent !== true/);
  assert.match(navigation, /const replySnapshot = \{ \.\.\.snapshot, key: storageKey/);
  assert.match(navigation, /putLocalDraft\(replySnapshot\)\.then\(\(\) => this\.loadLocalReplyDrafts/);
  assert.match(navigation, /this\.localDraftKey = this\.localDraftKeyFor\(`new:\$\{crypto\.randomUUID\(\)\}`\)/);
  assert.match(navigation, /body: '',[\s\S]*?parentLetterId: null/);
  assert.match(letter, /this\.localDraftKey = this\.localDraftKeyFor\(`reply:\$\{letterId\}:\$\{crypto\.randomUUID\(\)\}`\)/);
  assert.match(view, /state\.localReplyDrafts/);
  assert.match(view, /localReplyDrafts/);
  assert.match(view, /data-action=\"edit-local-draft\"/);
});

test('la vista de Borradores permite reanudar la respuesta local desde su propia clave', async () => {
  const view = await read('../assets/js/views/correspondence-view.js');
  const letter = await read('../assets/js/controllers/letter-controller.js');
  const click = await read('../assets/js/controllers/app-click-handler.js');
  assert.match(view, /data-action="edit-local-draft" data-local-draft-key=/);
  assert.match(click, /case 'edit-local-draft': await this\.editLocalDraft/);
  assert.match(letter, /async editLocalDraft\(storageKey = ''\)/);
  assert.match(letter, /parentLetterId: draft\.parentLetterId \|\| null/);
});

test('el PDF reúne todas las páginas del hilo y renderiza el cuerpo completo con sus imágenes', async () => {
  const letter = await read('../assets/js/controllers/letter-controller.js');
  const html = await read('../assets/js/utils/letter-images.js');
  const styles = await read('../assets/css/app.css');
  assert.match(letter, /while \(hasMore\)/);
  assert.match(letter, /repository\.get\(letterId, cursor, 100\)/);
  assert.match(letter, /renderLetterBodyHtml\(item\.body \|\| '', \{ eagerImages: true, showPlaceholder: false \}\)/);
  assert.match(letter, /image\.loading = 'eager'/);
  assert.match(letter, /await image\.decode\(\)/);
  assert.match(letter, /window\.print\(\)/);
  assert.match(html, /img\[data-image-path\]/);
  assert.match(styles, /#letter-pdf-print-root/);
  assert.match(letter, /pdf-letter \+ \.pdf-letter\{break-before:page;page-break-before:always/);
  assert.match(letter, /position:fixed;left:-400mm/);
  assert.match(letter, /@page\{size:A4;margin:0\}/);
  assert.match(letter, /max-height:100mm!important/);
  assert.match(letter, /pdf-closing[\s\S]*?page-break-inside:avoid/);
  assert.match(letter, /repository\.get\(letterId, null, 100\)/);
  assert.match(letter, /No se pudo cargar una imagen adjunta/);
});

test('los elementos de conversación usan extractos de texto y no despliegan los adjuntos en la página', async () => {
  const view = await read('../assets/js/views/correspondence-view.js');
  const css = await read('../assets/css/correspondence.css');
  const threadRenderer = view.slice(view.indexOf('const renderThreadItem'), view.indexOf('const threadBoundary'));
  assert.match(threadRenderer, /plainTextFromHtml\(originalBody\)/);
  assert.match(threadRenderer, /excerpt\.slice\(0, 220\)/);
  assert.match(threadRenderer, /Incluye imagen adjunta/);
  assert.doesNotMatch(threadRenderer, /renderLetterBodyHtml|<img src=/);
  assert.match(css, /\.conversation-preview-text\{[^}]*-webkit-line-clamp:4/);
});

test('los sellos detectan la primera imagen y firman una miniatura privada al hidratar las listas', async () => {
  const view = await read('../assets/js/views/correspondence-view.js');
  const events = await read('../assets/js/controllers/app-event-coordinator-controller.js');
  assert.match(view, /firstImagePathFromBody\(item\?\.body/);
  assert.match(view, /data-image-path=/);
  assert.match(events, /hydrateLetterStampPreviews\(\)/);
  assert.match(events, /signLetterThumbnail\(payload\)/);
  assert.match(events, /private-media/);
});

test('el cierre de sesión y la eliminación de cuenta muestran confirmación después de completar la operación', async () => {
  const clicks = await read('../assets/js/controllers/app-click-handler.js');
  const submit = await read('../assets/js/controllers/app-submit-handler.js');
  const auth = await read('../assets/js/views/auth-view.js');
  assert.match(clicks, /await this\.session\.logout\(\)[\s\S]*renderLogin\('', 'Has cerrado sesión correctamente/);
  assert.match(submit, /if \(!result\.deleted\)[\s\S]*renderLogin\('', 'Tu cuenta se eliminó correctamente/);
  assert.match(auth, /auth-success-notice[^>]*role="status"/);
});

test('las cartas y respuestas enviadas pueden editarse solo por su remitente y con control de revisión', async () => {
  const letter = await read('../assets/js/controllers/letter-controller.js');
  const repo = await read('../assets/js/repositories/letter-repository.js');
  const api = await read('../supabase/functions/letters-api/index.ts');
  const migration = await read('../supabase/migrations/20261127090000_edit_sent_letter_content.sql');
  const clicks = await read('../assets/js/controllers/app-click-handler.js');
  assert.match(letter, /async startEditSentLetter\(letterId\)/);
  assert.match(letter, /String\(letter\.sender_id\) !== String\(this\.session\?\.user\?\.id\)/);
  assert.match(letter, /expectedRevision: Number\(editor\.revision/);
  assert.match(letter, /result\?\.status === 'conflict'/);
  assert.match(repo, /editSent\(data\) \{ return this\.api\.letters\('letter:edit', data\); \}/);
  assert.match(api, /case 'letter:edit'/);
  assert.match(api, /letter\.sender_id !== userId/);
  assert.match(migration, /insert into public\.letter_versions/);
  assert.match(migration, /p_expected_revision/);
  assert.match(migration, /grant execute on function public\.edit_sent_letter_content[\s\S]*to service_role/);
  assert.match(clicks, /case 'edit-sent-letter': await this\.startEditSentLetter/);
  assert.match(clicks, /case 'save-sent-edits': await this\.saveSentLetterEdits/);
});

test('los párrafos del hilo tienen primer plano claro explícito en tema oscuro', async () => {
  const css = await read('../assets/css/correspondence.css');
  assert.match(css, /html\[data-theme="dark"\] \.conversation-list \.letter-body,\s*html\[data-theme="dark"\] \.conversation-list \.letter-body p/);
  assert.match(css, /color:#f0eae5!important;background-color:transparent!important/);
});

test('el enlace de salto y los controles de descarga TXT/HTML no aparecen en la interfaz', async () => {
  const view = await read('../assets/js/views/app-view.js');
  const styles = await read('../assets/css/accessibility.css');
  const correspondence = await read('../assets/js/views/correspondence-view.js');
  assert.doesNotMatch(view, /skip-link|Saltar al contenido principal/i);
  assert.doesNotMatch(styles, /skip-link/);
  assert.doesNotMatch(correspondence, /data-action="download-(?:txt|html)"/);
  assert.match(correspondence, /data-action="print-letter"/);
});

import { LetterController } from '../assets/js/controllers/letter-controller.js';

function withHistory(run) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'history');
  Object.defineProperty(globalThis, 'history', {
    configurable: true,
    value: { replaceState: (_state, _title, url) => { globalThis.__nrLastHistoryUrl = url; } }
  });
  return Promise.resolve().then(run).finally(() => {
    delete globalThis.__nrLastHistoryUrl;
    if (previous) Object.defineProperty(globalThis, 'history', previous);
    else delete globalThis.history;
  });
}

test('Responder siempre crea una respuesta vacía y nueva, incluso cuando la carta no tiene título', async () => {
  await withHistory(async () => {
    const received = [];
    const controller = Object.assign(Object.create(LetterController.prototype), {
      repository: { get: async id => ({ letter: { id, title: received.length ? '' : 'Carta de prueba' } }) },
      state: { route: 'letter' },
      localDraftKeyFor: key => `user-1:${key}`,
      render() { received.push({ ...this.state.editor, localDraftKey: this.localDraftKey }); }
    });
    await controller.startReply('parent-1');
    await controller.startReply('parent-1');
    assert.equal(received[0].title, 'Re: Carta de prueba');
    assert.equal(received[1].title, 'Re: Tu carta');
    assert.equal(received[0].body, '');
    assert.equal(received[1].body, '');
    assert.notEqual(received[0].creationRequestId, received[1].creationRequestId);
    assert.notEqual(received[0].localDraftKey, received[1].localDraftKey);
    assert.equal(globalThis.__nrLastHistoryUrl, '#/write');
  });
});

test('el editor rechaza la edición de mensajes que no están enviados por la cuenta actual', async () => {
  const controller = Object.assign(Object.create(LetterController.prototype), {
    repository: { get: async id => ({ letter: id === 'draft' ? { status: 'draft', sender_id: 'user-1' } : { status: 'sent', sender_id: 'user-2' } }) },
    session: { user: { id: 'user-1' } },
    state: { route: 'sent' }
  });
  await assert.rejects(controller.startEditSentLetter('draft'), /Solo puedes editar/);
  await assert.rejects(controller.startEditSentLetter('someone-elses'), /Solo puedes editar/);
  await assert.rejects(controller.startEditSentLetter(''), /No se identificó/);
});

test('la caché del hilo ignora cargas vacías, usa identidad invitada y limita su tamaño', () => {
  const cache = new Map();
  const controller = Object.assign(Object.create(LetterController.prototype), {
    letterThreadCache: cache,
    session: null
  });
  controller.cacheLetterThread({ letter: { thread_id: null }, thread: [] });
  controller.cacheLetterThread({ letter: { thread_id: 'empty' }, thread: [] });
  controller.cacheLetterThread({ letter: { thread_id: 'not-array' }, thread: {} });
  assert.equal(cache.size, 0);
  controller.cacheLetterThread({ letter: { thread_id: 'thread-1' }, thread: [{ id: 'a' }] });
  assert.deepEqual(cache.get('guest:thread-1'), [{ id: 'a' }]);
  for (let index = 0; index < 21; index++) {
    controller.cacheLetterThread({ letter: { thread_id: `thread-${index + 2}` }, thread: [{ id: String(index) }] });
  }
  assert.equal(cache.size, 20);
  assert.equal(cache.has('guest:thread-1'), false);
});

test('los cambios optimistas actualizan el hilo activo y permiten retirar cartas de una lista', () => {
  const controller = Object.assign(Object.create(LetterController.prototype), {
    state: {
      letters: [{ id: 'letter-1', title: 'Anterior' }, { id: 'letter-2', title: 'Otra' }],
      selectedLetter: {
        letter: { id: 'letter-1', title: 'Anterior' },
        thread: [{ id: 'letter-1', title: 'Anterior' }, { id: 'reply-1', title: 'Respuesta' }]
      }
    }
  });
  controller.patchLetterState('letter-1', { title: 'Editada' }, { removeFromList: true });
  assert.deepEqual(controller.state.letters, [{ id: 'letter-2', title: 'Otra' }]);
  assert.equal(controller.state.selectedLetter.letter.title, 'Editada');
  assert.equal(controller.state.selectedLetter.thread[0].title, 'Editada');

  controller.state.selectedLetter = {
    letter: { id: 'letter-2' },
    thread: [{ id: 'reply-1', title: 'Vieja' }]
  };
  controller.patchLetterState('reply-1', { title: 'Respuesta actualizada' });
  assert.equal(controller.state.selectedLetter.thread[0].title, 'Respuesta actualizada');
  controller.state.selectedLetter = null;
  controller.patchLetterState('unknown', { title: 'Sin destino' });
  assert.equal(controller.state.selectedLetter, null);
});

test('guardar una edición exige una carta en modo edición y contenido dentro del límite', async () => {
  const descriptors = ['DOMParser', 'Node', 'document'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]);
  class FakeNode {
    constructor(value = '') { this.nodeType = 3; this.nodeValue = value; this.children = []; }
    append(child) { this.children.push(child); }
    get innerHTML() { return this.children.map(child => child.nodeValue || child.innerHTML || '').join(''); }
  }
  class FakeDOMParser {
    parseFromString(input) {
      const value = String(input).replace(/<[^>]*>/g, '');
      const body = new FakeNode();
      body.childNodes = value ? [new FakeNode(value)] : [];
      body.textContent = value;
      return { body, createTextNode: value => new FakeNode(value), createDocumentFragment: () => new FakeNode(), createElement: () => new FakeNode() };
    }
  }
  Object.defineProperties(globalThis, {
    DOMParser: { configurable: true, value: FakeDOMParser },
    Node: { configurable: true, value: { TEXT_NODE: 3, ELEMENT_NODE: 1 } },
    document: { configurable: true, value: {
      createTextNode: value => new FakeNode(value),
      createDocumentFragment: () => new FakeNode(),
      createElement: () => new FakeNode()
    } }
  });
  try {
    const controller = Object.assign(Object.create(LetterController.prototype), {
      state: { editor: null },
      readEditorFromDom: () => ({ title: 'Título', body: '' })
    });
    await assert.rejects(controller.saveSentLetterEdits(), /No hay una carta enviada en edición/);

    controller.state.editor = { letterId: 'letter-1', editingSent: true, body: '' };
    await assert.rejects(controller.saveSentLetterEdits(), /no puede quedar vacío/);

    controller.readEditorFromDom = () => ({ title: 'Título', body: `<p>${'x'.repeat(100001)}</p>` });
    await assert.rejects(controller.saveSentLetterEdits(), /supera el límite/);
    assert.equal(controller.state.editor.letterId, 'letter-1');
  } finally {
    for (const [key, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  }
});

test('el nombre de archivo también usa el fallback al recibir un valor ausente', () => {
  const controller = Object.create(LetterController.prototype);
  assert.equal(controller.fileName(null), 'carta');
  assert.equal(controller.fileName(undefined), 'carta');
});

test('el remitente puede abrir una carta enviada o respuesta propia en modo de edición', async () => {
  await withHistory(async () => {
    const controller = Object.assign(Object.create(LetterController.prototype), {
      repository: { get: async id => ({ letter: {
        id, status: 'sent', sender_id: 'user-1', title: 'Carta original', body: '<p>Texto</p>',
        revision: 4, reply_to_letter_id: 'parent-1', updated_at: '2026-11-25T10:00:00.000Z'
      } }) },
      session: { user: { id: 'user-1' } },
      state: { route: 'sent' },
      routeRequestId: 0,
      localDraftKeyFor: key => `user-1:${key}`,
      root: { querySelector: () => null },
      render() { this.didRender = true; }
    });
    await controller.startEditSentLetter('reply-1');
    assert.equal(controller.state.route, 'write');
    assert.equal(controller.state.editor.editingSent, true);
    assert.equal(controller.state.editor.parentLetterId, 'parent-1');
    assert.equal(controller.state.editor.revision, 4);
    assert.equal(controller.didRender, true);
    assert.equal(globalThis.__nrLastHistoryUrl, '#/write');
  });
});


test('v49 las imágenes se descargan del viewport y se restauran al volver, sin efectos de movimiento', async () => {
  const events = await read('../assets/js/controllers/app-event-coordinator-controller.js');
  const css = await read('../assets/css/correspondence.css');
  assert.match(events, /letterStampPreviewObserver = new IntersectionObserver/);
  assert.match(events, /stamp\.dataset\.suspendedSrc = source/);
  assert.match(events, /image\.dataset\.suspendedSrc = source/);
  assert.match(events, /image\.src = suspended/);
  assert.match(css, /v49: imágenes estáticas/);
  const releaseOverrides = css.slice(css.indexOf('v49: imágenes estáticas'));
  assert.match(releaseOverrides, /animation:\s*none !important/);
  assert.match(releaseOverrides, /transition:\s*none !important/);
  assert.match(releaseOverrides, /transform:\s*none !important/);
});

test('v49 retirar una creación enviada del autor la devuelve a Borradores y la purga del autor no exige segunda confirmación', async () => {
  const draft = await read('../assets/js/controllers/draft-controller.js');
  const edge = await read('../supabase/functions/letters-api/index.ts');
  const migration = await read('../supabase/migrations/20261128030000_withdraw_sent_letters_and_owner_purge.sql');
  assert.match(draft, /withdrawToDraft[\s\S]*repository\.moveToTrash\(letterId\)/);
  assert.match(draft, /'withdrawn', 'already_draft'/);
  assert.match(draft, /openRoute\('drafts', true, \{ focus: true, skipHistory: true \}\)/);
  assert.match(edge, /rpc\('withdraw_sent_letter_to_draft'/);
  assert.match(edge, /letter\.sender_id === userId && !ownState\?\.trashed_at/);
  assert.match(migration, /create or replace function public\.withdraw_sent_letter_to_draft/);
  assert.match(migration, /p_user_id = v_letter\.sender_id/);
  assert.match(migration, /scope', 'owner_only'/);
});

test('v49 adjuntar imágenes al editar un mensaje enviado autoriza solo al remitente y valida la ruta del hilo', async () => {
  const api = await read('../supabase/functions/letters-api/index.ts');
  const prepare = api.slice(api.indexOf("case 'media:prepare-upload':"), api.indexOf("case 'media:sign-letter-image':"));
  const sign = api.slice(api.indexOf("case 'media:sign-letter-image':"), api.indexOf("case 'media:sign-letter-thumbnail':"));
  assert.match(prepare, /canEditOwnSentMessage = letter\.status === 'sent' && letter\.sender_id === userId/);
  assert.match(prepare, /reply_to_letter_id \|\| letter\.id/);
  assert.match(sign, /canEditOwnSentMessage = base\.status === 'sent' && base\.sender_id === userId/);
  assert.match(sign, /match\[1\] !== expectedBaseId/);
});

test('v49 los botones Volver y Cancelar restauran la vista anterior y su contexto', async () => {
  const nav = await read('../assets/js/controllers/navigation-controller.js');
  const click = await read('../assets/js/controllers/app-click-handler.js');
  assert.match(nav, /rememberCurrentPage\(route = this\.state\.route\)/);
  assert.match(nav, /navigationHistory\.push\(entry\)/);
  assert.match(nav, /async navigateBack\(fallbackRoute = null\)/);
  assert.match(nav, /entry\.scrollY/);
  assert.match(nav, /entry\.search/);
  assert.match(click, /case 'back-to-list': await this\.navigateBack/);
  assert.match(click, /case 'cancel-editor': await this\.navigateBack/);
});
