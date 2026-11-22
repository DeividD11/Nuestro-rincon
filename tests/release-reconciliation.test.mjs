import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = path => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

test('el diagnóstico remoto usa una transacción READ ONLY y no contiene DDL/DML', async () => {
  const sql = await read('supabase/diagnostics/reconciliation-readonly.sql');
  assert.match(sql, /^--[^\n]*\nBEGIN READ ONLY;/);
  assert.match(sql, /schema_migrations/);
  assert.match(sql, /has_table_privilege\('anon'/);
  assert.match(sql, /pg_get_functiondef/);
  assert.doesNotMatch(sql, /\b(?:CREATE|ALTER|DROP|INSERT|UPDATE|DELETE|TRUNCATE|GRANT|REVOKE)\s+(?:TABLE|FUNCTION|INDEX|TRIGGER|POLICY|SCHEMA|EXTENSION|INTO|SET|FROM|ON|ALL)\b/i);
});

test('el script de reconciliación solo invoca psql y genera un informe local', async () => {
  const script = await read('scripts/release/reconcile-readonly.sh');
  assert.match(script, /default_transaction_read_only=on/);
  assert.match(script, /reconciliation-readonly\.sql/);
  assert.match(script, /render-reconciliation-report\.mjs/);
  assert.doesNotMatch(script, /\bsupabase\s+(?:db\s+push|db\s+reset|migration\s+repair|functions\s+deploy)\b/);
});

test('el respaldo usa el destino explícito CLI v3 y registra el ledger sin restaurarlo', async () => {
  const backup = await read('scripts/backup/create-backup.sh');
  const workflow = await read('.github/workflows/backup-database.yml');
  const restore = await read('scripts/backup/restore-to-isolated.sh');
  assert.match(backup, /supabase db dump --remote="\$NR_BACKUP_DATABASE_URL"/);
  assert.match(backup, /read_migration_history/);
  assert.match(backup, /migrationHistory/);
  assert.match(backup, /migration-ledger-identical-before-and-after-export/);
  assert.match(workflow, /supabase\/setup-cli@689adcfb80d947100a1eab127289b97d1fb07b13/);
  assert.match(workflow, /version: 3\.0\.0/);
  assert.match(restore, /manifest\.migrationHistory !== undefined/);
  assert.match(restore, /production_ref='tiqbmuubpbmxqvtkcdhq'/);
  assert.doesNotMatch(restore, /INSERT\s+INTO\s+supabase_migrations\.schema_migrations/i);
});

test('exportar el esquema remoto usa --remote con URL explícita en CLI v3', async () => {
  const workflow = await read('.github/workflows/export-schema.yml');
  assert.match(workflow, /supabase\/setup-cli@689adcfb80d947100a1eab127289b97d1fb07b13/);
  assert.match(workflow, /supabase db dump --remote="\$NR_SCHEMA_SOURCE_DATABASE_URL"/);
  assert.doesNotMatch(workflow, /supabase db dump --db-url/);
});

test('README y arquitectura no afirman que E2EE esté activo', async () => {
  const readme = await read('README.md');
  const architecture = await read('docs/E2EE_ARCHITECTURE.md');
  assert.match(readme, /E2EE todavía no está implementado/i);
  assert.match(architecture, /El proyecto todavía no tiene cifrado de extremo a extremo/i);
  assert.match(architecture, /no activar E2EE parcialmente/i);
});
