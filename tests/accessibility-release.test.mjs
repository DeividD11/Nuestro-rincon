import test from 'node:test';
import { readAppViewSource } from './helpers/view-source.mjs';
import assert from 'node:assert/strict';
import { readCssBundle } from './helpers/style-source.mjs';
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

test('la vista elimina el enlace de salto y conserva navegación nombrada, ruta activa y encabezado enfocable', () => {
  const root = { innerHTML: '' };
  const view = new AppView(root);
  view.renderShell({
    route: 'inbox', routeLoading: true, mobileNavOpen: false,
    user: { displayName: 'Persona' }, dashboard: { unread: 0, recent: [] },
    notifications: [], selectedLetter: null, settings: {}
  });
  assert.doesNotMatch(root.innerHTML, /skip-link|Saltar al contenido principal/i);
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
  const elements = {
    '.sidebar': sidebar, '#main-content': main,
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
    assert.equal(trigger.getAttribute('aria-expanded'), 'true');
  } finally {
    if (previousWindow === undefined) delete globalThis.window; else globalThis.window = previousWindow;
    if (previousDocument === undefined) delete globalThis.document; else globalThis.document = previousDocument;
  }
});

test('los formularios tienen etiquetas asociadas y botones con tipo explícito', async () => {
  const source = await readAppViewSource();
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
  assert.match(letter, /openRoute\('sent', true, \{ focus: true, skipHistory: true \}\)/);
  assert.match(letter, /document\.addEventListener\('keydown', this\._sendPreviewKeydown, true\)/);
  assert.match(letter, /event\.key === 'Escape'/);
});

