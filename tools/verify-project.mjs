#!/usr/bin/env node
import { access, readFile, readdir, stat } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { dirname, extname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const required = [
  'index.html', '404.html', '.nojekyll',
  'assets/css/app.css', 'assets/icons/mark.svg',
  'assets/js/app.js', 'assets/js/config/app-config.js',
  'assets/js/models/app-state.js', 'assets/js/views/app-view.js',
  'assets/js/controllers/app-controller.js',
  'assets/js/repositories/letter-repository.js',
  'assets/js/services/api-client.js', 'assets/js/services/session-service.js',
  'assets/js/services/local-drafts.js', 'assets/js/utils/dom.js',
  'assets/js/utils/format.js', 'supabase/config.toml', 'supabase/schema/README.md',
  'supabase/migrations/20261116045159_lock_down_direct_data_api.sql',
  'supabase/migrations/20261116055118_opaque_sessions_local_recovery.sql',
  'supabase/migrations/20261116164909_drafts_without_second_account.sql',
  'supabase/migrations/20261117025358_unicode_usernames_and_system_theme.sql',
  'supabase/migrations/20261117030115_secure_profile_and_password_updates.sql',
  'supabase/migrations/20261117033226_secure_account_deletion.sql',
  'supabase/migrations/20261117033323_account_deletion_uuid_fallback.sql',
  'supabase/migrations/20261117035219_allow_provisional_draft_recipient_binding.sql',
  'supabase/migrations/20261117041103_idempotent_recovery_for_purged_drafts.sql',
  'supabase/migrations/20261117041205_reuse_account_slot_after_deletion.sql',
  'assets/js/theme-boot.js',
  'supabase/functions/_shared/core.ts', 'supabase/functions/auth-api/index.ts',
  'supabase/functions/letters-api/index.ts', 'supabase/functions/deno.json',
  'scripts/build-pages.mjs', 'docs/SECURITY.md', 'docs/REMOTE_BASELINE.md',
  'README.md', '.gitignore', '.github/workflows/pages.yml'
];

const failures = [];
for (const path of required) {
  try {
    await access(join(root, path));
    if (path !== '.nojekyll' && (await stat(join(root, path))).size === 0) failures.push(`Archivo crítico vacío: ${path}`);
  } catch {
    failures.push(`Falta archivo requerido: ${path}`);
  }
}

async function walk(dir) {
  const result = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) result.push(...await walk(full));
    else result.push(full);
  }
  return result;
}

const jsFiles = await walk(join(root, 'assets/js')).then(files => files.filter(file => extname(file) === '.js'));
for (const file of jsFiles) {
  const check = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  if (check.status !== 0) failures.push(`Sintaxis JavaScript inválida en ${relative(root, file)}: ${check.stderr || check.stdout}`);
  const source = await readFile(file, 'utf8');
  for (const match of source.matchAll(/(?:from\s*|import\s*)['"](\.{1,2}\/[^'"]+)['"]/g)) {
    const imported = resolve(dirname(file), match[1]);
    try { await access(imported); }
    catch { failures.push(`Importación local inexistente en ${relative(root, file)}: ${match[1]}`); }
  }
}

