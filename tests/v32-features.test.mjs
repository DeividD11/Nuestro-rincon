import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = path => readFile(new URL(path, import.meta.url), 'utf8');

test('al volver a Borradores el borrador local aparece antes de completar la sincronización remota', async () => {
  const navigation = await read('../assets/js/controllers/navigation-controller.js');
  const view = await read('../assets/js/views/correspondence-view.js');
  const sync = await read('../assets/js/services/draft-sync-service.js');
  assert.match(navigation, /state\.localDraftPreview\s*=\s*\{/);
  assert.match(navigation, /route === 'drafts'[\s\S]*?localDraftPreview/);
  assert.match(view, /localDraftPreview/);
  assert.match(view, /edit-local-draft/);
  assert.match(sync, /const preview = controller\.state\.localDraftPreview/);
});

test('el modal fija el fondo y reserva el desplazamiento vertical al contenido del diálogo', async () => {
  const css = await read('../assets/css/app.css');
  const controller = await read('../assets/js/controllers/letter-controller.js');
  const dom = await read('../assets/js/utils/dom.js');
  assert.match(css, /\.modal-backdrop[\s\S]*?position:\s*fixed\s*!important/);
  assert.match(css, /\.modal-backdrop[\s\S]*?overflow:\s*hidden\s*!important/);
  assert.match(css, /\.modal-card, \.nr-dialog[\s\S]*?overflow-y:\s*auto/);
  assert.match(css, /overscroll-behavior-y:\s*contain/);
  assert.match(controller, /document\.body\.style\.position\s*=\s*'fixed'/);
  assert.match(controller, /modal\.addEventListener\('touchmove'/);
  assert.match(dom, /backdrop\.addEventListener\('wheel'/);
});

test('la vista de carta mejora la legibilidad del modal y adapta las imágenes al ancho', async () => {
  const css = await read('../assets/css/app.css');
  assert.match(css, /\.modal-card \.letter-body[\s\S]*?line-height:\s*1\.9/);
  assert.match(css, /\.letter-body img, \.letter-editor img[\s\S]*?max-width:\s*100%/);
  assert.match(css, /\.letter-body img[\s\S]*?max-height:\s*min\(720px, 72vh\)/);
  assert.match(css, /@media \(max-width: 720px\)[\s\S]*?\.letter-body img[\s\S]*?max-height:\s*58vh/);
});

test('las imágenes de carta se limitan a formatos rasterizados y se optimizan antes de subir', async () => {
  const processor = await read('../assets/js/services/image-processing.js');
  const editor = await read('../assets/js/controllers/draft-controller.js');
  const view = await read('../assets/js/views/correspondence-view.js');
  const api = await read('../supabase/functions/letters-api/index.ts');
  assert.match(processor, /image\/jpeg/);
  assert.match(processor, /image\/png/);
  assert.match(processor, /image\/webp/);
  assert.match(processor, /createImageBitmap|\.decode\(\)/);
  assert.match(editor, /existingCount >= 6/);
  assert.match(editor, /prepareImageFile/);
  assert.match(editor, /data-image-path/);
  assert.match(view, /letter-image-input/);
  assert.match(api, /LETTER_MEDIA_PATH/);
  assert.match(api, /validateLetterImages/);
  assert.match(api, /max.*6|paths\.length > 6/);
});

test('Storage de medios es privado y el servidor firma subida y lectura sin exponer la clave', async () => {
  const storage = await read('../supabase/functions/_shared/storage.ts');
  const api = await read('../supabase/functions/letters-api/index.ts');
  const config = await read('../assets/js/config/app-config.js');
  const html = await read('../index.html');
  assert.match(storage, /const BUCKET = 'private-media'/);
  assert.match(storage, /object\/upload\/sign/);
  assert.match(storage, /object\/sign/);
  assert.match(storage, /SUPABASE_SECRET_KEYS|SUPABASE_SERVICE_ROLE_KEY/);
  assert.match(storage, /headers\.delete\('Authorization'\)/);
  assert.match(storage, /if \(legacyJwt\) headers\.set\('Authorization'/);
  assert.match(api, /case 'media:prepare-upload'/);
  assert.match(api, /case 'media:sign-letter-image'/);
  assert.doesNotMatch(config, /SERVICE_ROLE|SECRET_KEYS|service_role/i);
  assert.match(html, /img-src 'self' data: blob: https:\/\/tiqbmuubpbmxqvtkcdhq\.supabase\.co/);
});

test('el avatar se selecciona desde el dispositivo y el backend lo limita al propietario', async () => {
  const settings = await read('../assets/js/views/settings-view.js');
  const controller = await read('../assets/js/controllers/settings-controller.js');
  const api = await read('../supabase/functions/letters-api/index.ts');
  const migration = await read('../supabase/migrations/20261123193000_private_media_and_profile_avatars.sql');
  assert.match(settings, /id="profile-avatar-input"/);
  assert.match(settings, /data-action="remove-profile-avatar"/);
  assert.match(controller, /async uploadProfileAvatar/);
  assert.match(controller, /async removeProfileAvatar/);
  assert.match(api, /profileAvatarPathIsValid/);
  assert.match(api, /case 'profile:avatar:set'/);
  assert.match(api, /case 'profile:avatar:remove'/);
  assert.match(migration, /add column if not exists avatar_path text/);
  assert.match(migration, /user_profiles_avatar_path_owner_ck/);
  assert.doesNotMatch(migration, /insert into storage\.|update storage\.|delete from storage\./i);
});

test('la revocación masiva excluye siempre la sesión actual y revoca tokens refresh y push', async () => {
  const view = await read('../assets/js/views/settings-view.js');
  const click = await read('../assets/js/controllers/app-click-handler.js');
  const api = await read('../supabase/functions/letters-api/index.ts');
  const migration = await read('../supabase/migrations/20261123205422_revoke_other_app_sessions_atomically.sql');
  const lifecycle = await read('../assets/js/controllers/session-lifecycle-controller.js');
  assert.match(view, /sessions\.some\(item => !item\.isCurrent\)[\s\S]*?data-action="revoke-other-sessions"/);
  assert.match(click, /case 'revoke-other-sessions'/);
  assert.doesNotMatch(click, /if \(!otherCount\) break/);
  assert.match(click, /incluidas las que hayan caducado/);
  assert.match(api, /case 'sessions:revoke-others'/);
  assert.match(api, /p_current_session_id: session\.sessionId/);
  assert.match(api, /revoke_other_app_sessions/);
  assert.match(api, /revokedCount: Number\.isSafeInteger\(Number\(revokedCount\)\)/);
  assert.match(migration, /user_session_refresh_tokens/);
  assert.match(migration, /push_subscriptions/);
  assert.match(lifecycle, /sessions-revoked-except-current/);
});

test('la documentación explica el nuevo bucket, límites y publicación coordinada', async () => {
  const readme = await read('../README.md');
  const guide = await read('../docs/MEDIA_AND_AVATARS.md');
  const baseline = await read('../docs/REMOTE_BASELINE.md');
  assert.match(readme, /docs\/MEDIA_AND_AVATARS\.md/);
  assert.match(guide, /private-media/);
  assert.match(guide, /letters-api` v11/);
  assert.match(guide, /No es necesario desplegar `auth-api`/);
  assert.match(baseline, /public\.user_profiles[\s\S]*?avatar_path/);
  assert.match(baseline, /private-media/);
});
