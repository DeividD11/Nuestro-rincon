import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = path => readFile(new URL(path, import.meta.url), 'utf8');

test('letter-stamp usa un placeholder animado como avatar-preview y no bloquea la lista con imágenes grandes', async () => {
  const view = await read('../assets/js/views/correspondence-view.js');
  const css = await read('../assets/css/correspondence.css');
  assert.match(view, /letter-stamp-fallback-mark/);
  assert.match(view, /width="96" height="96" loading="lazy" decoding="async" fetchpriority="low"/);
  assert.match(css, /\.letter-stamp\.has-image\.is-loading \.letter-stamp-fallback::before/);
  assert.match(css, /avatar-preview-shimmer 1\.25s ease-in-out infinite/);
  assert.match(css, /letter-stamp-spin \.8s linear infinite/);
  assert.match(css, /prefers-reduced-motion:\s*reduce/);
});

test('las miniaturas privadas usan transformaciones pequeñas con degradación segura a la imagen original', async () => {
  const storage = await read('../supabase/functions/_shared/storage.ts');
  const api = await read('../supabase/functions/letters-api/index.ts');
  const repo = await read('../assets/js/repositories/letter-repository.js');
  const events = await read('../assets/js/controllers/app-event-coordinator-controller.js');
  assert.match(storage, /width: 96, height: 96, resize: 'cover', quality: 72/);
  assert.match(storage, /MEDIA_IMAGE_TRANSFORM_UNAVAILABLE/);
  assert.match(storage, /privateImageTransformsAvailable = false/);
  assert.match(storage, /return createPrivateReadUrl\(path, expiresIn\)/);
  assert.match(api, /createPrivateThumbnailUrl\(path, 86400\)/);
  assert.match(api, /case 'media:sign-letter-thumbnail':/);
  assert.match(api, /const letter = await checkedLetter\(String\(body\.letterId \\|\| ''\), userId\)/);
  assert.match(api, /body\.optimized === false[\s\S]*createPrivateReadUrl\(path, 86400\)/);
  assert.match(repo, /signLetterThumbnail\(data\) \{ return this\.api\.letters\('media:sign-letter-thumbnail', data\); \}/);
  assert.match(events, /this\.repository\.signLetterThumbnail\(payload\)/);
  assert.match(events, /this\.repository\.signLetterImage\(payload\)/);
  assert.match(events, /storage\/v1\/render\/image\/sign\/private-media/);
});

test('el sello solo termina el estado de carga después de decodificar la miniatura', async () => {
  const events = await read('../assets/js/controllers/app-event-coordinator-controller.js');
  assert.match(events, /image\.decode\(\)\.then\(revealStampImage\)/);
  assert.match(events, /fallbackLetterStampImage\(image, stamp\)/);
  assert.match(events, /optimized: false/);
  assert.match(events, /stamp\.classList\.remove\('is-loading', 'is-pending-source'\)/);
  assert.match(events, /image\.fetchPriority = 'low'/);
  assert.match(events, /image\.loading = 'lazy'/);
});


test('el HTML de las tarjetas conserva la ruta de la primera imagen para el fallback optimizado', async () => {
  const { AppView } = await import('../assets/js/views/app-view.js');
  const view = new AppView({});
  const letterId = '11111111-1111-4111-8111-111111111111';
  const ownerId = '22222222-2222-4222-8222-222222222222';
  const mediaId = '33333333-3333-4333-8333-333333333333';
  const path = `letters/${letterId}/${ownerId}/${mediaId}.webp`;
  const transformedUrl = `https://tiqbmuubpbmxqvtkcdhq.supabase.co/storage/v1/render/image/sign/private-media/${path}?token=preview`;
  const markup = view.letterCard({
    id: letterId, sender_id: ownerId, status: 'draft', title: 'Recuerdo',
    firstImageUrl: transformedUrl,
    body: `<p>Un recuerdo</p><img data-image-path="${path}" alt="Imagen adjunta">`
  });
  assert.ok(markup.includes(transformedUrl));
  assert.ok(markup.includes(`data-letter-id="${letterId}"`));
  assert.ok(markup.includes(`data-image-path="${path}"`));
});
