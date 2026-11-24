import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const css = await readFile(new URL('../assets/css/correspondence.css', import.meta.url), 'utf8');

test('el spinner de letter-stamp conserva la traslación central durante el giro', () => {
  const spinnerRules = [...css.matchAll(/\.letter-stamp\.has-image\.is-loading \.letter-stamp-fallback::after\s*\{([^}]*)\}/g)];
  const spinnerRule = spinnerRules.find(match => match[1].includes('animation: letter-stamp-centered-spin'))?.[0];
  assert.ok(spinnerRule, 'debe existir una regla específica para la animación centrada del sello');
  assert.match(spinnerRule, /left:\s*50%/);
  assert.match(spinnerRule, /top:\s*50%/);
  assert.match(spinnerRule, /transform:\s*translate\(-50%,\s*-50%\) rotate\(0deg\)/);
  assert.match(spinnerRule, /animation:\s*letter-stamp-centered-spin\s+\.8s linear infinite/);

  const keyframes = css.match(/@keyframes letter-stamp-centered-spin\s*\{([\s\S]*?)\n\}/)?.[1] ?? '';
  assert.match(keyframes, /from\s*\{\s*transform:\s*translate\(-50%,\s*-50%\) rotate\(0deg\)/);
  assert.match(keyframes, /to\s*\{\s*transform:\s*translate\(-50%,\s*-50%\) rotate\(360deg\)/);
  assert.doesNotMatch(spinnerRule, /animation:\s*letter-stamp-spin\b/);
});

test('reduced motion detiene el giro sin desplazar el spinner del centro', () => {
  const reduced = css.match(/@media \(prefers-reduced-motion: reduce\)\s*\{([\s\S]*?letter-stamp-centered-spin[\s\S]*?)\n\}/)?.[1] ?? '';
  assert.match(reduced, /animation:\s*none/);
  assert.match(reduced, /transform:\s*translate\(-50%,\s*-50%\)/);
});
