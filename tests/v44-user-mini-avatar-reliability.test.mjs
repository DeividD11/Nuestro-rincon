import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { AvatarNodeCache } from '../assets/js/views/avatar-node-cache.js';

const read = path => readFile(new URL(path, import.meta.url), 'utf8');

function makeClassList(initial = []) {
  const values = new Set(initial);
  return {
    values,
    add(...items) { items.forEach(item => values.add(item)); },
    remove(...items) { items.forEach(item => values.delete(item)); },
    contains(item) { return values.has(item); }
  };
}

function makeAvatarNode(image = null) {
  const placeholder = { style: {} };
  return {
    isConnected: true,
    classList: makeClassList(['has-image', 'is-loading']),
    querySelector(selector) {
      if (selector === 'img') return image;
      if (selector === '.avatar-image-placeholder') return placeholder;
      return null;
    },
    placeholder,
    replaceWith(next) { root.sidebar = next; }
  };
}

let root;

test('si el perfil tiene URL pero el nodo cacheado perdió la imagen, no se reutiliza', () => {
  root = { sidebar: null, querySelector() { return this.sidebar; } };
  const cache = new AvatarNodeCache(root);
  const profile = { avatarPath: 'user/avatars/a.webp', avatarUrl: 'https://example.test/a.webp' };
  cache.identity = cache.avatarIdentity(profile);
  cache.sidebarNode = makeAvatarNode(null);

  assert.equal(cache.hasSidebar(profile), false);
  assert.equal(cache.hasSidebarImage(profile), false);
});

test('un nodo lateral reconstruido no es sustituido por el fallback antiguo', () => {
  root = { sidebar: null, querySelector() { return this.sidebar; } };
  const cache = new AvatarNodeCache(root);
  const profile = { avatarPath: 'user/avatars/a.webp', avatarUrl: 'https://example.test/a.webp' };
  cache.identity = cache.avatarIdentity(profile);
  cache.sidebarNode = makeAvatarNode(null);
  const freshNode = makeAvatarNode({ complete: false, naturalWidth: 0 });
  root.sidebar = freshNode;

  cache.restore('home', { restoreSidebar: false });

  assert.equal(root.sidebar, freshNode);
  assert.equal(cache.sidebarNode, freshNode);
});

test('al restaurar un avatar ya descargado, se quita is-loading después de decodificar', async () => {
  root = { sidebar: null, querySelector() { return this.sidebar; } };
  const cache = new AvatarNodeCache(root);
  const image = {
    complete: true,
    naturalWidth: 128,
    isConnected: true,
    decode: () => Promise.resolve()
  };
  const cachedNode = makeAvatarNode(image);
  image.remove = () => { image.isConnected = false; };
  cache.sidebarNode = cachedNode;
  cache.identity = 'user/avatars/a.webp';
  root.sidebar = { replaceWith(next) { root.sidebar = next; } };

  cache.restore('home', { restoreSidebar: true });
  await Promise.resolve();
  await Promise.resolve();

  assert.equal(root.sidebar, cachedNode);
  assert.equal(cachedNode.classList.contains('is-loading'), false);
});

test('un error recibido mientras el nodo está desconectado deja visibles las iniciales', () => {
  root = { sidebar: null, querySelector() { return this.sidebar; } };
  const cache = new AvatarNodeCache(root);
  const image = { complete: true, naturalWidth: 0, isConnected: true, remove() { this.isConnected = false; } };
  const cachedNode = makeAvatarNode(image);
  cache.sidebarNode = cachedNode;
  cache.identity = 'user/avatars/a.webp';
  root.sidebar = { replaceWith(next) { root.sidebar = next; } };

  cache.restore('home', { restoreSidebar: true });

  assert.equal(root.sidebar, cachedNode);
  assert.equal(image.isConnected, false);
  assert.equal(cachedNode.classList.contains('has-image'), false);
  assert.equal(cachedNode.classList.contains('is-loading'), false);
  assert.equal(cachedNode.placeholder.style.opacity, '1');
});

test('el render solo restaura el nodo cacheado cuando su estado coincide con el perfil', async () => {
  const view = await read('../assets/js/views/app-view.js');
  const cache = await read('../assets/js/views/avatar-node-cache.js');
  assert.match(view, /const reuseSidebarAvatar = this\.avatarNodeCache\.hasSidebar\(state\.profile\)/);
  assert.match(view, /restore\(state\.route, \{ restoreSidebar: reuseSidebarAvatar \}\)/);
  assert.match(cache, /hasImageSource[\s\S]*querySelector\?\.\('img'\)/);
});

test('el perfil vuelve a firmarse si no hay imagen lateral sana aunque la ruta siga igual', async () => {
  const settings = await read('../assets/js/controllers/settings-controller.js');
  const navigation = await read('../assets/js/controllers/navigation-controller.js');
  const events = await read('../assets/js/controllers/app-event-coordinator-controller.js');
  assert.match(settings, /syncAvatarFromProfile\(previousProfile, this\.state\.profile\)/);
  assert.match(settings, /sidebarImageMissing/);
  assert.match(settings, /hasSidebarImage\?\./);
  assert.match(navigation, /syncAvatarFromProfile\(previousProfile, this\.state\.profile\)/);
  assert.match(events, /_avatarRefreshAttemptedPath !== failedPath/);
  assert.match(events, /loadPreferencesInBackground\?\.\(\)\.catch/);
});

test('el spinner de user-mini permanece fijo en el centro durante toda la vuelta', async () => {
  const css = await read('../assets/css/correspondence.css');
  const rules = [...css.matchAll(/\.user-mini \.avatar\.has-image\.is-loading::after\s*\{([^}]*)\}/g)];
  const finalRule = rules.map(match => match[1]).findLast(rule => /animation:\s*letter-stamp-centered-spin/.test(rule)) || '';
  assert.match(finalRule, /transform:\s*translate\(-50%, -50%\) rotate\(0deg\)/);
  assert.match(finalRule, /animation:\s*letter-stamp-centered-spin/);
  assert.match(css, /@keyframes letter-stamp-centered-spin\s*\{[\s\S]*translate\(-50%, -50%\) rotate\(360deg\)/);
});
