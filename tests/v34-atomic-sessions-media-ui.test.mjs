import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = path => readFile(new URL(path, import.meta.url), 'utf8');

test('la preparación de Storage crea y verifica un bucket privado, con MIME y tamaño permitidos', async () => {
  const storage = await read('../supabase/functions/_shared/storage.ts');
  assert.match(storage, /ensurePrivateMediaBucket/);
  assert.match(storage, /GET/);
  assert.match(storage, /method:\s*'POST'/);
  assert.match(storage, /method:\s*'PUT'/);
  assert.match(storage, /public:\s*false/);
  assert.match(storage, /file_size_limit:\s*BUCKET_LIMIT_BYTES/);
  assert.match(storage, /image\/jpeg/);
  assert.match(storage, /image\/png/);
  assert.match(storage, /image\/webp/);
  assert.match(storage, /await ensurePrivateMediaBucket\(\)/);
  assert.doesNotMatch(storage, /from\s+['"]\.\/[^'"]*storage\.buckets|insert into storage\.buckets/i);
});

test('el backend clasifica las operaciones de medios como seguridad y utiliza una RPC para la revocación', async () => {
  const api = await read('../supabase/functions/letters-api/index.ts');
  assert.match(api, /media:prepare-upload/);
  assert.match(api, /media:sign-letter-image/);
  assert.match(api, /sessions:revoke-others/);
  assert.match(api, /revoke_other_app_sessions/);
  assert.match(api, /p_current_session_id:\s*session\.sessionId/);
  const revoke = api.slice(api.indexOf("case 'sessions:revoke-others':"), api.indexOf("case 'session:revoke':"));
  assert.doesNotMatch(revoke, /while\s*\(|for\s*\(/);
});

test('la migración hace la revocación atómica y mantiene la sesión actual', async () => {
  const migration = await read('../supabase/migrations/20261123205422_revoke_other_app_sessions_atomically.sql');
  assert.match(migration, /security invoker/i);
  assert.match(migration, /s\.id <> p_current_session_id/);
  assert.match(migration, /revocation_reason = 'user_revoked_all_other_sessions'/);
  assert.match(migration, /access_token_hash = null/);
  assert.match(migration, /user_session_refresh_tokens/);
  assert.match(migration, /delete from public\.push_subscriptions/);
  assert.match(migration, /revoke all[\s\S]*from public, anon, authenticated/i);
  assert.match(migration, /grant execute[\s\S]*to service_role/i);
  assert.match(migration, /push_subscriptions_session_id_idx/);
});

test('la interfaz elimina filas sin reconstruir la página, restaura el estado en caso de error y conserva el anclaje visual', async () => {
  const controller = await read('../assets/js/controllers/app-click-handler.js');
  const block = controller.slice(controller.indexOf("case 'revoke-other-sessions':"), controller.indexOf("case 'revoke-session':"));
  assert.match(block, /this\.state\.sessions = originalSessions\.filter\(item => item\.isCurrent\)/);
  assert.match(block, /session-row:not\(\.is-current\)/);
  assert.match(block, /sessionList\.innerHTML = originalListMarkup/);
  assert.match(block, /getBoundingClientRect\(\)\.top/);
  assert.match(block, /window\.scrollTo\(/);
  assert.doesNotMatch(block, /this\.render\(|refreshSessions\(|repository\.revokeSession\(/);
});

test('el botón para insertar imágenes tiene icono SVG, etiqueta y estados de foco/tema', async () => {
  const view = await read('../assets/js/views/correspondence-view.js');
  const css = await read('../assets/css/app.css');
  assert.match(view, /class="tool-btn image-tool-btn"[\s\S]*?<svg class="image-tool-icon"/);
  assert.match(view, /<span>Imagen<\/span>/);
  assert.match(css, /\.image-tool-btn\{[^}]*min-height:38px/);
  assert.match(css, /\.image-tool-btn:focus-visible/);
  assert.match(css, /html\[data-theme="dark"\] \.image-tool-btn/);
});


test('letters-api importa web-push 4 mediante sus exports ESM nombrados', async () => {
  const api = await read('../supabase/functions/letters-api/index.ts');
  assert.match(api, /^import \{\s*sendNotification,\s*setVapidDetails\s*\} from ['\"]web-push['\"];$/m);
  assert.doesNotMatch(api, /import\s+\w+\s+from\s+['\"]web-push['\"]/);
  assert.match(api, /setVapidDetails\(config\.subject, config\.publicKey, config\.privateKey\)/);
  assert.match(api, /await sendNotification\(/);
});
