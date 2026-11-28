import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { beginActionToast, showToast } from '../assets/js/utils/dom.js';
import { SettingsController } from '../assets/js/controllers/settings-controller.js';

const read = path => readFile(new URL(path, import.meta.url), 'utf8');

class FakeElement {
  constructor(tag = 'div') {
    this.tagName = tag.toUpperCase();
    this.children = [];
    this.attributes = new Map();
    this.listeners = new Map();
    this.dataset = {};
    this.style = {
      values: new Map(),
      history: [],
      setProperty(name, value) { this.values.set(name, value); this.history.push([name, value]); },
      removeProperty(name) { this.values.delete(name); }
    };
    this.className = '';
    this.textContent = '';
    this.isConnected = true;
    this.classList = {
      add: (...names) => { const set = new Set(this.className.split(/\s+/).filter(Boolean)); names.forEach(name => set.add(name)); this.className = [...set].join(' '); },
      remove: (...names) => { const remove = new Set(names); this.className = this.className.split(/\s+/).filter(name => name && !remove.has(name)).join(' '); },
      contains: name => this.className.split(/\s+/).includes(name)
    };
  }
  append(...nodes) { this.children.push(...nodes); nodes.forEach(node => { node.parentNode = this; }); }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  addEventListener(name, callback) { this.listeners.set(name, callback); }
  remove() { this.isConnected = false; this.parentNode?.children?.splice(this.parentNode.children.indexOf(this), 1); }
  querySelector(selector) {
    const match = node => selector.startsWith('.')
      ? node.className.split(/\s+/).includes(selector.slice(1))
      : selector === 'p' ? node.tagName === 'P'
      : selector === 'strong' ? node.tagName === 'STRONG'
      : false;
    const visit = nodes => {
      for (const node of nodes) {
        if (match(node)) return node;
        const nested = visit(node.children || []);
        if (nested) return nested;
      }
      return null;
    };
    return visit(this.children);
  }
}

function installFakeDom() {
  const previousDocument = globalThis.document;
  const previousWindow = globalThis.window;
  const previousLocalStorage = globalThis.localStorage;
  const nodes = new Map();
  let timerId = 0;
  const body = new FakeElement('body');
  const documentElement = new FakeElement('html');
  documentElement.dataset = { theme: 'dark' };
  const metaTheme = { content: '#171615' };
  globalThis.document = {
    body,
    documentElement,
    createElement: tag => new FakeElement(tag),
    querySelector(selector) {
      if (selector === '.toast-region') return nodes.get('toast-region') || body.children.find(node => node.className === 'toast-region') || null;
      if (selector === 'meta[name="theme-color"]') return metaTheme;
      return null;
    },
    getElementById(id) { return nodes.get(id) || null; },
    startViewTransition(callback) {
      callback();
      return { finished: Promise.resolve() };
    },
    _nodes: nodes,
    _metaTheme: metaTheme
  };
  globalThis.window = {
    innerWidth: 1024,
    innerHeight: 768,
    matchMedia: () => ({ matches: false }),
    setTimeout: () => ++timerId,
    clearTimeout: () => {}
  };
  const storage = new Map();
  globalThis.localStorage = {
    getItem: key => storage.get(key) ?? null,
    setItem: (key, value) => storage.set(key, String(value)),
    removeItem: key => storage.delete(key)
  };
  return () => {
    if (previousDocument === undefined) delete globalThis.document; else globalThis.document = previousDocument;
    if (previousWindow === undefined) delete globalThis.window; else globalThis.window = previousWindow;
    if (previousLocalStorage === undefined) delete globalThis.localStorage; else globalThis.localStorage = previousLocalStorage;
  };
}

test('un aviso de acción aparece como proceso y se transforma en éxito sin duplicar tarjetas', () => {
  const restore = installFakeDom();
  try {
    const feedback = beginActionToast('Subiendo avatar…');
    assert.match(feedback.toast.className, /toast-loading/);
    feedback.success('Avatar sincronizado.');
    assert.match(feedback.toast.className, /toast-success/);
    assert.equal(feedback.toast.querySelector('p')?.textContent, 'Avatar sincronizado.');
    assert.equal(document.querySelector('.toast-region').children.length, 1);
  } finally { restore(); }
});

