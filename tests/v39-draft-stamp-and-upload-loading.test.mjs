import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = path => readFile(new URL(path, import.meta.url), 'utf8');

const draftId = '11111111-1111-4111-8111-111111111111';
const ownerId = '22222222-2222-4222-8222-222222222222';
const mediaId = '33333333-3333-4333-8333-333333333333';
const mediaPath = `letters/${draftId}/${ownerId}/${mediaId}.webp`;

test('los borradores muestran miniatura pendiente aunque la API todavía no entregue firstImageUrl', async () => {
  const { AppView } = await import('../assets/js/views/app-view.js');
  const view = new AppView({});
  const markup = view.letterCard({
    id: draftId,
    letterId: draftId,
    sender_id: ownerId,
    status: 'draft',
    title: 'Carta con fotografía',
    body: `<p>Un recuerdo especial</p><img data-image-path="${mediaPath}" alt="Imagen adjunta">`
  });
  assert.match(markup, /letter-stamp has-image is-loading is-pending-source/);
  assert.ok(markup.includes(`data-letter-id="${draftId}"`));
  assert.ok(markup.includes(`data-image-path="${mediaPath}"`));
  assert.doesNotMatch(markup, /<div class="letter-stamp"[^>]*>✎<\/div>/);
});

test('las miniaturas pendientes se firman mediante el endpoint autenticado y se validan por origen', async () => {
  const events = await read('../assets/js/controllers/app-event-coordinator-controller.js');
  const repository = await read('../assets/js/repositories/letter-repository.js');
  const api = await read('../supabase/functions/letters-api/index.ts');
  assert.match(events, /this\.repository\.signLetterThumbnail\(payload\)/);
  assert.match(events, /url\.origin !== expectedOrigin/);
  assert.match(events, /url\.pathname\.startsWith\('\/storage\/v1\/render\/image\/sign\/private-media\/'\)/);
  assert.match(events, /rootMargin: '120px 0px'/);
  assert.match(events, /this\.letterStampPreviewQueue\.splice\(0, 4\)/);
  assert.match(repository, /signLetterThumbnail\(data\) \{ return this\.api\.letters\('media:sign-letter-thumbnail', data\); \}/);
  assert.match(api, /case 'media:sign-letter-thumbnail':/);
});

test('la hidratación de miniaturas se ejecuta al renderizar listas y shell', async () => {
  const navigation = await read('../assets/js/controllers/navigation-controller.js');
  assert.match(navigation, /this\.hydrateLetterStampPreviews\?\.\(\)/);
  assert.match(navigation, /container\.innerHTML = this\.view\.renderListResults\(this\.state\);[\s\S]*?this\.hydrateLetterStampPreviews/);
});

test('al seleccionar una imagen, el placeholder Cargando imagen se inserta antes de procesar/subir', async () => {
  const draft = await read('../assets/js/controllers/draft-controller.js');
  const add = draft.slice(draft.indexOf('async addLetterImage(file)'), draft.indexOf('async saveDraft('));
  assert.ok(add.indexOf('placeholder.innerHTML') < add.indexOf('prepareImageFile'));
  assert.ok(add.indexOf('insertionRange.insertNode(placeholder)') < add.indexOf('prepareImageFile'));
  assert.match(add, /letter-image-placeholder-label">Cargando imagen…/);
  assert.match(add, /placeholder\.replaceWith\(image\)/);
  assert.match(add, /image\.className = 'letter-editor-image is-loading'/);
});

test('el placeholder temporal de carga nunca se guarda como texto en el contenido de la carta', async () => {
  const dom = await read('../assets/js/utils/dom.js');
  const draft = await read('../assets/js/controllers/draft-controller.js');
  assert.match(dom, /node\.hasAttribute\?\.\('data-letter-image-uploading'\)/);
  assert.match(draft, /data-letter-image-uploading/);
});

test('el placeholder del editor comparte la animación y el mensaje de carga de lectura', async () => {
  const css = await read('../assets/css/correspondence.css');
  assert.match(css, /\.letter-editor \.letter-image-upload-placeholder/);
  assert.match(css, /\.letter-image-upload-placeholder::after[\s\S]*letter-image-shimmer/);
  assert.match(css, /\.letter-image-upload-placeholder \.letter-image-placeholder-label/);
});
