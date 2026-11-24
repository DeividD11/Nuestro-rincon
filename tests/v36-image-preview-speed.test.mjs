import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = path => readFile(new URL(path, import.meta.url), 'utf8');

test('la vista de avatar evita el texto alternativo visible y ofrece un placeholder mientras carga', async () => {
  const view = await read('../assets/js/views/settings-view.js');
  const controller = await read('../assets/js/controllers/settings-controller.js');
  const css = await read('../assets/css/app.css');
  const events = await read('../assets/js/controllers/app-event-coordinator-controller.js');
  assert.match(view, /class="profile-avatar-preview \$\{avatarPreviewUrl \? 'has-image is-loading'/);
  assert.match(view, /avatar-preview-placeholder/);
  assert.match(view, /alt="" loading="eager" decoding="async" fetchpriority="high"/);
  assert.doesNotMatch(view, /alt="Avatar de/);
  assert.match(controller, /image\.fetchPriority = 'high'/);
  assert.match(css, /\.profile-avatar-preview\.is-loading::before/);
  assert.match(css, /avatar-preview-shimmer/);
  assert.match(events, /avatarContainer\.classList\.remove\('has-image', 'is-loading'\)/);
  assert.match(events, /profile-avatar-preview\.has-image\.is-loading/);
});

test('avatar e imágenes de carta se reducen antes de solicitar una URL de carga', async () => {
  const settings = await read('../assets/js/controllers/settings-controller.js');
  const drafts = await read('../assets/js/controllers/draft-controller.js');
  const processor = await read('../assets/js/services/image-processing.js');
  assert.match(settings, /prepareImageFile\(file, \{ maxDimension: 512, maxBytes: 512 \* 1024 \}\)/);
  assert.match(drafts, /prepareImageFile\(file, \{ maxDimension: 1600, maxBytes: 3 \* 1024 \* 1024 \}\)/);
  assert.match(processor, /const firstScale = effectiveMaxDimension \/ sourceMaxDimension/);
  assert.match(processor, /let candidate = await encode\('image\/webp', 0\.84\)/);
  assert.match(processor, /decoded\.close\?\.\(\)/);
});

test('las cartas reciben una URL firmada solo para la primera imagen privada insertada', async () => {
  const api = await read('../supabase/functions/letters-api/index.ts');
  const view = await read('../assets/js/views/correspondence-view.js');
  assert.match(api, /case 'media:sign-letter-thumbnail':/);
  assert.match(api, /createPrivateThumbnailUrl\(path, 86400\)/);
  assert.match(api, /const items = decorated;/);
  assert.doesNotMatch(api, /withFirstImagePreviews/);
  assert.match(view, /firstImagePathFromBody/);
  assert.match(view, /item\?\.firstImageUrl/);
  assert.match(view, /letter-stamp has-image/);
  assert.match(view, /loading="lazy" decoding="async" fetchpriority="low"/);
  assert.match(view, /url\.pathname\.startsWith\('\/storage\/v1\/render\/image\/sign\/private-media\/'\)/);
});

test('si una miniatura o avatar falla, se retira la imagen rota y queda el fallback', async () => {
  const events = await read('../assets/js/controllers/app-event-coordinator-controller.js');
  const view = await read('../assets/js/views/correspondence-view.js');
  assert.match(events, /image\.closest\('\.letter-stamp\.has-image'\)/);
  assert.match(events, /stamp\.classList\.remove\('has-image', 'is-loading', 'is-pending-source'\)/);
  assert.match(view, /letter-stamp-fallback/);
});
