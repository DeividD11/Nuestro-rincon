import test from 'node:test';
import { readAppViewSource } from './helpers/view-source.mjs';
import assert from 'node:assert/strict';
import { readCssBundle } from './helpers/style-source.mjs';
import { readFile } from 'node:fs/promises';

const read = path => readFile(new URL(path, import.meta.url), 'utf8');
import { readControllerSource } from './helpers/controller-source.mjs';

test('la app no invoca Supabase Auth', async () => {
  const files = [
    '../assets/js/app.js',
    '../assets/js/services/api-client.js',
    '../assets/js/controllers/app-controller.js',
    '../supabase/functions/auth-api/index.ts',
    '../supabase/functions/letters-api/index.ts',
    '../supabase/functions/_shared/core.ts'
  ];
  for (const file of files) {
    const source = await read(file);
    assert.doesNotMatch(source, /supabase\.auth\.(signUp|signInWithPassword|signOut)/i, file);
  }
});

test('el frontend contiene solo credenciales públicas y no un secreto de servidor', async () => {
  const source = await read('../assets/js/config/app-config.js');
  assert.match(source, /sb_publishable_/);
  assert.doesNotMatch(source, /sb_secret_|service_role|APP_JWT_SECRET|APP_BOOTSTRAP_SECRET/i);
});

test('la interfaz y el backend usan las dos Edge Functions incluidas', async () => {
  const config = await read('../assets/js/config/app-config.js');
  const auth = await read('../supabase/functions/auth-api/index.ts');
  const letters = await read('../supabase/functions/letters-api/index.ts');
  assert.match(config, /authFunction:\s*'auth-api'/);
  assert.match(config, /lettersFunction:\s*'letters-api'/);
  assert.match(auth, /Deno\.serve/);
  assert.match(letters, /Deno\.serve/);
});

test('el sitio declara CSP y el flujo de despliegue de Pages', async () => {
  const html = await read('../index.html');
  const workflow = await read('../.github/workflows/pages.yml');
  assert.match(html, /Content-Security-Policy/);
  assert.match(workflow, /actions\/deploy-pages@f33f41b675f0ab2dc5a6863c9a170fe83af3571e/);
  assert.match(workflow, /path: \.\/_site/);
});

test('el backend habilita CORS sin cookies y exige sesión propia para datos privados', async () => {
  const core = await read('../supabase/functions/_shared/core.ts');
  const letters = await read('../supabase/functions/letters-api/index.ts');
  assert.match(core, /Access-Control-Allow-Origin/);
  assert.match(core, /'\*'/);
  assert.match(core, /Access-Control-Allow-Methods/);
  assert.match(core, /access_token_hash/);
  assert.match(core, /user_sessions/);
  assert.match(letters, /requireSession\(req\)/);
});


