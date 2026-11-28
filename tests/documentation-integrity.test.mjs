import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';

const read = path => readFile(new URL(path, import.meta.url), 'utf8');

test('el inventario de pgTAP del ejecutor coincide con README y archivos SQL reales', async () => {
  const runner = await read('../scripts/run-db-tests.mjs');
  const readme = await read('../README.md');
  const suitePaths = [...runner.matchAll(/'((?:supabase\/tests)\/[a-z0-9_-]+\.test\.sql)'/g)].map(match => match[1]);
  assert.equal(suitePaths.length, 8, 'El ejecutor debe enumerar las ocho suites pgTAP actuales.');
  assert.equal(new Set(suitePaths).size, suitePaths.length, 'No debe haber suites duplicadas.');
  for (const path of suitePaths) {
    await readFile(new URL(`../${path}`, import.meta.url), 'utf8');
    assert.ok(readme.includes(path.split('/').at(-1)), `README no documenta ${path}`);
  }
  assert.match(readme, /ocho archivos pgTAP/);
});

test('los recuentos de migraciones coinciden con el inventario local v49', async () => {
  const files = (await readdir(new URL('../supabase/migrations/', import.meta.url)))
    .filter(name => name.endsWith('.sql')).sort();
  const readme = await read('../README.md');
  const baseline = await read('../docs/REMOTE_BASELINE.md');
  const rebuild = await read('../docs/DB_REBUILD.md');
  const runbook = await read('../docs/SYNC_RELEASE_RUNBOOK.md');
  const proposalTimestamps = ['20261119064344', '20261119090000', '20261120173200', '20261120235900', '20261121200000', '20261121210000', '20261121220000', '20261123193000', '20261127090000', '20261128030000'];
  const proposals = files.filter(name => proposalTimestamps.some(timestamp => name.startsWith(timestamp)));
  assert.equal(proposals.length, proposalTimestamps.length, 'La lista canónica debe resolver las diez propuestas locales.');
  assert.equal(files.length, 31, 'El paquete v49 debe contener 31 migraciones locales.');
  assert.equal(proposals.length, 10, 'El inventario actual debe contener diez propuestas locales posteriores.');
  assert.match(readme, /inventario local v49 contiene 31 archivos SQL/);
  assert.match(readme, /nueve propuestas locales restantes sin un diff completo/);
  assert.doesNotMatch(readme, /apliques los seis scripts locales/);
  assert.match(baseline, /Release v49[\s\S]*31 archivos SQL/);
  assert.match(rebuild, /Release v49[\s\S]*31 archivos SQL/);
  assert.match(runbook, /Release v49[\s\S]*withdraw_sent_letters_and_owner_purge/);
  for (const name of proposals) {
    assert.ok(rebuild.includes(name), `DB_REBUILD no incluye ${name}`);
    assert.ok(baseline.includes(name.slice(0, 14)), `REMOTE_BASELINE no incluye timestamp ${name}`);
  }
});

test('la documentación y el ejecutor declaran explícitamente la matriz accesible vigente', async () => {
  const spec = await read('../tests/e2e/accessibility.spec.mjs');
  const guide = await read('../docs/ACCESSIBILITY.md');
  const ciPolicy = await read('../docs/CI_RELEASE_POLICY.md');
  assert.match(spec, /'trash', 'letter'/);
  assert.match(spec, /'recovery-code'/);
  assert.match(spec, /delete-account-form/);
  assert.match(spec, /showConfirmDialog/);
  assert.match(spec, /\[640, 320\]/);
  assert.match(guide, /NVDA \+ Firefox/);
  assert.match(guide, /VoiceOver \+ Safari/);
  assert.match(guide, /TalkBack \+ Chrome/);
  assert.match(guide, /Pendiente manual/);
  assert.match(guide, /no se han ejecutado NVDA, VoiceOver ni TalkBack/);
  assert.match(ciPolicy, /nueve vistas y dos temas/);
});

test('la guía de contraste no conserva el recuento antiguo de 22 combinaciones', async () => {
  const docs = [
    await read('../README.md'),
    await read('../docs/ACCESSIBILITY.md'),
    await read('../docs/CI_RELEASE_POLICY.md'),
    await read('../docs/CONTROLLER_ARCHITECTURE.md')
  ].join('\n');
  assert.doesNotMatch(docs, /22 combinaciones/);
  assert.match(docs, /24 combinaciones/);
});
