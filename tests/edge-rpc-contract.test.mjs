import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const root = new URL('../', import.meta.url);
const manifest = JSON.parse(await readFile(new URL('supabase/diagnostics/edge-rpc-contract.json', root), 'utf8'));
const sourceFiles = [
  'supabase/functions/auth-api/index.ts',
  'supabase/functions/letters-api/index.ts'
];

function extractRpcNames(source) {
  return [...new Set([...source.matchAll(/\brpc(?:<[^;\n]*>+)?\s*\(\s*['"]([^'"]+)['"]/g)].map(match => match[1]))].sort();
}

test('el contrato RPC cubre exactamente todas las llamadas de las Edge Functions', async () => {
  const sourceNames = [];
  for (const file of sourceFiles) sourceNames.push(...extractRpcNames(await readFile(new URL(file, root), 'utf8')));
  const manifestNames = manifest.functions.map(item => item.name).sort();
  assert.deepEqual([...new Set(sourceNames)].sort(), manifestNames);
  assert.equal(new Set(manifestNames).size, manifestNames.length, 'no hay funciones RPC duplicadas en el contrato');
});

test('el contrato requiere invoker, grants mínimos y search_path fijado', () => {
  assert.deepEqual(manifest.principles, {
    securityDefiner: false,
    anonExecute: false,
    authenticatedExecute: false,
    serviceRoleExecute: true,
    searchPath: 'pg_catalog, public'
  });
  for (const item of manifest.functions) {
    assert.match(item.name, /^[a-z][a-z0-9_]+$/);
    assert.match(item.arguments, /^p_[a-z0-9_]+ .+$/);
  }
});

test('la cola de limpieza de Storage solo usa dos RPC nuevas en service_role', async () => {
  const sql = await readFile(new URL('supabase/migrations/20261125010000_private_media_cleanup_queue.sql', root), 'utf8');
  assert.match(sql, /create table if not exists public\.private_media_cleanup_jobs/);
  assert.match(sql, /alter table public\.private_media_cleanup_jobs enable row level security/);
  assert.match(sql, /grant execute on function public\.claim_private_media_cleanup_jobs\(integer, timestamptz\) to service_role/);
  assert.match(sql, /grant execute on function public\.finish_private_media_cleanup_job\(uuid, boolean, text, timestamptz\) to service_role/);
  assert.match(sql, /grant execute on function public\.enqueue_private_media_cleanup_from_html\(text\) to service_role/);
  assert.doesNotMatch(sql, /grant execute[^;]+to anon|grant execute[^;]+to authenticated/i);
  assert.match(sql, /for update skip locked/);
  assert.match(sql, /letter_versions/);
});
