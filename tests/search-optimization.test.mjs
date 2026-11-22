import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = path => readFile(new URL(path, import.meta.url), 'utf8');

test('la búsqueda keyset conserva subcadena literal y normaliza el cuerpo una sola vez', async () => {
  const migration = await read('../supabase/migrations/20261121210000_cursor_based_letter_pagination.sql');
  assert.match(migration, /create or replace function public\.normalize_letter_search_body\(p_body text\)/);
  assert.match(migration, /immutable[\s\S]*parallel safe/);
  assert.match(migration, /replace\(replace\(lower\(btrim\(coalesce\(p_search, ''\)\)\), E'\\\\', E'\\\\\\\\'\), '%', E'\\\\%'\)/);
  assert.match(migration, /'_', E'\\\\_'/);
  assert.match(migration, /lower\(coalesce\(l\.title, ''\)\) like v_search_pattern escape E'\\\\'/);
  assert.match(migration, /normalize_letter_search_body\(l\.body\) like v_search_pattern escape E'\\\\'/);
  assert.match(migration, /revoke execute on function public\.normalize_letter_search_body\(text\) from public, anon, authenticated/i);
  assert.match(migration, /grant execute on function public\.normalize_letter_search_body\(text\) to service_role/i);
  assert.doesNotMatch(migration, /strpos\(public\.normalize_letter_search_body/);
});

test('los candidatos pg_trgm y EXPLAIN están separados de las migraciones', async () => {
  const candidate = await read('../supabase/performance/search-trigram-candidate.sql');
  const benchmark = await read('../supabase/performance/search-benchmark.sql');
  assert.match(candidate, /CANDIDATO DE BENCHMARK; NO ES UNA MIGRACIÓN/i);
  assert.match(candidate, /create index concurrently if not exists letters_title_trgm_idx/i);
  assert.match(candidate, /gin_trgm_ops/i);
  assert.match(candidate, /normalize_letter_search_body\(body\)/);
  assert.match(benchmark, /explain \(analyze, buffers, settings, format json\)/i);
  assert.match(benchmark, /letter_user_state/);
  assert.match(benchmark, /pg_trgm no suele ayudar[\s\S]*patrones que no permiten extraer trigramas/i);
});

test('pgTAP compara el normalizador nuevo con el legado y cubre comodines literales', async () => {
  const pgTap = await read('../supabase/tests/search_semantics.test.sql');
  assert.match(pgTap, /plan\(18\)/);
  assert.match(pgTap, /normalizador conserva el HTML normalizado/);
  assert.match(pgTap, /LIKE mantiene la semántica literal de strpos/);
  assert.match(pgTap, /100% nuestro/);
  assert.match(pgTap, /A_B/);
  assert.match(pgTap, /ruta\\\\carta/);
  assert.match(pgTap, /select \* from finish\(\);[\s\S]*rollback;/);
  const runner = await read('../scripts/run-db-tests.mjs');
  assert.match(runner, /supabase\/tests\/search_semantics\.test\.sql/);
});