test('la carta puede descargarse como HTML UTF-8 sin scripts activos', async () => {
  const controller = await readControllerSource();
  const view = await readAppViewSource();
  assert.match(controller, /async downloadHtml\(letterId\)/);
  assert.match(controller, /text\/html;charset=utf-8/);
  assert.match(controller, /sanitizeRichHtml\(letter\.body/);
  assert.match(view, /data-action=\"download-html\"/);
});


test('la instantánea del esquema se obtiene del historial real y no de un esquema supuesto', async () => {
  const schemaReadme = await read('../supabase/schema/README.md');
  const projectReadme = await read('../README.md');
  assert.match(schemaReadme, /supabase db dump --remote="\$NR_SCHEMA_SOURCE_DATABASE_URL"/);
  assert.doesNotMatch(schemaReadme, /supabase db dump --linked/);
  assert.match(projectReadme, /25 migraciones/);
  assert.match(projectReadme, /letters-api` v11/);
});


test('la raíz del repositorio contiene la entrada web y Pages construye solo el sitio estático', async () => {
  const html = await read('../index.html');
  const build = await read('../scripts/build-pages.mjs');
  const workflow = await read('../.github/workflows/pages.yml');
  assert.match(html, /assets\/js\/app\.js/);
  assert.match(build, /index\.html/);
  assert.match(build, /assets/);
  assert.match(workflow, /run: npm run build:pages/);
  assert.match(workflow, /actions\/configure-pages@45bfe0192ca1faeb007ade9deae92b16b8254a0d/);
  assert.match(workflow, /run: npm test/);
  assert.match(workflow, /path: \.\/_site/);
});

test('el registro no requiere correo ni secretos de instalación', async () => {
  const view = await readAppViewSource();
  const controller = await readControllerSource();
  const session = await read('../assets/js/services/session-service.js');
  const api = await read('../assets/js/services/api-client.js');
  const auth = await read('../supabase/functions/auth-api/index.ts');
  assert.match(view, /id="register-form"/);
  assert.match(view, /data-action="show-register"/);
  const registerStart = view.indexOf('id="register-form"');
  const registerEnd = view.indexOf('</form>', registerStart);
  const registerMarkup = view.slice(registerStart, registerEnd);
  assert.doesNotMatch(registerMarkup, /type="email"|name="email"|bootstrapSecret|Clave de instalación/);
  assert.match(controller, /form\.id === 'register-form'/);
  assert.match(session, /async register\(account\)/);
  assert.match(api, /'register'/);
  assert.match(auth, /action === 'register'/);
  assert.match(registerMarkup, /name="invitationCode"/);
  assert.match(auth, /register_app_user_with_invite/);
  assert.doesNotMatch(auth, /register_app_user_without_email/);
  assert.match(auth, /recoveryCode/);
});

test('sesiones opacas no necesitan una clave JWT de aplicación', async () => {
  const core = await read('../supabase/functions/_shared/core.ts');
  const auth = await read('../supabase/functions/auth-api/index.ts');
  const migration = await read('../supabase/migrations/20261116055118_opaque_sessions_local_recovery.sql');
  assert.match(core, /access_token_hash/);
  assert.match(core, /access_expires_at/);
  assert.match(core, /sha256Hex\(token\)/);
  assert.doesNotMatch(core, /APP_JWT_SECRET|verifyAccessToken/);
  assert.match(auth, /recover-with-code/);
  assert.match(migration, /register_app_user_without_email/);
  assert.match(migration, /account_limit_reached/);
  assert.match(migration, /grant execute[\s\S]*to service_role/i);
});


test('las Edge Functions responden el preflight CORS sin cuerpo para el estado 204', async () => {
  const auth = await read('../supabase/functions/auth-api/index.ts');
  const letters = await read('../supabase/functions/letters-api/index.ts');
  for (const [name, source] of [['auth-api', auth], ['letters-api', letters]]) {
    assert.match(source, /req\.method === 'OPTIONS'[\s\S]{0,100}new Response\(null, \{ status: 204, headers \}\)/, name);
    assert.doesNotMatch(source, /new Response\(['"]ok['"], \{ status: 204/, name);
  }
  assert.doesNotThrow(() => new Response(null, { status: 204 }));
  assert.throws(() => new Response('ok', { status: 204 }));
});

test('los errores de conexión distinguen falta de red y bloqueo de solicitud', async () => {
  const api = await read('../assets/js/services/api-client.js');
  assert.match(api, /navigator\.onLine === false/);
  assert.match(api, /NETWORK_OFFLINE/);
  assert.match(api, /bloqueo CORS/);
  assert.match(api, /NETWORK_ERROR/);
});

test('form-error dispone de separación y desaparece cuando no contiene texto', async () => {
  const css = await readCssBundle();
  assert.match(css, /\.form-error\{[^}]*margin:16px 0 20px/);
  assert.match(css, /\.form-error:empty\{display:none\}/);
});


test('la navegación precarga secciones y reutiliza una caché breve para evitar esperas repetidas', async () => {
  const controller = await readControllerSource();
  assert.match(controller, /routeCacheTtl = 60000/);
  assert.match(controller, /pointerover/);
  assert.match(controller, /pointerdown/);
  assert.match(controller, /prefetchRoute\(target\.dataset\.route\)/);
  assert.match(controller, /Date\.now\(\) - cached\.at <= this\.routeCacheTtl/);
  assert.match(controller, /const accountId = this\.session\?\.user\?\.id \|\| 'guest'/);
  assert.match(controller, /No retrasar el cambio de sección esperando IndexedDB/);
});

test('las preferencias guardan el tema claro, oscuro o del sistema por usuario', async () => {
  const view = await readAppViewSource();
  const controller = await readControllerSource();
  const api = await read('../supabase/functions/letters-api/index.ts');
  const css = await readCssBundle();
  assert.match(view, /id="settings-theme" name="theme"/);
  assert.match(view, /option value="dark"/);
  assert.match(controller, /cacheTheme\(this\.state\.settings\.theme\)/);
  assert.match(controller, /this\.applyTheme\(this\.state\.settings\.theme\)/);
  assert.match(api, /allowedThemes = new Set\(\['light','dark','system'\]\)/);
  assert.match(api, /theme, time_zone: timeZone/);
  assert.match(css, /html\[data-theme="dark"\]/);
});


test('la navegación muestra carga ligera y ofrece recuperación cuando una sección falla', async () => {
  const view = await readAppViewSource();
  const controller = await readControllerSource();
  assert.match(view, /route-skeleton/);
  assert.doesNotMatch(view, /Abriendo esta sección/);
  assert.match(view, /data-action="retry-route"/);
  assert.match(controller, /routeError = error\.message/);
  assert.match(controller, /routeNotice = 'No pudimos actualizar esta sección/);
});

test('las lecturas tienen tiempo máximo y reintento acotado sin repetir escrituras', async () => {
  const api = await read('../assets/js/services/api-client.js');
  assert.match(api, /requestTimeoutMs = 12000/);
  assert.match(api, /new AbortController\(\)/);
  assert.match(api, /RETRYABLE_READ_ACTIONS/);
  assert.match(api, /safeToRetry: RETRYABLE_READ_ACTIONS\.has\(action\)/);
  assert.match(api, /REQUEST_TIMEOUT/);
  assert.doesNotMatch(api, /'draft:create'|'draft:save'|'draft:send'|'archive'|'trash'|'purge'/);
});

test('Archivo, Borradores y Papelera tienen acciones y mensajes propios', async () => {
  const view = await readAppViewSource();
  const controller = await readControllerSource();
  assert.match(view, /folder-\$\{state\.route\}/);
  assert.match(view, /archive: \['⌑'/);
  assert.match(view, /drafts: \['✎'/);
  assert.match(view, /trash: \['⌫'/);
  assert.match(view, /data-action="toggle-archive"/);
  assert.match(view, /data-action="restore-letter"/);
  assert.match(view, /data-action="purge-letter"/);
  assert.match(controller, /case 'restore-letter'/);
  assert.match(controller, /case 'toggle-archive'/);
});

test('el aviso de notificaciones usa un conmutador accesible y las sesiones son tarjetas completas', async () => {
  const view = await readAppViewSource();
  const css = await readCssBundle();
  assert.match(view, /id="settings-notifications" class="toggle-input" type="checkbox"/);
  assert.match(view, /class="session-list"/);
  assert.match(view, /class="session-row/);
  assert.match(css, /\.toggle-input:focus-visible\+\.toggle-track/);
  assert.match(css, /\.session-row\.is-current/);
});

test('el render real ofrece recuperar un borrador en Papelera y archivar una carta enviada', async () => {
  const { AppView } = await import('../assets/js/views/app-view.js');
  const view = new AppView({});
  const draftTrash = view.renderList({
    route: 'trash', search: '',
    letters: [{ id: '11111111-1111-4111-8111-111111111111', status: 'draft', title: 'Carta temporal', body: '', isInTrash: true, updated_at: '2026-11-16T12:00:00Z' }]
  });
  assert.match(draftTrash, /Elementos descartados/);
  assert.match(draftTrash, /data-action="restore-letter"/);
  assert.match(draftTrash, /data-action="purge-letter"/);

  const inbox = view.renderList({
    route: 'inbox', search: '',
    letters: [{ id: '22222222-2222-4222-8222-222222222222', status: 'sent', title: 'Carta recibida', body: '', isInTrash: false, isArchived: false, isFavorite: false, updated_at: '2026-11-16T12:00:00Z' }]
  });
  assert.match(inbox, /data-action="toggle-archive" data-archived="false"/);

  const archive = view.renderList({
    route: 'archive', search: '',
    letters: [{ id: '33333333-3333-4333-8333-333333333333', status: 'sent', title: 'Carta archivada', body: '', isInTrash: false, isArchived: true, isFavorite: false, updated_at: '2026-11-16T12:00:00Z' }]
  });
  assert.match(archive, /Guardadas aparte/);
  assert.match(archive, /data-action="toggle-archive" data-archived="true"/);
});


test('el tema se aplica antes de los estilos y cubre login, registro y recuperación', async () => {
  const boot = await read('../assets/js/theme-boot.js');
  const html = await read('../index.html');
  const css = await readCssBundle();
  const controller = await readControllerSource();
  assert.match(html, /assets\/js\/theme-boot\.js/);
  assert.match(boot, /nuestro-rincon:theme:last/);
  assert.match(boot, /prefers-color-scheme: dark/);
  assert.match(controller, /this\.systemThemeMedia[\s\S]*applyTheme\('system'\)/);
  assert.match(css, /html\[data-theme="dark"\] \.auth-page/);
  assert.match(css, /html\[data-theme="dark"\] \.auth-card/);
  assert.match(css, /html\[data-theme="dark"\] \.auth-card \.field input/);
});

test('el perfil permite editar nombre, usuario Unicode, email de contacto y contraseña', async () => {
  const auth = await read('../supabase/functions/auth-api/index.ts');
  const core = await read('../supabase/functions/_shared/core.ts');
  const registrationMigration = await read('../supabase/migrations/20261117025358_unicode_usernames_and_system_theme.sql');
  const passwordMigration = await read('../supabase/migrations/20261117030115_secure_profile_and_password_updates.sql');
  const view = new (await import('../assets/js/views/app-view.js')).AppView({});
  const markup = view.renderSettings({
    user: { id: 'u', displayName: 'Nombre', username: 'deivid.ñ+@', email: 'persona@ejemplo.com' },
    settings: { theme: 'system', time_zone: 'America/Bogota', in_app_notifications_enabled: true },
    sessions: []
  });
  assert.match(markup, /id="profile-form"/);
  assert.match(markup, /id="account-form"/);
  assert.match(markup, /id="account-email" name="email" type="email"/);
  assert.match(markup, /id="password-form"/);
  assert.match(markup, /option value="system" selected/);
  assert.match(markup, /no envía correos ni usa el correo para iniciar sesión o recuperar/);
  assert.match(auth, /action === 'account:update'/);
  assert.match(auth, /action === 'password:update'/);
  assert.match(auth, /\\p\{L\}/);
  assert.match(core, /email: user\.email/);
  assert.match(registrationMigration, /normalize\(btrim\(coalesce\(p_username, ''\)\), NFKC\)/);
  assert.match(registrationMigration, /\[\[:alnum:\]\]/);
  assert.match(passwordMigration, /change_app_password/);
  assert.match(passwordMigration, /other_sessions_revoked/);
});

test('el tema sistema es el predeterminado tanto en preferencias como en la API', async () => {
  const state = await read('../assets/js/models/app-state.js');
  const controller = await readControllerSource();
  const letters = await read('../supabase/functions/letters-api/index.ts');
  const migration = await read('../supabase/migrations/20261117025358_unicode_usernames_and_system_theme.sql');
  assert.match(state, /theme: 'system'/);
  assert.match(controller, /formData\.get\('theme'\) \|\| 'system'/);
  assert.match(letters, /body\.theme \|\| 'system'/);
  assert.match(letters, /theme: 'system'/);
  assert.match(migration, /alter column theme set default 'system'/);
});

test('las secciones visitadas mantienen su contenido y no vuelven a mostrar skeleton', async () => {
  const controller = await readControllerSource();
  assert.match(controller, /this\.seenRoutes\.has\(route\)/);
  assert.match(controller, /this\.state\.routeLoading = !hasVisited/);
  assert.match(controller, /Conserva los datos para que la navegación siga siendo inmediata/);
  assert.doesNotMatch(controller, /if \(hasVisited && \['inbox','sent','drafts','favorites','archive','trash'\][\s\S]{0,100}this\.state\.letters = \[\]/);
});


test('el nombre de usuario admite Unicode y símbolos permitidos sin aceptar espacios', async () => {
  const auth = await read('../supabase/functions/auth-api/index.ts');
  assert.match(auth, /normalizeUsername\(value: unknown\)/);
  assert.match(auth, /validUsername\(value: string\)/);
  assert.match(auth, /username_normalized/);
  const allowed = /^[\p{L}\p{N}][\p{L}\p{M}\p{N}._@+-]{2,47}$/u;
  for (const username of ['deivid.ñ_2026', 'áñdrea+cartas', 'persona@dos', 'usuario-2']) assert.equal(allowed.test(username), true, username);
  for (const username of ['deivid ñ', 'ab', 'usuario/', ' usuario']) assert.equal(allowed.test(username), false, username);
});

test('el perfil se sincroniza en las dos tablas y el cambio de contraseña es transaccional', async () => {
  const letters = await read('../supabase/functions/letters-api/index.ts');
  const passwordMigration = await read('../supabase/migrations/20261117030115_secure_profile_and_password_updates.sql');
  const profileMigration = await read('../supabase/migrations/20261120235900_transactional_profile_rename.sql');
  const renameStart = letters.indexOf("case 'profile:rename':");
  const renameEnd = letters.indexOf("case 'sessions':", renameStart);
  const renameAction = letters.slice(renameStart, renameEnd);
  assert.match(renameAction, /rpc<unknown>\('rename_app_profile'/);
  assert.doesNotMatch(renameAction, /Promise\.all|patchRows/);
  assert.match(profileMigration, /update public\.app_users[\s\S]*insert into public\.user_profiles[\s\S]*on conflict \(user_id\) do update/);
  assert.match(profileMigration, /revoke execute[\s\S]*from public, anon, authenticated/i);
  assert.match(profileMigration, /grant execute[\s\S]*to service_role/i);
  assert.match(passwordMigration, /update public\.app_users[\s\S]*update public\.user_session_refresh_tokens[\s\S]*update public\.user_sessions/);
  assert.match(passwordMigration, /and s\.id <> p_current_session_id/);
  assert.match(passwordMigration, /account\.password_changed/);
});
