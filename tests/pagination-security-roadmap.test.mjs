import test from 'node:test';
import { readAppViewSource } from './helpers/view-source.mjs';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = path => readFile(new URL(path, import.meta.url), 'utf8');
import { readControllerSource } from './helpers/controller-source.mjs';

test('el borrado compartido deja de depender de la confirmación de una cuenta deshabilitada', async () => {
  const migration = await read('../supabase/migrations/20261120173200_fix_orphaned_purge_and_list_pagination.sql');
  assert.match(migration, /active_user\.status = 'active'/);
  assert.match(migration, /purge_shared_letters_after_account_disabled/);
  assert.match(migration, /after update of status on public\.app_users/);
  assert.match(migration, /select public\.purge_shared_letters_without_active_confirmation\(null\)/);
  assert.match(migration, /v_confirmed_count < v_active_count/);
  const pgTap = await read('../supabase/tests/shared_letter_purge.test.sql');
  assert.match(pgTap, /plan\(20\)/);
  assert.match(pgTap, /delete from public\.letter_user_state[\s\S]*update public\.app_users set status = 'disabled'/);
  assert.match(pgTap, /la confirmación pendiente no deja la carta bloqueada/);
});

test('las respuestas RPC de creación de borrador tienen un contrato explícito y se validan', async () => {
  const source = await read('../supabase/functions/letters-api/index.ts');
  assert.match(source, /type CreateDraftRpcRecord = \{\s*id: string;/);
  assert.match(source, /type CreateDraftRpcResult = \{/);
  assert.match(source, /function parseCreateDraftRpcResult\(value: unknown\): CreateDraftRpcResult/);
  assert.match(source, /const raw = await rpc<unknown>\('create_letter_draft'/);
  assert.match(source, /const data = parseCreateDraftRpcResult\(raw\);[\s\S]*const draftId = draft\?\.id/);
});

test('GitHub Actions ejecuta el chequeo Deno/TypeScript antes de publicar Pages', async () => {
  const packageJson = JSON.parse(await read('../package.json'));
  const workflow = await read('../.github/workflows/pages.yml');
  assert.match(packageJson.scripts['check:edge'], /^deno check --config=/);
  assert.match(workflow, /uses: denoland\/setup-deno@22d081ff2d3a40755e97629de92e3bcbfa7cf2ed/);
  assert.match(workflow, /run: npm run check:edge/);
  assert.ok(workflow.indexOf('npm run check:edge') < workflow.indexOf('actions/deploy-pages@f33f41b675f0ab2dc5a6863c9a170fe83af3571e'));
});

test('las carpetas se consultan con búsqueda y paginación en PostgreSQL', async () => {
  const migration = await read('../supabase/migrations/20261120173200_fix_orphaned_purge_and_list_pagination.sql');
  const api = await read('../supabase/functions/letters-api/index.ts');
  assert.match(migration, /create or replace function public\.list_user_letters/);
  assert.match(migration, /p_offset integer default 0/);
  assert.match(migration, /p_limit integer default 40/);
  assert.match(migration, /strpos\(lower\(coalesce\(l\.title/);
  assert.match(migration, /order by sort_at desc nulls last, id desc/);
  assert.match(migration, /'purge_confirmed_at', p\.purge_confirmed_at/);
  assert.match(migration, /'hasMore', p_offset \+ jsonb_array_length\(v_items\) < v_total/);
  assert.match(api, /rpc<unknown>\('list_user_letters'/);
  assert.doesNotMatch(api, /selectRows<Record<string, unknown>>\('letters',[\s\S]{0,900}\n\s*rows = rows\.filter/);
});

test('hilos y notificaciones admiten páginas progresivas con orden fecha e ID', async () => {
  const core = await read('../supabase/functions/_shared/core.ts');
  const api = await read('../supabase/functions/letters-api/index.ts');
  const controller = await readControllerSource();
  const view = await readAppViewSource();
  assert.match(core, /export async function selectCursorPageRows/);
  assert.match(api, /selectCursorPageRows<Record<string, unknown>>\('letters',[\s\S]*'sent_at'/);
  assert.match(api, /selectCursorPageRows<Record<string, unknown>>\('notifications',[\s\S]*'created_at'/);
  assert.match(api, /threadHasMore/);
  assert.match(controller, /async loadMoreLetters\(/);
  assert.match(controller, /async loadMoreNotifications\(/);
  assert.match(controller, /async loadOlderThread\(/);
  assert.match(view, /data-pagination-sentinel/);
  assert.match(view, /load-older-thread/);
});

test('la documentación E2EE no presenta como cifrado un contenido que sigue en claro', async () => {
  const doc = await read('../docs/E2EE_ARCHITECTURE.md');
  assert.match(doc, /todavía no tiene cifrado de extremo a extremo/i);
  assert.match(doc, /AES-256-GCM/);
  assert.match(doc, /RFC 9180/);
  assert.match(doc, /frase de cifrado independiente/);
  assert.match(doc, /búsqueda textual tendrá que ejecutarse en el cliente/);
  assert.match(doc, /La pérdida simultánea de la clave privada y de su respaldo/);
});


test('las carpetas usan paginación keyset fecha+UUID sin COUNT exacto ni OFFSET', async () => {
  const migration = await read('../supabase/migrations/20261121210000_cursor_based_letter_pagination.sql');
  const api = await read('../supabase/functions/letters-api/index.ts');
  const core = await read('../supabase/functions/_shared/core.ts');
  const repository = await read('../assets/js/repositories/letter-repository.js');
  assert.match(migration, /create or replace function public\.list_user_letters_cursor/);
  assert.match(migration, /\(e\.sort_at, e\.id\) < \(p_cursor_sort_at, p_cursor_id\)/);
  assert.match(migration, /limit p_limit \+ 1/);
  assert.doesNotMatch(migration, /eligible as materialized/i);
  assert.match(migration, /select count\(\*\) > p_limit from page_candidates/);
  assert.doesNotMatch(migration, /offset p_offset/i);
  assert.match(migration, /revoke execute[\s\S]*from public, anon, authenticated/i);
  assert.match(migration, /grant execute[\s\S]*to service_role/i);
  assert.match(core, /selectCursorPageRows/);
  assert.match(api, /rpc<unknown>\('list_user_letters_cursor'/);
  assert.match(api, /selectCursorPageRows<Record<string, unknown>>\('notifications'/);
  assert.match(repository, /list\(folder = 'inbox', search = '', cursor = null/);
  assert.doesNotMatch(migration, /count\(\*\)::bigint as total/);
  assert.doesNotMatch(api.slice(api.indexOf("case 'notifications':"), api.indexOf("case 'notification:read':")), /count=exact|offset/);
});


test('el cliente mantiene cursores y ya no presenta totales exactos por página', async () => {
  const navigation = await read('../assets/js/controllers/navigation-controller.js');
  const view = await readAppViewSource();
  const notification = await read('../assets/js/controllers/notification-controller.js');
  assert.match(navigation, /const cursor = pagination\.cursor/);
  assert.match(navigation, /repository\.list\(route, search, cursor/);
  assert.match(navigation, /repository\.notifications\(cursor/);
  assert.match(navigation, /threadNextCursor/);
  assert.match(view, /loaded} cargadas/);
  assert.doesNotMatch(view, /loaded} de \$\{total/);
  assert.match(notification, /cursor: result\.nextCursor/);
});