const html = await readFile(join(root, 'index.html'), 'utf8');
for (const match of html.matchAll(/(?:src|href)=["']([^"']+)["']/g)) {
  const target = match[1];
  if (/^(?:https?:|data:|#|mailto:|tel:)/i.test(target)) continue;
  const local = resolve(root, target.replace(/^\.\//, ''));
  try { await access(local); }
  catch { failures.push(`Recurso local referenciado desde index.html inexistente: ${target}`); }
}

const frontendFiles = [join(root, 'index.html'), join(root, '404.html'), ...await walk(join(root, 'assets'))];
for (const file of frontendFiles) {
  const ext = extname(file).toLowerCase();
  if (!['.html', '.js', '.css', '.svg', '.json', '.webmanifest'].includes(ext)) continue;
  const source = await readFile(file, 'utf8');
  if (/sb_secret_|service_role|SUPABASE_SECRET_KEYS|APP_JWT_SECRET|APP_BOOTSTRAP_SECRET|RESEND_API_KEY|postgres(?:ql)?:\/\//i.test(source)) {
    failures.push(`Posible secreto o credencial de servidor en frontend: ${relative(root, file)}`);
  }
}

const config = await readFile(join(root, 'assets/js/config/app-config.js'), 'utf8');
if (!/sb_publishable_[A-Za-z0-9_-]+/.test(config)) failures.push('No se encontró la clave pública publishable en app-config.js.');
const auth = await readFile(join(root, 'supabase/functions/auth-api/index.ts'), 'utf8');
const letters = await readFile(join(root, 'supabase/functions/letters-api/index.ts'), 'utf8');
const core = await readFile(join(root, 'supabase/functions/_shared/core.ts'), 'utf8');
const authSql = await readFile(join(root, 'supabase/migrations/20261116055118_opaque_sessions_local_recovery.sql'), 'utf8');
if (!/access_token_hash/.test(core) || !/access_expires_at/.test(core) || !/sha256Hex\(token\)/.test(core)) {
  failures.push('No se detectó validación de token opaco almacenado como hash.');
}
if (/APP_JWT_SECRET|APP_BOOTSTRAP_SECRET|APP_ALLOWED_ORIGINS|RESEND_API_KEY/.test(`${auth}\n${letters}\n${core}`)) {
  failures.push('Quedó una dependencia de secretos personalizados en las Edge Functions.');
}
if (!/register_app_user_without_email/.test(auth) || !/recover-with-code/.test(auth)) {
  failures.push('auth-api no incluye registro directo y recuperación con código.');
}
if (!/requireSession\(req\)/.test(letters)) failures.push('letters-api no exige sesión propia.');
if (!/allowedThemes = new Set\(\['light','dark','system'\]\)/.test(letters) || !/theme, time_zone: timeZone/.test(letters)) failures.push('letters-api no valida y persiste el tema en las preferencias del usuario.');
if (!/p_username text[\s\S]*normalize\(btrim\(coalesce\(p_username, ''\)\), NFKC\)/.test(await readFile(join(root, 'supabase/migrations/20261117025358_unicode_usernames_and_system_theme.sql'), 'utf8'))) failures.push('El registro no normaliza nombres de usuario Unicode.');
if (!/action === 'account:update'/.test(auth) || !/action === 'password:update'/.test(auth) || !/action === 'account:delete'/.test(auth) || !/\\p\{L\}/.test(auth)) failures.push('auth-api no incluye edición de datos, contraseña, eliminación segura de cuenta y validación Unicode.');
const passwordMigration = await readFile(join(root, 'supabase/migrations/20261117030115_secure_profile_and_password_updates.sql'), 'utf8');
if (!/change_app_password/.test(passwordMigration) || !/revoke execute[\s\S]*from public, anon, authenticated/i.test(passwordMigration) || !/grant execute[\s\S]*to service_role/i.test(passwordMigration)) failures.push('El RPC de cambio de contraseña no está protegido para uso exclusivo del backend.');
if (!/patchRows\('user_profiles'[\s\S]*display_name: displayName/.test(letters)) failures.push('El cambio de nombre visible no sincroniza app_users y user_profiles.');
if (!/pg_advisory_xact_lock[\s\S]*v_account_count >= 2/i.test(authSql)) failures.push('El alta no garantiza concurrencia y límite de dos cuentas.');
if (!/revoke execute[\s\S]*from public, anon, authenticated/i.test(authSql) || !/grant execute[\s\S]*to service_role/i.test(authSql)) {
  failures.push('El RPC de registro no está reservado a service_role.');
}
if (/supabase\.auth\.(?:signUp|signInWithPassword|signOut)/i.test(`${auth}\n${letters}\n${core}`)) {
  failures.push('Se detectó un flujo de Supabase Auth prohibido.');
}
const draftMigration = await readFile(join(root, 'supabase/migrations/20261116164909_drafts_without_second_account.sql'), 'utf8');
if (!/alter column participant_b_id drop not null/i.test(draftMigration) || !/alter column recipient_id drop not null/i.test(draftMigration) || !/recipient_unavailable/.test(draftMigration)) failures.push('La migración de borradores provisionales no permite guardar con una sola cuenta y asignar destinatario al enviar.');
const authView = await readFile(join(root, 'assets/js/views/app-view.js'), 'utf8');
if (!/name="theme"/.test(authView) || !/value="dark"/.test(authView)) failures.push('Configuración no expone el selector del tema oscuro.');
const css = await readFile(join(root, 'assets/css/app.css'), 'utf8');
if (!/html\[data-theme="dark"\]/.test(css) || !/--paper:#171615/.test(css)) failures.push('No se encontraron los tokens del tema oscuro.');
const registerStart = authView.indexOf('id="register-form"');
const registerEnd = authView.indexOf('</form>', registerStart);
const registerMarkup = registerStart >= 0 && registerEnd > registerStart ? authView.slice(registerStart, registerEnd) : '';
if (!registerMarkup || /bootstrapSecret|type="email"|name="email"/.test(registerMarkup)) {
  failures.push('El formulario de registro solicita correo o secretos de bootstrap; el email solo se edita después desde la cuenta.');
}

const workflow = await readFile(join(root, '.github/workflows/pages.yml'), 'utf8');
if (!/actions\/configure-pages@v6/.test(workflow) || /static_site_generator:\s*custom/.test(workflow)) {
  failures.push('GitHub Pages debe usar configure-pages v6 sin el generador custom no compatible.');
}
if (!/npm run check/.test(workflow) || !/npm test/.test(workflow) || !/npm run build:pages/.test(workflow) || !/path: \.\/_site/.test(workflow)) {
  failures.push('El workflow debe verificar el proyecto, ejecutar pruebas y publicar _site.');
}
const controller = await readFile(join(root, 'assets/js/controllers/app-controller.js'), 'utf8');
if (!/showConfirmDialog/.test(controller) || /\b(?:window\.)?confirm\s*\(/.test(controller)) {
  failures.push('Las confirmaciones deben usar el diálogo accesible y unificado, no confirm() nativo.');
}
if (await access(join(root, 'public')).then(() => true).catch(() => false)) {
  failures.push('La carpeta public/ permanece y puede causar confusión con la raíz del sitio.');
}

if (failures.length) {
  console.error('VERIFICACIÓN FALLIDA');
  failures.forEach(item => console.error(`- ${item}`));
  process.exitCode = 1;
} else {
  console.log(`Verificación correcta: ${required.length} archivos requeridos, ${jsFiles.length} módulos JavaScript revisados, imports y recursos locales encontrados.`);
  console.log('Registro sin correo, sesiones opacas y recuperación con código detectados.');
  console.log('La verificación no sustituye pruebas dinámicas de Edge Functions, PostgreSQL ni navegador real.');
}
