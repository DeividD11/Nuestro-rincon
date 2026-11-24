import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = path => readFile(new URL(path, import.meta.url), 'utf8');

test('el sanitizador del backend conserva solo el path interno de imágenes privadas', async () => {
  const core = await read('../supabase/functions/_shared/core.ts');
  const sanitizer = core.slice(core.indexOf('export function sanitizeRichHtml'), core.indexOf('export function publicUser'));
  assert.match(sanitizer, /if \(tag === 'IMG'\)/);
  assert.ok(sanitizer.includes("/^letters\\/[0-9a-f-]{36}\\/[0-9a-f-]{36}\\/[0-9a-f-]{36}\\.(?:jpg|jpeg|png|webp)$/i.test(path)"));
  assert.ok(sanitizer.includes('data-image-path="${encode(path)}"'));
  assert.doesNotMatch(sanitizer, /node\.getAttribute\?\.\('src'\)/);
  assert.match(sanitizer, /encode\('Imagen adjunta'\)/);
  const clientSanitizer = await read('../assets/js/utils/dom.js');
  const draft = await read('../assets/js/controllers/draft-controller.js');
  assert.match(clientSanitizer, /const alt = 'Imagen adjunta'/);
  assert.match(draft, /image\.alt = 'Imagen adjunta'/);
});

test('el backend valida la pertenencia de las imágenes y no acepta adjuntos antes de crear el borrador', async () => {
  const api = await read('../supabase/functions/letters-api/index.ts');
  const create = api.slice(api.indexOf("case 'draft:create':"), api.indexOf("case 'draft:save':"));
  const save = api.slice(api.indexOf("case 'draft:save':"), api.indexOf("case 'draft:send':"));
  assert.match(create, /letterImagePaths\(html\)\.length\) throw new Error\('LETTER_IMAGE_PATH_INVALID'\)/);
  assert.match(save, /validateLetterImages\(html, String\(letter\.id\), userId\)/);
  assert.match(api, /case 'media:sign-letter-thumbnail':/);
  assert.match(api, /createPrivateThumbnailUrl\(path, 86400\)/);
  assert.match(api, /const items = decorated;/);
  assert.doesNotMatch(api, /withFirstImagePreviews/);
});

test('el papel de lectura y el editor ocultan el filename y muestran estados de carga', async () => {
  const helpers = await read('../assets/js/utils/letter-images.js');
  const events = await read('../assets/js/controllers/app-event-coordinator-controller.js');
  const css = await read('../assets/css/correspondence.css');
  assert.match(helpers, /export function renderLetterBodyHtml\(/);
  assert.match(helpers, /image\.setAttribute\('alt', ''\)/);
  assert.match(helpers, /letter-image-placeholder-label/);
  assert.match(helpers, /export function renderEditorBodyHtml\(/);
  assert.match(helpers, /image\.classList\.add\('letter-editor-image', 'is-loading'\)/);
  assert.match(helpers, /image\.setAttribute\('alt', ''\)/);
  assert.match(css, /letter-editor img\.letter-editor-image\.is-loading[\s\S]*color: transparent/);
  assert.match(events, /letterImageFrame\.classList\.remove\('is-loading'\)/);
  assert.match(events, /label\.textContent = 'Imagen no disponible'/);
  assert.match(events, /image\.classList\.remove\('is-loading', 'is-error'\)/);
  assert.match(css, /\.letter-image-frame\.is-loading \.letter-image-placeholder/);
  assert.match(css, /\.letter-editor img\.letter-editor-image\.is-loading/);
});

test('el letter-stamp muestra el fallback mientras carga y la primera miniatura firmada después', async () => {
  const view = await read('../assets/js/views/correspondence-view.js');
  const events = await read('../assets/js/controllers/app-event-coordinator-controller.js');
  const css = await read('../assets/css/correspondence.css');
  assert.match(view, /const source = String\(item\?\.firstImageUrl \|\| ''\)/);
  assert.match(view, /letter-stamp has-image is-loading/);
  assert.match(view, /letter-stamp-fallback/);
  assert.match(view, /loading="lazy" decoding="async" fetchpriority="low"/);
  assert.match(events, /letter-stamp\.has-image\.is-loading/);
  assert.match(css, /\.letter-stamp\.has-image\.is-loading \.letter-stamp-fallback/);
});

test('letter-paper limita la longitud de línea, mejora la jerarquía y no recorta el contenido', async () => {
  const css = await read('../assets/css/correspondence.css');
  assert.match(css, /\.letter-paper \.letter-body\s*\{[\s\S]*max-width: 68ch/);
  assert.match(css, /font: 400 clamp\(16px, 1\.12rem, 18px\)\/1\.92/);
  assert.match(css, /\.letter-paper-inner \{ position: relative; z-index: 1/);
  assert.match(css, /\.letter-paper \{[\s\S]*overflow: visible/);
  assert.match(css, /@media \(max-width: 720px\)[\s\S]*\.letter-paper \.letter-body/);
});
