import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const accessibilityCss = await readFile(new URL('../assets/css/accessibility.css', import.meta.url), 'utf8');
const e2eSpec = await readFile(new URL('./e2e/accessibility.spec.mjs', import.meta.url), 'utf8');

function luminance(hex) {
  const channels = hex.match(/[a-f0-9]{2}/gi).map(value => parseInt(value, 16) / 255);
  const linear = channels.map(value => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
  return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
}

function contrast(foreground, background) {
  const values = [luminance(foreground), luminance(background)].sort((a, b) => b - a);
  return (values[0] + 0.05) / (values[1] + 0.05);
}

test('el estado de entrega conserva contraste AA en papel claro', () => {
  assert.ok(contrast('#657565', '#fffdf8') >= 4.5);
  assert.match(accessibilityCss, /html:not\(\[data-theme="dark"\]\) \.letter-paper \.delivery-status/);
});

test('los controles de diálogo corregidos conservan contraste AA', () => {
  assert.ok(contrast('#865547', '#f2e9e1') >= 4.5);
  assert.ok(contrast('#b5aaa1', '#201d1b') >= 4.5);
  assert.ok(contrast('#ffffff', '#783935') >= 4.5);
  assert.match(accessibilityCss, /html:not\(\[data-theme="dark"\]\) \.nr-dialog-cancel/);
  assert.match(accessibilityCss, /html\[data-theme="dark"\] \.nr-dialog-detail/);
  assert.match(accessibilityCss, /\.nr-dialog-backdrop\[data-tone="danger"\] \.nr-dialog-confirm/);
});

test('el test de teclado incluye el botón de insertar imagen', () => {
  assert.match(e2eSpec, /toHaveCount\(7\)/);
  assert.match(e2eSpec, /data-action="choose-letter-image"/);
});
