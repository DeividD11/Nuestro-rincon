import { access } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const productionProjectRef = 'tiqbmuubpbmxqvtkcdhq';
const projectRef = String(process.env.NR_DB_TEST_PROJECT_REF || '').trim();
const databaseUrl = String(process.env.NR_TEST_DATABASE_URL || '').trim();

if (process.env.NR_TEST_CONFIRM_ISOLATED !== 'YES') {
  throw new Error('Bloqueado: define NR_TEST_CONFIRM_ISOLATED=YES después de verificar que el destino es desechable.');
}
if (!/^[a-z0-9]{20}$/.test(projectRef) || projectRef === productionProjectRef) {
  throw new Error('Bloqueado: NR_DB_TEST_PROJECT_REF debe ser una referencia aislada válida y distinta de producción.');
}
if (!databaseUrl) throw new Error('Falta NR_TEST_DATABASE_URL.');

let target;
try { target = new URL(databaseUrl); }
catch { throw new Error('NR_TEST_DATABASE_URL no es una URL PostgreSQL válida.'); }
if (!['postgres:', 'postgresql:'].includes(target.protocol)) {
  throw new Error('NR_TEST_DATABASE_URL debe usar postgres:// o postgresql://.');
}
const directHost = target.hostname === `db.${projectRef}.supabase.co`;
const poolerHost = /^[a-z0-9-]+\.pooler\.supabase\.com$/i.test(target.hostname)
  && decodeURIComponent(target.username) === `postgres.${projectRef}`;
if (!directHost && !poolerHost) {
  throw new Error('La URL de pruebas no coincide con el ref indicado; usa conexión directa o Session Pooler del mismo proyecto.');
}
if (!target.password) throw new Error('NR_TEST_DATABASE_URL debe incluir contraseña PostgreSQL.');

const psql = spawnSync('psql', ['--version'], { encoding: 'utf8' });
if (psql.error || psql.status !== 0) throw new Error('Falta psql; instala el cliente PostgreSQL antes de ejecutar pgTAP.');

// pgTAP no está necesariamente habilitado en un proyecto recién creado.
// La activación se hace únicamente después de validar el ref aislado.
const extensionSetup = spawnSync('psql', [
  '--dbname', databaseUrl,
  '--no-psqlrc',
  '--set=ON_ERROR_STOP=1',
  '--command', 'CREATE SCHEMA IF NOT EXISTS extensions',
  '--command', 'CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions'
], { encoding: 'utf8', env: { ...process.env, PGAPPNAME: 'nuestro-rincon-pgtap-setup', PGCONNECT_TIMEOUT: process.env.PGCONNECT_TIMEOUT || '15' } });
if (extensionSetup.error || extensionSetup.status !== 0) {
  throw new Error(`No se pudo habilitar pgTAP en la base aislada: ${extensionSetup.stderr || extensionSetup.error?.message || 'error SQL'}`);
}

const files = [
  'supabase/tests/auth_rate_limits.test.sql',
  'supabase/tests/shared_letter_purge.test.sql',
  'supabase/tests/profile_rename_transaction.test.sql',
  'supabase/tests/recovery_code_bundles.test.sql',
  'supabase/tests/cursor_pagination.test.sql',
  'supabase/tests/api_rate_limits_and_push.test.sql',
  'supabase/tests/search_semantics.test.sql',
  'supabase/tests/private_media_cleanup_queue.test.sql'
];

console.log(`Destino pgTAP: ${projectRef} (aislado). Las pruebas se ejecutan dentro de sus propias transacciones y revierten sus fixtures.`);
for (const relativePath of files) {
  const file = resolve(root, relativePath);
  await access(file);
  console.log(`\n▶ ${relativePath}`);
  const result = spawnSync('psql', [
    '--dbname', databaseUrl,
    '--no-psqlrc',
    '--set=ON_ERROR_STOP=1',
    '--no-align',
    '--tuples-only',
    '--quiet',
    '--command', 'SET search_path TO extensions, public',
    '--file', file
  ], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, PGAPPNAME: 'nuestro-rincon-pgtap', PGCONNECT_TIMEOUT: process.env.PGCONNECT_TIMEOUT || '15' },
    maxBuffer: 8 * 1024 * 1024
  });

  const output = `${result.stdout || ''}${result.stderr || ''}`.trim();
  if (output) process.stdout.write(`${output}\n`);
  if (result.error) throw new Error(`No se pudo ejecutar psql para ${relativePath}: ${result.error.message}`);
  if (result.status !== 0) throw new Error(`pgTAP/SQL falló en ${relativePath} (código ${result.status}).`);

  const lines = (result.stdout || '').split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  const plans = lines.filter(line => /^1\.\.\d+$/.test(line));
  const passes = lines.filter(line => /^ok\s+\d+(?:\s|$)/.test(line));
  const failures = lines.filter(line => /^not ok\s+\d+(?:\s|$)/.test(line) || /^Bail out!/.test(line));
  if (plans.length !== 1) throw new Error(`No se encontró un único plan TAP en ${relativePath}.`);
  const planned = Number(plans[0].slice(3));
  if (failures.length || passes.length !== planned) {
    throw new Error(`Resultado TAP incompleto en ${relativePath}: plan ${planned}, ok ${passes.length}, fallos ${failures.length}.`);
  }
  console.log(`PASS: ${passes.length}/${planned} aserciones.`);
}

console.log('\nTodas las pruebas pgTAP terminaron correctamente en la base aislada.');
