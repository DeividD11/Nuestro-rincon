import { spawn } from 'node:child_process';

const productionProjectRef = 'tiqbmuubpbmxqvtkcdhq';
const projectRef = String(process.env.NR_DB_TEST_PROJECT_REF || '').trim();
const databaseUrl = String(process.env.NR_TEST_DATABASE_URL || '').trim();

if (process.env.NR_TEST_CONFIRM_ISOLATED !== 'YES') {
  throw new Error('Bloqueado: define NR_TEST_CONFIRM_ISOLATED=YES después de verificar que el destino es desechable.');
}
if (!projectRef || projectRef === productionProjectRef) {
  throw new Error('Bloqueado: NR_DB_TEST_PROJECT_REF debe ser una referencia de pruebas distinta de producción.');
}
if (!databaseUrl) throw new Error('Falta NR_TEST_DATABASE_URL.');

let target;
try { target = new URL(databaseUrl); }
catch { throw new Error('NR_TEST_DATABASE_URL no es una URL PostgreSQL válida.'); }
if (target.protocol !== 'postgres:' && target.protocol !== 'postgresql:') {
  throw new Error('NR_TEST_DATABASE_URL debe usar el protocolo postgres:// o postgresql://.');
}
if (target.hostname !== `db.${projectRef}.supabase.co`) {
  throw new Error('La URL de base de datos no coincide exactamente con NR_DB_TEST_PROJECT_REF.');
}
if (target.hostname === `db.${productionProjectRef}.supabase.co`) {
  throw new Error('Bloqueado: no se ejecutan pruebas pgTAP contra producción.');
}

console.log(`Destino de pruebas pgTAP: ${projectRef} (aislado)`);
const args = [
  'test', 'db',
  `--remote=${databaseUrl}`,
  '--yes',
  'supabase/tests/auth_rate_limits.test.sql',
  'supabase/tests/shared_letter_purge.test.sql',
  'supabase/tests/profile_rename_transaction.test.sql'
];
const child = spawn('supabase', args, {
  stdio: 'inherit',
  shell: process.platform === 'win32'
});
child.on('error', error => {
  console.error(`No se pudo iniciar Supabase CLI: ${error.message}`);
  process.exitCode = 1;
});
child.on('exit', (code, signal) => {
  if (signal) process.exitCode = 1;
  else process.exitCode = code ?? 1;
});