test('el cambio de tema usa el origen del puntero y solo crea una vista previa sin persistir', async () => {
  const restore = installFakeDom();
  try {
    const calls = [];
    const controller = Object.assign(Object.create(SettingsController.prototype), {
      state: { settings: { theme: 'dark', time_zone: 'America/Bogota', in_app_notifications_enabled: true } },
      session: { user: { id: 'user-1' } },
      systemThemeMedia: { matches: false },
      root: { querySelector: () => ({ getBoundingClientRect: () => ({ left: 20, top: 30, width: 140, height: 32 }) }) },
      repository: { saveSettings: async settings => { calls.push(settings); return { settings }; } },
      invalidateRouteCache() {}
    });
    controller._themePointerOrigin = { x: 82, y: 44, at: Date.now() };
    await controller.changeThemePreference('light', { target: { getBoundingClientRect: () => ({ left: 20, top: 30, width: 140, height: 32 }) } });
    assert.equal(document.documentElement.dataset.theme, 'light');
    assert.ok(document.documentElement.style.history.some(([name, value]) => name === '--theme-reveal-x' && value === '82px'));
    assert.ok(document.documentElement.style.history.some(([name, value]) => name === '--theme-reveal-y' && value === '44px'));
    assert.equal(calls.length, 0, 'La selección no debe guardar hasta enviar el formulario.');
    assert.equal(controller._themePreferenceDirty, true);
    assert.equal(localStorage.getItem('nuestro-rincon:theme:user-1'), null);
    assert.match(controller._themePreferenceFeedback.toast.className, /toast-info/);
    await Promise.resolve();
  } finally { restore(); }
});

test('el tema local no se sobrescribe con una respuesta antigua mientras su guardado está pendiente', async () => {
  const controller = await read('../assets/js/controllers/settings-controller.js');
  const navigation = await read('../assets/js/controllers/navigation-controller.js');
  assert.match(controller, /this\._themePreferenceDirty \|\| themeChangedWhileLoading/);
  assert.match(navigation, /this\._themePreferenceDirty \|\| themeChangedSinceFetch/);
  assert.match(controller, /cache: false/);
  assert.doesNotMatch(controller, /repository\.saveSettings/);
  assert.match(controller, /discardThemePreview\(\)/);
  const submit = await read('../assets/js/controllers/app-submit-handler.js');
  assert.match(submit, /repository\.saveSettings\(payload\)/);
  assert.match(submit, /this\.cacheTheme\(savedTheme\)/);
  assert.match(controller, /this\._themePreferenceDirty = false/);
});