test('el texto de metadatos y estado de entrega conserva contraste AA sobre el papel oscuro', async () => {
  const css = await read('../assets/css/app.css');
  assert.match(css, /html\[data-theme="dark"\] \.letter-paper \.letter-byline,[\s\S]*?html\[data-theme="dark"\] \.letter-paper \.eyebrow\{color:#6f5a50\}/);
  assert.match(css, /html\[data-theme="dark"\] \.letter-paper \.delivery-status\{color:#496749\}/);

  const luminance = hex => {
    const rgb = [1, 3, 5].map(index => parseInt(hex.slice(index, index + 2), 16) / 255);
    const channels = rgb.map(value => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
    return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
  };
  const contrast = (foreground, background) => {
    const values = [luminance(foreground), luminance(background)].sort((a, b) => b - a);
    return (values[0] + 0.05) / (values[1] + 0.05);
  };
  assert.ok(contrast('#6f5a50', '#f4eee5') >= 4.5, 'los metadatos de la carta deben cumplir WCAG AA');
  assert.ok(contrast('#496749', '#f4eee5') >= 4.5, 'el estado de entrega debe cumplir WCAG AA');
});

test('la hoja de estilos contempla foco visible, áreas táctiles y movimiento reducido', async () => {
  const css = await readCssBundle();
  assert.doesNotMatch(css, /skip-link|Saltar al contenido principal/i);
  assert.match(css, /#page-heading:focus[\s\S]*?outline: 0 !important;[\s\S]*?box-shadow: none !important;/);
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

test('Web Push está preparado pero no se activa antes de configurar y desplegar backend', async () => {
  const roadmap = await read('../docs/PUSH_NOTIFICATIONS_ROADMAP.md');
  const readme = await read('../README.md');
  const realtime = await read('../docs/REALTIME_AUTH_BRIDGE.md');
  const lettersApi = await read('../supabase/functions/letters-api/index.ts');
  const authApi = await read('../supabase/functions/auth-api/index.ts');
  assert.match(roadmap, /todavía no activada en Supabase/);
  assert.match(roadmap, /No se debe añadir el título, remitente, cuerpo, HTML/);
  assert.match(roadmap, /VAPID_PRIVATE_KEY/);
  assert.match(roadmap, /user_id.*session_id/);
  assert.match(readme, /Web Push tiene service worker[\s\S]*no se activa hasta aplicar la migración nueva/);
  assert.match(lettersApi, /action === 'draft:send' \|\| action === 'reply'/);
  assert.match(lettersApi, /EdgeRuntime\?\.waitUntil|waitUntil: \(promise: Promise<unknown>\) => void/);
  assert.match(lettersApi, /Tienes una nueva carta/);
  assert.match(authApi, /recover-with-code[\s\S]{0,1800}push_subscriptions/);
  assert.match(realtime, /No se abre un canal público como atajo/);
});



test('las pruebas de seguridad remota requieren secretos completos y destino aislado', async () => {
  const integration = await read('../.github/workflows/security-integration.yml');
  const database = await read('../.github/workflows/security-db.yml');
  const browser = await read('../.github/workflows/security-playwright.yml');
  for (const secret of [
    'NR_TEST_SUPABASE_URL', 'NR_TEST_PROJECT_REF', 'NR_TEST_PUBLISHABLE_KEY',
    'NR_TEST_BOOTSTRAP_INVITATION', 'NR_TEST_ACCOUNT_A_USERNAME', 'NR_TEST_ACCOUNT_A_PASSWORD',
    'NR_TEST_ACCOUNT_B_USERNAME', 'NR_TEST_ACCOUNT_B_PASSWORD'
  ]) assert.ok(integration.includes(secret), `Falta validación/configuración de ${secret} en integración`);
  assert.match(integration, /Faltan datos de la prueba aislada/);
  assert.match(database, /NR_TEST_CONFIRM_ISOLATED: 'YES'/);
  assert.match(database, /postgresql-client/);
  assert.match(database, /NR_TEST_DATABASE_URL/);
  assert.match(browser, /NR_E2E_ACCOUNT_A_PASSWORD/);
  assert.match(browser, /NR_E2E_ACCOUNT_B_PASSWORD/);
});


test('cada Edge Function tiene su propio deno.json y web-push está versionado', async () => {
  const config = await read('../supabase/config.toml');
  const auth = JSON.parse(await read('../supabase/functions/auth-api/deno.json'));
  const letters = JSON.parse(await read('../supabase/functions/letters-api/deno.json'));
  const packageJson = JSON.parse(await read('../package.json'));
  assert.match(config, /functions\.auth-api[\s\S]*import_map = "\.\/functions\/auth-api\/deno\.json"/);
  assert.match(config, /functions\.letters-api[\s\S]*import_map = "\.\/functions\/letters-api\/deno\.json"/);
  assert.equal(auth.imports.linkedom, 'npm:linkedom@0.18.12');
  assert.equal(letters.imports['web-push'], 'npm:web-push@4.0.0');
  assert.match(packageJson.scripts['check:edge'], /auth-api\/deno\.json[\s\S]*letters-api\/deno\.json/);
});

test('el pie del editor queda dentro del editor-shell y no invade el área del sidebar', async () => {
  const view = await readAppViewSource();
  const css = await read('../assets/css/editor.css');
  const start = view.indexOf('export function renderEditor(view, state) {');
  const end = view.indexOf('export function renderLetter(view, state)', start);
  const editor = view.slice(start, end);
  assert.match(editor, /editor-writing-surface[\s\S]*letter-editor[\s\S]*<div class="editor-footer">[\s\S]*<\/section>/);
  assert.doesNotMatch(editor, /letter-body-help[\s\S]*<\/div><\/div><div class="editor-footer">/);
  assert.match(css, /\.editor-footer\s*\{[\s\S]*grid-template-columns:\s*minmax\(0,\s*1fr\) minmax\(0,\s*auto\)/);
  assert.match(css, /@media \(max-width: 1200px\)[\s\S]*\.editor-footer \{ grid-template-columns: minmax\(0, 1fr\)/);
  assert.match(css, /\.editor-footer > small[\s\S]*overflow-wrap: anywhere/);
});


test('el pie del editor pertenece a editor-shell y sus reglas viven en un módulo CSS específico', async () => {
  const view = await readAppViewSource();
  const css = await read('../assets/css/editor.css');
  const index = await read('../index.html');
  const start = view.indexOf('<section class="editor-shell">');
  const end = view.indexOf('</section>`;', start);
  const editorMarkup = view.slice(start, end);
  assert.ok(start >= 0 && end > start);
  assert.match(editorMarkup, /<div class="editor-footer">[\s\S]*<\/div>$/);
  assert.match(css, /@media \(max-width: 1200px\)/);
  assert.match(css, /@media \(max-width: 720px\)/);
  assert.match(index, /assets\/css\/editor\.css/);
});

test('la auditoría de contraste cubre las superficies reales de ambos temas y es parte del pipeline', async () => {
  const { spawnSync } = await import('node:child_process');
  const contrast = await read('../tools/contrast-audit.mjs');
  const workflow = await read('../.github/workflows/pages.yml');
  assert.match(contrast, /panel lateral oscuro/);
  assert.match(contrast, /panel lateral claro/);
  assert.match(contrast, /texto de identificación de la barra superior/);
  const appCss = await readCssBundle();
  assert.match(appCss, /\.topbar-kicker\s*\{[^}]*color:\s*var\(--muted\)/);
  assert.doesNotMatch(appCss, /\.topbar-kicker\s*\{[^}]*color:\s*#a18e84/i);
  assert.match(workflow, /npm run check:contrast/);
  const result = spawnSync(process.execPath, ['tools/contrast-audit.mjs'], { cwd: new URL('..', import.meta.url), encoding: 'utf8' });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
});

test('axe-core WCAG 2.2 AA corre en ambos temas y Playwright forma parte del gate de Pages', async () => {
  const packageJson = JSON.parse(await read('../package.json'));
  const lock = JSON.parse(await read('../package-lock.json'));
  const workflow = await read('../.github/workflows/pages.yml');
  const axe = await read('../tests/e2e/accessibility.spec.mjs');
  assert.equal(packageJson.devDependencies['axe-core'], '4.14.1');
  assert.equal(lock.packages['node_modules/axe-core'].version, '4.14.1');
  assert.match(axe, /wcag22aa/);
  assert.match(axe, /\['light', 'dark'\]/);
  assert.match(axe, /'trash', 'letter'/);
  assert.match(axe, /showConfirmDialog/);
  assert.match(axe, /\[640, 320\]/);
  assert.match(workflow, /npm ci/);
  assert.match(workflow, /npm run test:a11y/);
  assert.ok(workflow.indexOf('npm run test:a11y') < workflow.indexOf('actions/upload-artifact@b7c566a772e6b6bfb58ed0dc250532a479d7789f'));
});

test('las tarjetas de la Papelera conservan nombre visible y contraste AA en ambos temas', async () => {
  const view = await read('../assets/js/views/correspondence-view.js');
  const css = await read('../assets/css/accessibility.css');
  const appCss = await read('../assets/css/app.css');
  assert.doesNotMatch(view, /class="letter-card-main"[^>]*aria-label=/);
  assert.match(view, /class="letter-card-main"[^>]*data-letter-id=/);
  assert.match(view, /renderLetterBodyHtml\(letter\.body \|\| ''\)/);
  assert.match(view, /renderThreadItem[\s\S]*?conversation-preview-text/);
  assert.doesNotMatch(view, /\bfmtBody\b/);
  assert.match(appCss, /\.status-pill\{[^}]*background:#f2e8df;color:#80513f\}/);
  assert.match(appCss, /\.status-pill\.unread\{background:#f4dfd8;color:#8c4c40\}/);
  assert.match(css, /html\[data-theme="dark"\] \.letter-meta time\s*\{\s*color:\s*#c7b6aa;\s*\}/);
});

test('los escenarios de error del servidor identifican el mensaje del formulario y no el anunciador global', async () => {
  const source = await read('../tests/e2e/accessibility.spec.mjs');
  assert.match(source, /page\.locator\('\.form-error\[role="alert"\]'\)/);
  assert.doesNotMatch(source, /page\.getByRole\('alert'\)\.toContainText/);
});

