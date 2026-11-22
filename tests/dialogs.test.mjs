import test from 'node:test';
import assert from 'node:assert/strict';
import { readCssBundle } from './helpers/style-source.mjs';
import { readControllerSource } from './helpers/controller-source.mjs';
import { readFile } from 'node:fs/promises';

const read = path => readFile(new URL(path, import.meta.url), 'utf8');

test('las confirmaciones nativas se sustituyen por el diálogo común de la aplicación', async () => {
  const controller = await readControllerSource();
  const utility = await read('../assets/js/utils/dom.js');
  assert.match(controller, /showConfirmDialog/);
  assert.doesNotMatch(controller, /\b(?:window\.)?confirm\s*\(/);
  assert.match(utility, /export function showConfirmDialog/);
  assert.match(utility, /aria-modal/);
  assert.match(utility, /aria-labelledby/);
  assert.match(utility, /event\.key === 'Escape'/);
  assert.match(utility, /event\.key !== 'Tab'/);
});

test('las acciones destructivas explican el alcance y utilizan botones explícitos', async () => {
  const controller = await readControllerSource();
  assert.match(controller, /title: 'Eliminar definitivamente'/);
  assert.match(controller, /confirmLabel: 'Eliminar definitivamente'/);
  assert.match(controller, /cancelLabel: 'Mantener en Papelera'/);
  assert.match(controller, /title: 'Eliminar tu cuenta'/);
  assert.match(controller, /title: 'Revocar sesión'/);
});

test('los avisos emergentes son descartables y usan roles accesibles', async () => {
  const utility = await read('../assets/js/utils/dom.js');
  assert.match(utility, /export function showToast/);
  assert.match(utility, /setAttribute\('role', safeType === 'error' \? 'alert' : 'status'\)/);
  assert.match(utility, /aria-label', 'Cerrar aviso'/);
  assert.match(utility, /toast-close/);
});

test('los diálogos y avisos respetan tema oscuro, móvil y movimiento reducido', async () => {
  const css = await readCssBundle();
  assert.match(css, /\.nr-dialog-backdrop\s*\{/);
  assert.match(css, /\.nr-dialog-confirm-danger/);
  assert.match(css, /html\[data-theme="dark"\] \.nr-dialog/);
  assert.match(css, /@media \(max-width: 540px\)[\s\S]*\.nr-dialog-backdrop/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)[\s\S]*\.nr-dialog-backdrop/);
  assert.match(css, /\.app-toast\s*\{/);
});
