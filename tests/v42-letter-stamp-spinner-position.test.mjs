import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const css = await readFile(new URL('../assets/css/correspondence.css', import.meta.url), 'utf8');

test('v49 elimina el giro y el movimiento del letter-stamp en todos los estados', () => {
  const overrides = css.slice(css.lastIndexOf('v49: imágenes estáticas'));
  assert.match(overrides, /\.letter-stamp img[\s\S]*?animation: none !important/);
  assert.match(overrides, /transition: none !important/);
  assert.match(overrides, /transform: none !important/);
  assert.match(overrides, /\.letter-stamp\.has-image\.is-loading \.letter-stamp-fallback::after/);
  assert.match(overrides, /display: none !important/);
  assert.doesNotMatch(overrides, /letter-stamp-centered-spin|letter-stamp-spin/);
});
