import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = path => readFile(new URL(path, import.meta.url), 'utf8');

test('el saludo utiliza una ilustración adaptable sin depender de un glifo de fuente', async () => {
  const view = await read('../assets/js/views/app-view.js');
  const css = await read('../assets/css/app.css');
  const start = view.indexOf('class="greeting-card"');
  const end = view.indexOf('</section>', start);
  const markup = view.slice(start, end);
  assert.match(markup, /class="greeting-art" aria-hidden="true"/);
  assert.match(markup, /greeting-art-envelope/);
  assert.match(markup, /greeting-art-paper/);
  assert.doesNotMatch(markup, />✉<\/div>/);
  assert.match(css, /\.greeting-card\s*\{[\s\S]*display:\s*grid/);
  assert.match(css, /\.greeting-art\s*\{[\s\S]*position:\s*relative/);
  assert.match(css, /\.greeting-art-envelope::after/);
});

test('el diseño define ajustes explícitos para móvil estrecho, móvil ancho, tablet y escritorio', async () => {
  const css = await read('../assets/css/app.css');
  for (const query of [
    '@media (max-width: 360px)',
    '@media (max-width: 399px)',
    '@media (max-width: 720px)',
    '@media (min-width: 721px) and (max-width: 1024px)',
    '@media (min-width: 1200px) and (max-width: 1439px)',
    '@media (min-width: 1440px) and (max-width: 2199px)',
    '@media (min-width: 2200px)'
  ]) assert.ok(css.includes(query), `Falta el breakpoint ${query}`);
  assert.match(css, /grid-template-columns:\s*minmax\(0,\s*1fr\)\s*minmax\(84px,\s*27%\)/);
  assert.match(css, /html\[data-theme="dark"\] \.greeting-art-envelope/);
});

test('los controles y superficies tienen estados de foco visibles y adaptación táctil', async () => {
  const css = await read('../assets/css/app.css');
  assert.match(css, /button:focus-visible[\s\S]*outline:/);
  assert.match(css, /@media \(hover: none\)/);
  assert.match(css, /env\(safe-area-inset-bottom\)/);
  assert.match(css, /\.letter-card:not\(\.compact\) \{[\s\S]*display:\s*grid/);
});