test('la transición circular utiliza view transitions y un radio vectorial desde el punto de origen', async () => {
  const controller = await read('../assets/js/controllers/settings-controller.js');
  const styles = await read('../assets/css/theme-transition.css');
  const events = await read('../assets/js/controllers/app-event-coordinator-controller.js');
  const index = await read('../index.html');
  assert.match(controller, /document\.startViewTransition\(apply\)/);
  assert.match(controller, /--theme-reveal-x/);
  assert.match(styles, /::view-transition-new\(root\)/);
  assert.match(styles, /circle\(160vmax at var\(--theme-reveal-x/);
  assert.match(events, /pointerdown[\s\S]*clientX[\s\S]*clientY/);
  assert.match(index, /assets\/css\/theme-transition\.css/);
  assert.match(styles, /prefers-reduced-motion/);
});

test('el avatar presenta un estado de sincronización antes de subir y confirma después de decodificar la imagen', async () => {
  const controller = await read('../assets/js/controllers/settings-controller.js');
  const events = await read('../assets/js/controllers/app-event-coordinator-controller.js');
  assert.match(controller, /beginActionToast\('Preparando y subiendo tu avatar/);
  assert.match(controller, /this\.updateAvatarPreview\(previewUrl,[\s\S]*?await this\.repository\.prepareMediaUpload/);
  assert.match(controller, /await this\.waitForAvatarImage\(warmedImage\)/);
  assert.match(controller, /feedback\.success\('Tu avatar se actualizó y ya está sincronizado\.'/);
  assert.match(events, /if \(!error\?\.actionFeedbackShown\) showToast/);
});

test('las preferencias comunican que el tema es una vista previa hasta guardar', async () => {
  const submit = await read('../assets/js/controllers/app-submit-handler.js');
  const view = await read('../assets/js/views/settings-view.js');
  assert.match(submit, /'settings-form': 'Guardando las preferencias/);
  assert.match(submit, /actionFeedback\?\.success\('Las preferencias se guardaron correctamente\.'/);
  assert.match(view, /vista previa/i);
  assert.match(view, /Guardar preferencias/);
  assert.match(view, /si sales de Configuración sin guardar, volverá el último tema guardado/i);
  const draft = await read('../assets/js/controllers/draft-controller.js');
  const letters = await read('../assets/js/controllers/letter-controller.js');
  const clicks = await read('../assets/js/controllers/app-click-handler.js');
  assert.match(draft, /beginActionToast\('Preparando y subiendo la imagen/);
  assert.match(draft, /feedback\.success\('La imagen se subió y ya está visible/);
  assert.match(draft, /beginActionToast\('Guardando el borrador/);
  assert.match(letters, /beginActionToast\('Enviando tu carta/);
  assert.match(clicks, /beginActionToast\(next \? 'Añadiendo la carta a Favoritos/);
  assert.match(clicks, /beginActionToast\('Revocando las demás sesiones/);
  assert.match(submit, /'profile-form': 'Actualizando tu nombre/);
  assert.match(submit, /'password-form': 'Actualizando tu contraseña/);
});


test('showToast mantiene el rol accesible, usa tipo seguro y permite actualizar y descartar', () => {
  const restore = installFakeDom();
  try {
    const toast = showToast('Se guardó.', 'tipo-no-permitido', { duration: 2200 });
    assert.match(toast.className, /toast-info/);
    assert.equal(toast.getAttribute('role'), 'group');
    toast.update('Falló la operación.', 'error', { duration: 3200 });
    assert.match(toast.className, /toast-error/);
    assert.equal(toast.querySelector('p')?.textContent, 'Falló la operación.');
    const region = document.querySelector('.toast-region');
    assert.equal(region.children.length, 1);
    toast.dismiss();
    assert.equal(region.children.length, 0);
  } finally { restore(); }
});

test('applyTheme usa el tema del sistema y cambia directamente cuando el movimiento está reducido', () => {
  const restore = installFakeDom();
  try {
    let transitions = 0;
    document.startViewTransition = callback => { transitions++; callback(); return { finished: Promise.resolve() }; };
    window.matchMedia = () => ({ matches: true });
    const controller = Object.assign(Object.create(SettingsController.prototype), {
      state: { settings: {} }, systemThemeMedia: { matches: true }, cacheTheme() {}
    });
    controller.applyTheme('system', { animate: true });
    assert.equal(document.documentElement.dataset.theme, 'dark');
    assert.equal(transitions, 0);
    controller.applyTheme('light', { animate: true });
    assert.equal(document.documentElement.dataset.theme, 'light');
    assert.equal(transitions, 0);
  } finally { restore(); }
});

test('applyTheme aplica inmediatamente si View Transitions no está disponible y si el color ya coincide', () => {
  const restore = installFakeDom();
  try {
    delete document.startViewTransition;
    window.matchMedia = () => ({ matches: false });
    const controller = Object.assign(Object.create(SettingsController.prototype), {
      state: { settings: {} }, systemThemeMedia: { matches: false }, cacheTheme() {}
    });
    const first = controller.applyTheme('light', { animate: true });
    assert.equal(first, null);
    assert.equal(document.documentElement.dataset.theme, 'light');
    const second = controller.applyTheme('system', { animate: true });
    assert.equal(second, null);
    assert.equal(document.documentElement.dataset.theme, 'light');
  } finally { restore(); }
});

test('applyTheme recupera el cambio directo cuando el navegador rechaza iniciar View Transition', () => {
  const restore = installFakeDom();
  try {
    document.startViewTransition = () => { throw new Error('View transition unavailable'); };
    window.matchMedia = () => ({ matches: false });
    const controller = Object.assign(Object.create(SettingsController.prototype), {
      state: { settings: {} }, systemThemeMedia: { matches: false }, cacheTheme() {}
    });
    controller.applyTheme('dark', { animate: true, origin: { x: 9, y: 13 } });
    assert.equal(document.documentElement.dataset.theme, 'dark');
    assert.equal(document.documentElement.classList.contains('theme-circular-transition'), false);
    assert.equal(document.documentElement.style.values.has('--theme-reveal-x'), false);
  } finally { restore(); }
});

test('salir de Configuración restaura el tema guardado y no conserva la vista previa', async () => {
  const restore = installFakeDom();
  try {
    const themeControl = { value: 'light' };
    const controller = Object.assign(Object.create(SettingsController.prototype), {
      state: { settings: { theme: 'light' } },
      session: { user: { id: 'user-1' } },
      systemThemeMedia: { matches: true },
      root: { querySelector: selector => selector === '#settings-theme' ? themeControl : null },
      repository: { saveSettings: async () => { throw new Error('No debe guardar al seleccionar.'); } },
      invalidateRouteCache() {}
    });
    controller._savedThemePreference = 'dark';
    controller._themePreferenceDirty = true;
    controller.applyTheme('light', { cache: false });
    assert.equal(document.documentElement.dataset.theme, 'light');
    assert.equal(localStorage.getItem('nuestro-rincon:theme:user-1'), null);
    assert.equal(await controller.discardThemePreview(), true);
    assert.equal(document.documentElement.dataset.theme, 'dark');
    assert.equal(controller.state.settings.theme, 'dark');
    assert.equal(controller._themePreferenceDirty, false);
    assert.equal(themeControl.value, 'dark');
    assert.equal(localStorage.getItem('nuestro-rincon:theme:user-1'), null);
  } finally { restore(); }
});

test('una respuesta tardía de preferencias no revierte el tema nuevo después de que ya se sincronizó', async () => {
  let resolveSettings;
  const request = new Promise(resolve => { resolveSettings = resolve; });
  const controller = Object.assign(Object.create(SettingsController.prototype), {
    session: { user: { id: 'user-1' } },
    state: { settings: { theme: 'dark' }, profile: { avatarPath: 'same-path', avatarUrl: 'current-url' } },
    repository: { settings: () => request },
    view: { avatarNodeCache: { hasSidebarImage: () => true } },
    root: { querySelector: () => null },
    syncAvatarFromProfile() {}, cacheTheme() {}, applyTheme(theme) { this.appliedTheme = theme; },
    loadPushStatus: async () => {}
  });
  controller._themePreferenceVersion = 0;
  const loading = controller.loadPreferencesInBackground();
  controller._themePreferenceVersion = 1;
  controller._themePreferenceDirty = false;
  controller.state.settings.theme = 'light';
  resolveSettings({ settings: { theme: 'dark' }, profile: { avatarPath: 'same-path', avatarUrl: 'older-url' } });
  await loading;
  assert.equal(controller.state.settings.theme, 'light');
  assert.equal(controller.appliedTheme, 'light');
});

test('applyRouteData ignora el tema de una respuesta de configuración iniciada antes del último cambio', async () => {
  const { NavigationController } = await import('../assets/js/controllers/navigation-controller.js');
  const controller = Object.assign(Object.create(NavigationController.prototype), {
    _themePreferenceVersion: 3,
    _themePreferenceDirty: false,
    state: { settings: { theme: 'light' }, profile: {}, sessions: [], invitation: {} },
    syncAvatarFromProfile() {}, cacheTheme() {}, applyTheme() {},
    view: { avatarNodeCache: { hasSidebarImage: () => true } }
  });
  controller.applyRouteData('settings', {
    themePreferenceVersion: 2,
    settings: { settings: { theme: 'dark' }, profile: {} },
    sessions: { sessions: [] }, invitation: { canCreate: true }
  });
  assert.equal(controller.state.settings.theme, 'light');
});
