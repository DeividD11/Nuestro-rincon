import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = path => readFile(new URL(path, import.meta.url), 'utf8');

test('avatars e imágenes de cartas utilizan el mismo cliente de carga privada con diagnóstico HTTP', async () => {
  const helper = await read('../assets/js/services/private-media-upload.js');
  const settings = await read('../assets/js/controllers/settings-controller.js');
  const drafts = await read('../assets/js/controllers/draft-controller.js');
  assert.match(helper, /method:\s*'PUT'/);
  assert.match(helper, /credentials:\s*'omit'/);
  assert.match(helper, /MEDIA_UPLOAD_HTTP_/);
  assert.match(helper, /target\.origin !== expectedOrigin/);
  assert.match(settings, /uploadPrivateMedia\(media\.uploadUrl, image\)/);
  assert.match(drafts, /uploadPrivateMedia\(media\.uploadUrl, processed\)/);
  assert.doesNotMatch(settings, /fetch\(media\.uploadUrl/);
  assert.doesNotMatch(drafts, /fetch\(media\.uploadUrl/);
});

test('el avatar de la barra lateral siempre ocupa span.avatar y representa la imagen guardada o su vista previa', async () => {
  const view = await read('../assets/js/views/app-view.js');
  const controller = await read('../assets/js/controllers/settings-controller.js');
  assert.match(view, /state\.profile\?\.previewUrl \|\| state\.profile\?\.avatarUrl/);
  assert.match(view, /class="avatar has-image is-loading"/);
  assert.match(view, /class="avatar" aria-hidden="true"/);
  assert.match(controller, /container\.classList\.add\('has-image'\)/);
  assert.match(controller, /container\.replaceChildren\(placeholder, image\)/);
  assert.match(controller, /avatarNodeCache\?\.adopt/);
});

test('el encabezado de sección ya no dibuja el recuadro de acento al recibir el foco programático', async () => {
  const css = await read('../assets/css/accessibility.css');
  assert.match(css, /#page-heading:focus[\s\S]*?outline: 0 !important;[\s\S]*?box-shadow: none !important;/);
  assert.doesNotMatch(css, /\.topbar h1:focus\s*\{\s*outline:\s*2px solid/);
});

test('el botón de revocación masiva solo se renderiza cuando hay al menos otra sesión', async () => {
  const view = await read('../assets/js/views/settings-view.js');
  assert.match(view, /sessions\.some\(item => !item\.isCurrent\)\s*\?\s*'<button[^']*revoke-other-sessions/s);
  assert.doesNotMatch(view, /sessions\.some\(item => item\.isCurrent\)\s*\?\s*'<button[^']*revoke-other-sessions/s);
});

test('el botón de imagen pasa a icono compacto en móviles y conserva su nombre accesible', async () => {
  const view = await read('../assets/js/views/correspondence-view.js');
  const css = await read('../assets/css/app.css');
  assert.match(view, /class="tool-btn image-tool-btn"[^>]*aria-label="Insertar imagen en la carta"/);
  assert.match(css, /@media \(max-width: 440px\)[\s\S]*?\.app-shell \.image-tool-btn > span \{ display:none !important; \}/);
  assert.match(css, /\.app-shell \.image-tool-btn \{ width:44px; min-width:44px; min-height:44px;/);
});

test('guardar borrador navega automáticamente a Borradores cuando existe una copia segura', async () => {
  const controller = await read('../assets/js/controllers/app-click-handler.js');
  const block = controller.slice(controller.indexOf("case 'save-draft':"), controller.indexOf("case 'preview-send':"));
  assert.match(block, /const result = await this\.saveDraft\(false\)/);
  assert.match(block, /\['saved', 'created', 'local'\]\.includes\(result\?\.status\)/);
  assert.match(block, /this\.openRoute\('drafts', true, \{ focus: true, skipHistory: true \}\)/);
  assert.doesNotMatch(block, /if \(!isReply/);
  assert.match(block, /this\.openRoute\('drafts', true, \{ focus: true, skipHistory: true \}\)/);
});

test('Revisar y enviar abre el modal sin redirigir a Escribir carta', async () => {
  const controller = await read('../assets/js/controllers/letter-controller.js');
  const block = controller.slice(controller.indexOf('async openLetterForSend'), controller.indexOf('async editLocalDraft'));
  assert.match(block, /this\.repository\.get\(letterId\)/);
  assert.match(block, /this\.state\.editor =/);
  assert.match(block, /await this\.previewSend\(\)/);
  assert.doesNotMatch(block, /await this\.editDraft\(/);
  assert.doesNotMatch(block, /this\.state\.route = 'write'/);
  assert.doesNotMatch(block, /history\.replaceState\([^\n]*#\/write/);
});

test('la migración configura private-media como bucket privado, con MIME permitidos y límite de cinco MiB', async () => {
  const migration = await read('../supabase/migrations/20261124052017_ensure_private_media_bucket.sql');
  assert.match(migration, /insert into storage\.buckets/i);
  assert.match(migration, /'private-media'[\s\S]*?false[\s\S]*?5242880/s);
  assert.match(migration, /image\/jpeg/);
  assert.match(migration, /image\/png/);
  assert.match(migration, /image\/webp/);
  assert.match(migration, /on conflict \(id\) do update/i);
});

test('la Edge Function registra una causa de error de medios sin registrar contenido privado', async () => {
  const api = await read('../supabase/functions/letters-api/index.ts');
  const core = await read('../supabase/functions/_shared/core.ts');
  const storage = await read('../supabase/functions/_shared/storage.ts');
  assert.ok(api.includes("const diagnostic = message.split(':')[0]"));
  assert.match(api, /console\.error\('letters-api error', mapped\.code, diagnostic\)/);
  assert.match(storage, /MEDIA_STORAGE_HTTP_\$\{response\.status\}/);
  assert.match(storage, /MEDIA_STORAGE_NETWORK_ERROR/);
  assert.match(core, /code\.startsWith\('MEDIA_STORAGE_HTTP_'\)/);
});
