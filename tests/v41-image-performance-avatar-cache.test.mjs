import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { AvatarNodeCache } from '../assets/js/views/avatar-node-cache.js';

const read = path => readFile(new URL(path, import.meta.url), 'utf8');

function makeNode(selector, root, withImage = false) {
  return {
    selector,
    querySelector(query) { return query === 'img' && withImage ? {} : null; },
    replaceWith(next) {
      if (selector === '.user-mini .avatar') root.sidebar = next;
      if (selector === '.profile-avatar-preview') root.preview = next;
    }
  };
}

test('AvatarNodeCache conserva los mismos nodos de sidebar y Configuración cuando la ruta cambia', () => {
  const root = { sidebar: null, preview: null, querySelector(selector) { return selector.includes('.user-mini') ? this.sidebar : this.preview; } };
  const originalSidebar = makeNode('.user-mini .avatar', root, true);
  const originalPreview = makeNode('.profile-avatar-preview', root);
  root.sidebar = originalSidebar;
  root.preview = originalPreview;
  const cache = new AvatarNodeCache(root);
  const profile = { avatarPath: 'user/avatars/avatar.webp', avatarUrl: 'https://example.test/avatar.webp' };
  cache.adopt(profile);

  root.sidebar = makeNode('.user-mini .avatar', root);
  root.preview = makeNode('.profile-avatar-preview', root);
  cache.restore('settings');

  assert.equal(root.sidebar, originalSidebar);
  assert.equal(root.preview, originalPreview);
  assert.equal(cache.hasSidebar(profile), true);
  assert.equal(cache.hasSettingsPreview(profile), true);
});

test('Configuración consulta AvatarNodeCache y no crea una segunda imagen al volver a la sección', async () => {
  const view = await read('../assets/js/views/settings-view.js');
  assert.match(view, /view\.avatarNodeCache\?\.hasSettingsPreview\?\.\(state\.profile\)/);
  assert.doesNotMatch(view, /_settingsAvatarPreviewNode/);
  assert.match(view, /const avatarPreview = hasReusablePreview \? ''/);
});

test('avatar lateral tiene placeholder, shimmer y spinner circular, con el tamaño compacto de la barra', async () => {
  const view = await read('../assets/js/views/app-view.js');
  const css = await read('../assets/css/correspondence.css');
  const events = await read('../assets/js/controllers/app-event-coordinator-controller.js');
  assert.match(view, /avatar has-image is-loading/);
  assert.match(view, /avatar-image-placeholder/);
  assert.match(css, /\.user-mini \.avatar\.has-image\.is-loading::before/);
  assert.match(css, /\.user-mini \.avatar\.has-image\.is-loading::after/);
  assert.match(css, /width: 36px;[\s\S]*height: 36px;[\s\S]*flex: 0 0 36px/);
  assert.match(events, /\.user-mini \.avatar\.has-image\.is-loading/);
});

test('al cargar preferencias no se vuelve a descargar el avatar con la misma ruta', async () => {
  const controller = await read('../assets/js/controllers/settings-controller.js');
  const navigation = await read('../assets/js/controllers/navigation-controller.js');
  assert.match(controller, /sameAvatarPath/);
  assert.match(controller, /avatarNodeCache\?\.adopt/);
  assert.match(controller, /previousIdentity !== nextIdentity/);
  assert.match(controller, /syncAvatarFromProfile/);
  assert.match(navigation, /syncAvatarFromProfile/);
  assert.match(controller, /warmedImage\.decode\(\)/);
  assert.match(controller, /previewUrl\n\s*\};/);
});

test('las URL firmadas de Storage se reutilizan con una caché LRU limitada y caducidad anticipada', async () => {
  const storage = await read('../supabase/functions/_shared/storage.ts');
  assert.match(storage, /privateSignedUrlCache = new Map/);
  assert.match(storage, /privateSignedUrlPending = new Map/);
  assert.match(storage, /const pending = privateSignedUrlPending\.get\(cacheKey\)/);
  assert.match(storage, /privateSignedUrlPending\.set\(cacheKey, request\)/);
  assert.match(storage, /function cachedPrivateUrl/);
  assert.match(storage, /function rememberPrivateUrl/);
  assert.match(storage, /privateSignedUrlCache\.size > 2048/);
  assert.match(storage, /expiresIn - 120/);
  assert.match(storage, /const cached = cachedPrivateUrl\(cacheKey\)/);
});

test('avatar y cuerpo de carta solicitan variantes proporcionadas al tamaño de visualización', async () => {
  const storage = await read('../supabase/functions/_shared/storage.ts');
  const api = await read('../supabase/functions/letters-api/index.ts');
  assert.match(storage, /createPrivateAvatarUrl[\s\S]*width: 256, height: 256, resize: 'cover', quality: 78/);
  assert.match(storage, /width: 1440, height: 1440, resize: 'contain', quality: 78/);
  assert.match(api, /createPrivateAvatarUrl\(avatarPath, 86400\)/);
  assert.match(api, /createPrivateAvatarUrl\(path, 86400\)/);
  assert.match(api, /createPrivateDisplayUrl\(path, 86400\)/);
  assert.match(storage, /return createPrivateReadUrl\(path, expiresIn\)/);
});

test('el sello no dibuja panel cuadrado durante la carga', async () => {
  const css = await read('../assets/css/correspondence.css');
  assert.match(css, /\.letter-stamp\.has-image\.is-loading,[\s\S]*\.letter-stamp\.has-image\.is-loading \.letter-stamp-fallback\s*\{\s*background: transparent !important;/);
  assert.match(css, /border-radius: 50%/);
  assert.match(css, /letter-stamp-fallback::before\s*\{\s*background: none !important/);
});

test('letter-body normaliza el color de todos sus descendientes y usa papel sólido', async () => {
  const css = await read('../assets/css/correspondence.css');
  assert.match(css, /\.letter-paper \.letter-body :where\(\*\)/);
  assert.match(css, /-webkit-text-fill-color: #352c27 !important/);
  assert.match(css, /mix-blend-mode: normal !important/);
  assert.match(css, /background-image: none !important/);
  assert.match(css, /\.letter-paper \{\s*background-color: #fffdf8 !important/);
});
