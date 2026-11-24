import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const css = await readFile(new URL('../assets/css/correspondence.css', import.meta.url), 'utf8');

test('las iniciales no aparecen detrás del spinner del avatar lateral mientras carga', () => {
  const rule = css.match(/\.user-mini \.avatar\.has-image\.is-loading \.avatar-image-placeholder\s*\{([^}]*)\}/)?.[1] ?? '';
  assert.ok(rule, 'debe existir una regla específica para el placeholder del avatar lateral');
  assert.match(rule, /color:\s*transparent\s*!important/);
  assert.match(rule, /-webkit-text-fill-color:\s*transparent/);
  assert.match(rule, /font-size:\s*0\s*!important/);
  assert.match(rule, /line-height:\s*0\s*!important/);
});

test('el spinner del avatar lateral tiene mayor contraste y sigue centrado', () => {
  const rule = css.match(/\.user-mini \.avatar\.has-image\.is-loading::after\s*\{([^}]*)\}/)?.[1] ?? '';
  assert.ok(rule, 'debe existir un indicador circular para el avatar en carga');
  assert.match(rule, /width:\s*16px/);
  assert.match(rule, /height:\s*16px/);
  assert.match(rule, /margin:\s*-8px 0 0 -8px/);
  assert.match(rule, /border-top-color:\s*rgba\(126,\s*91,\s*75,\s*\.94\)/);
  const darkRule = css.match(/html\[data-theme="dark"\] \.user-mini \.avatar\.has-image\.is-loading::after\s*\{([^}]*)\}/)?.[1] ?? '';
  assert.match(darkRule, /border-top-color:\s*rgba\(243,\s*220,\s*207,\s*\.96\)/);
});
