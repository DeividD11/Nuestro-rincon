import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { AppController } from '../assets/js/controllers/app-controller.js';
import { AppView } from '../assets/js/views/app-view.js';

const read = path => readFile(new URL(path, import.meta.url), 'utf8');

function fakeElement(name, contains = () => false) {
  const attributes = new Map();
  return {
    name,
    attributes,
    inert: false,
    contains,
    focus() { globalThis.document.activeElement = this; this.focused = true; },
    toggleAttribute(attribute, enabled) {
      if (enabled) attributes.set(attribute, ''); else attributes.delete(attribute);
      if (attribute === 'inert') this.inert = enabled;
    },
    setAttribute(attribute, value) { attributes.set(attribute, String(value)); },
    removeAttribute(attribute) { attributes.delete(attribute); },
    getAttribute(attribute) { return attributes.has(attribute) ? attributes.get(attribute) : null; }
  };
}

test('el contenedor principal no es una región viva y existen dos anunciadores estables', async () => {
  const html = await read('../index.html');
  assert.doesNotMatch(html, /<div\s+id="app"[^>]*aria-live=/i);
  assert.match(html, /id="app-announcer"[^>]*role="status"[^>]*aria-live="polite"/);
  assert.match(html, /id="app-alert-announcer"[^>]*role="alert"[^>]*aria-live="assertive"/);
  const dom = await read('../assets/js/utils/dom.js');
  assert.match(dom, /toast\.setAttribute\('role', 'group'\)/);
  assert.match(dom, /announcerId = safeType === 'error' \? 'app-alert-announcer' : 'app-announcer'/);
  assert.doesNotMatch(dom, /toast\.setAttribute\('aria-live'/);
});

test('la vista incluye salto al contenido, navegación nombrada, ruta activa y encabezado enfocable', () => {
  const root = { innerHTML: '' };
  const view = new AppView(root);
  view.renderShell({
    route: 'inbox', routeLoading: true, mobileNavOpen: false,
    user: { displayName: 'Persona' }, dashboard: { unread: 0, recent: [] },
    notifications: [], selectedLetter: null, settings: {}
  });
  assert.match(root.innerHTML, /class="skip-link" href="#main-content"/);
  assert.match(root.innerHTML, /<nav id="primary-navigation"[^>]*aria-label="Principal"/);
  assert.match(root.innerHTML, /data-route="inbox"[^>]*aria-current="page"/);
  assert.match(root.innerHTML, /<main[^>]*id="main-content"[^>]*tabindex="-1"/);
  assert.match(root.innerHTML, /<h1 id="page-heading" tabindex="-1">Mi buzón<\/h1>/);
  assert.match(root.innerHTML, /aria-controls="primary-navigation"/);
});

test('el menú móvil vuelve inerte el panel oculto y desplaza el foco antes del cambio', () => {
  const previousWindow = globalThis.window;
  const previousDocument = globalThis.document;
  let activeElement;
  const trigger = fakeElement('trigger');
  const closeButton = fakeElement('close-button');
  const sidebarLink = fakeElement('sidebar-link');
  const mainInput = fakeElement('main-input');
  const sidebar = fakeElement('sidebar', element => element === sidebarLink || element === closeButton);
  const main = fakeElement('main', element => element === mainInput || element === trigger);
  const skipLink = fakeElement('skip-link');
  const elements = {
    '.sidebar': sidebar, '#main-content': main, '.skip-link': skipLink,
    '.mobile-menu': trigger, '.mobile-nav-close': closeButton
  };
  globalThis.document = { get activeElement() { return activeElement; }, set activeElement(value) { activeElement = value; } };
  globalThis.window = { matchMedia: () => ({ matches: true }), innerWidth: 390 };
  const controller = Object.create(AppController.prototype);
  controller.root = { querySelector: selector => elements[selector] || null };
  controller.state = { mobileNavOpen: false };
  try {
    activeElement = sidebarLink;
    controller.syncResponsiveAccessibility();
    assert.equal(activeElement, trigger, 'al cerrar el drawer, el foco sale de la navegación que quedará inerte');
    assert.equal(sidebar.inert, true);
    assert.equal(sidebar.getAttribute('aria-hidden'), 'true');
    assert.equal(main.inert, false);

    controller.state.mobileNavOpen = true;
    activeElement = mainInput;
    controller.syncResponsiveAccessibility();
    assert.equal(activeElement, closeButton, 'al abrir el drawer, el foco sale del contenido que quedará inerte');
    assert.equal(main.inert, true);
    assert.equal(main.getAttribute('aria-hidden'), 'true');
    assert.equal(sidebar.inert, false);
    assert.equal(skipLink.inert, true);
    assert.equal(trigger.getAttribute('aria-expanded'), 'true');
  } finally {
    if (previousWindow === undefined) delete globalThis.window; else globalThis.window = previousWindow;
    if (previousDocument === undefined) delete globalThis.document; else globalThis.document = previousDocument;
  }
});

test('los formularios tienen etiquetas asociadas y botones con tipo explícito', async () => {
  const source = await read('../assets/js/views/app-view.js');
  const forms = [...source.matchAll(/<form\b([^>]*)>([\s\S]*?)<\/form>/g)];
  assert.ok(forms.length >= 8, 'se esperan los formularios de acceso, recuperación y configuración');
  for (const [, attributes, body] of forms) {
    const id = attributes.match(/\bid="([^"]+)"/)?.[1] || 'formulario sin ID';
    for (const button of body.matchAll(/<button\b([^>]*)>/g)) {
      assert.match(button[1], /\btype="(?:submit|button|reset)"/, `${id}: cada botón debe declarar su tipo`);
    }
    for (const field of body.matchAll(/<(input|select|textarea)\b([^>]*)>/g)) {
      const fieldAttributes = field[2];
      const fieldId = fieldAttributes.match(/\bid="([^"]+)"/)?.[1];
      const hasAriaName = /\baria-label(?:ledby)?=/.test(fieldAttributes);
      const hasLabel = fieldId && new RegExp(`<label[^>]*for="${fieldId}"`).test(body);
      assert.ok(hasAriaName || hasLabel, `${id}: campo ${fieldId || field[1]} sin nombre accesible`);
    }
  }
  assert.match(source, /id="letter-editor"[^>]*role="textbox"[^>]*aria-labelledby="letter-body-label"[^>]*aria-describedby="letter-body-help"[^>]*aria-multiline="true"/);
});

