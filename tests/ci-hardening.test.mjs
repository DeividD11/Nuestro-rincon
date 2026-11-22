import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';

const read = path => readFile(new URL(path, import.meta.url), 'utf8');
const pinned = {
  'actions/checkout': 'df4cb1c069e1874edd31b4311f1884172cec0e10',
  'actions/setup-node': '949feb2413d6458794dcd2491c4babbbce0c15c1',
  'denoland/setup-deno': '22d081ff2d3a40755e97629de92e3bcbfa7cf2ed',
  'actions/upload-artifact': 'b7c566a772e6b6bfb58ed0dc250532a479d7789f',
  'actions/download-artifact': '018cc2cf5baa6db3ef3c5f8a56943fffe632ef53',
  'actions/configure-pages': '45bfe0192ca1faeb007ade9deae92b16b8254a0d',
  'actions/upload-pages-artifact': '7b1f4a764d45c48632c6b24a0339c27f5614fb0b',
  'actions/deploy-pages': 'f33f41b675f0ab2dc5a6863c9a170fe83af3571e',
  'supabase/setup-cli': '689adcfb80d947100a1eab127289b97d1fb07b13'
};

test('el lockfile incluye integridad para cada paquete descargado', async () => {
  const lock = JSON.parse(await read('../package-lock.json'));
  const missing = Object.entries(lock.packages)
    .filter(([, entry]) => entry.resolved && !entry.integrity)
    .map(([name]) => name);
  assert.deepEqual(missing, []);
  assert.equal(lock.packages['node_modules/axe-core'].version, '4.14.1');
  assert.match(lock.packages['node_modules/axe-core'].integrity, /^sha512-[A-Za-z0-9+/]+=*$/);
});

test('todas las GitHub Actions externas están fijadas a los SHA verificados', async () => {
  const files = await readdir(new URL('../.github/workflows/', import.meta.url));
  const workflows = await Promise.all(files.filter(name => /\.ya?ml$/i.test(name)).map(name => read(`../.github/workflows/${name}`)));
  const sources = workflows.join('\n');
  for (const [action, sha] of Object.entries(pinned)) {
    if (!sources.includes(`${action}@`)) continue;
    assert.ok(sources.includes(`${action}@${sha}`), `${action} debe permanecer fijada a ${sha}`);
  }
  assert.doesNotMatch(sources, /uses:\s*[^\s]+@(?![0-9a-f]{40}\b)/, 'ninguna acción externa puede depender de una etiqueta móvil');
});

test('CI fija npm, ejecuta cobertura con mínimos y publica el informe LCOV', async () => {
  const pkg = JSON.parse(await read('../package.json'));
  const workflow = await read('../.github/workflows/pages.yml');
  const runner = await read('../tools/run-coverage.mjs');
  assert.equal(pkg.packageManager, 'npm@11.19.1');
  assert.equal(pkg.scripts['test:coverage'], 'node tools/run-coverage.mjs');
  assert.match(workflow, /npm install --global npm@11\.19\.1/);
  assert.match(workflow, /run: npm run test:coverage/);
  assert.match(workflow, /frontend-coverage-lcov/);
  assert.match(workflow, /path: coverage\/lcov\.info/);
  assert.match(runner, /--test-coverage-include=assets\/js\/\*\*\/\*\.js/);
  assert.match(runner, /test-coverage-lines/);
  assert.match(runner, /test-coverage-functions/);
  assert.match(runner, /test-coverage-branches/);
});

test('la guía describe la protección de main y el check de verificación correcto', async () => {
  const doc = await read('../docs/GITHUB_BRANCH_PROTECTION.md');
  assert.match(doc, /Settings.*Rules.*Rulesets/i);
  assert.match(doc, /main/);
  assert.match(doc, /Verify frontend and Edge Functions/);
  assert.match(doc, /no se configura desde el ZIP/i);
});

test('el test de streaming usa RequestInit compatible con Deno', async () => {
  const source = await read('../supabase/functions/_shared/core.test.ts');
  assert.match(source, /body:\s*stream/);
  assert.doesNotMatch(source, /\bduplex\s*:/, 'Deno RequestInit no debe recibir la propiedad específica de Node duplex');
});