test('la navegación enfoca el encabezado después de renderizar la sección', async () => {
  const source = await read('../assets/js/controllers/navigation-controller.js');
  assert.match(source, /heading\.focus\(\{ preventScroll: true \}\)/);
  assert.match(source, /const shouldFocus = options\?\.focus === true/);
  assert.match(source, /focusHeading\(\)/);
  const letter = await read('../assets/js/controllers/letter-controller.js');
  assert.match(letter, /openRoute\('sent', true, \{ focus: true \}\)/);
  assert.match(letter, /document\.addEventListener\('keydown', this\._sendPreviewKeydown, true\)/);
  assert.match(letter, /event\.key === 'Escape'/);
});

test('la hoja de estilos contempla foco visible, áreas táctiles y movimiento reducido', async () => {
  const css = await read('../assets/css/app.css');
  assert.match(css, /\.skip-link:focus/);
  assert.match(css, /\.topbar h1:focus/);
  assert.match(css, /@media \(pointer: coarse\)[\s\S]*?min-width: 44px[\s\S]*?min-height: 44px/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)/);
  assert.match(css, /:root \{ --muted: #71625b; \}/);
});

test('el README coincide con el baseline v11 y la distribución ZIP omite artefactos privados', async () => {
  const readme = await read('../README.md');
  const baseline = await read('../docs/REMOTE_BASELINE.md');
  const packageJson = JSON.parse(await read('../package.json'));
  const packager = await read('../scripts/package-zip.mjs');
  assert.match(readme, /auth-api[^\n]{0,100}v11|auth-api[^\n]{0,100}versión 11/i);
  assert.doesNotMatch(readme, /auth-api[^\n]{0,100}v10|auth-api[^\n]{0,100}versión 10/i);
  assert.match(baseline, /`auth-api` \| ACTIVE \| 11/);
  assert.equal(packageJson.scripts['package:zip'], 'node scripts/package-zip.mjs');
  for (const excluded of ["'.git'", "'node_modules'", "'_site'", "'dist'", "'.env'"]) assert.ok(packager.includes(excluded), `Falta excluir ${excluded}`);
  assert.match(packager, /\.env\.example/);
  assert.match(readme, /npm run package:zip/);
});

test('las notificaciones push se mantienen documentadas como función futura no activa', async () => {
  const roadmap = await read('../docs/PUSH_NOTIFICATIONS_ROADMAP.md');
  const readme = await read('../README.md');
  assert.match(roadmap, /Pospuesto; no implementado/);
  assert.match(roadmap, /No enviar contenido, título de la carta, remitente ni fragmentos privados/);
  assert.match(roadmap, /sesiones propias opacas/);
  assert.match(readme, /notificaciones externas todavía no están implementadas/);
});
