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
  'assets/js/controllers/auth-controller.js',
  'assets/js/controllers/navigation-controller.js',
  'assets/js/controllers/letter-controller.js',
  'assets/js/controllers/draft-controller.js',
  'assets/js/controllers/settings-controller.js',
  'assets/js/controllers/notification-controller.js',
  'assets/js/repositories/letter-repository.js',
  'assets/js/services/api-client.js', 'assets/js/services/session-service.js',
  'assets/js/services/local-drafts.js', 'assets/js/services/recovery-handoff.js',
  'assets/js/services/draft-sync-queue.js', 'assets/js/services/adaptive-poller.js', 'assets/js/utils/dom.js',
  'tests/helpers/controller-source.mjs', 'tests/controller-modularization.test.mjs',
  'tests/accessibility-release.test.mjs', 'scripts/package-zip.mjs',
  'docs/ACCESSIBILITY.md', 'docs/PUSH_NOTIFICATIONS_ROADMAP.md',
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
  'supabase/migrations/20261118203751_private_registration_invitations.sql',
  'supabase/migrations/20261118204339_registration_invitation_fk_indexes.sql',
  'supabase/migrations/20261119050910_idempotent_registration_recovery_handoff.sql',
  'supabase/migrations/20261119064344_auth_attempt_rate_limits.sql',
  'supabase/migrations/20261119090000_shared_letter_purge_and_reply_guard.sql',
  'supabase/migrations/20261120173200_fix_orphaned_purge_and_list_pagination.sql',
  'supabase/migrations/20261120235900_transactional_profile_rename.sql',
  'supabase/tests/auth_rate_limits.test.sql', 'supabase/tests/shared_letter_purge.test.sql',
  'supabase/tests/profile_rename_transaction.test.sql',
  'scripts/run-db-tests.mjs', 'docs/LETTERS_CONSISTENCY.md', 'docs/E2EE_ARCHITECTURE.md', 'docs/CONTROLLER_ARCHITECTURE.md',
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
const authView = await readFile(join(root, 'assets/js/views/app-view.js'), 'utf8');
if (!/access_token_hash/.test(core) || !/access_expires_at/.test(core) || !/sha256Hex\(token\)/.test(core)) {
  failures.push('No se detectó validación de token opaco almacenado como hash.');
}
if (/APP_JWT_SECRET|APP_BOOTSTRAP_SECRET|APP_ALLOWED_ORIGINS|RESEND_API_KEY/.test(`${auth}\n${letters}\n${core}`)) {
  failures.push('Quedó una dependencia de secretos personalizados en las Edge Functions.');
}
if (!/register_app_user_with_invite/.test(auth) || !/recover-with-code/.test(auth) || /register_app_user_without_email/.test(auth)) {
  failures.push('auth-api debe exigir invitación privada en el registro y conservar la recuperación con código.');
}
const inviteMigration = await readFile(join(root, 'supabase/migrations/20261118203751_private_registration_invitations.sql'), 'utf8');
if (!/registration_invites/.test(inviteMigration) || !/register_app_user_with_invite/.test(inviteMigration) || !/complete_app_registration_invite_attempt/.test(inviteMigration) || !/revoke all privileges[\s\S]*register_app_user_without_email/i.test(inviteMigration)) {
  failures.push('La migración de invitaciones no protege el registro anterior, el consumo transaccional y los intentos.');
}
const inviteIndexes = await readFile(join(root, 'supabase/migrations/20261118204339_registration_invitation_fk_indexes.sql'), 'utf8');
if (!/registration_invites_invited_by_user_id_idx/.test(inviteIndexes) || !/registration_invites_consumed_user_id_idx/.test(inviteIndexes) || !/registration_invite_attempts_user_id_idx/.test(inviteIndexes)) {
  failures.push('Faltan índices para las claves foráneas del sistema de invitaciones.');
}
const recoveryHandoffSql = await readFile(join(root, 'supabase/migrations/20261119050910_idempotent_registration_recovery_handoff.sql'), 'utf8');
const recoveryHandoff = await readFile(join(root, 'assets/js/services/recovery-handoff.js'), 'utf8');
if (!/registration_request_receipts/.test(recoveryHandoffSql) || !/register_app_user_with_invite_idempotent/.test(recoveryHandoffSql)
  || !/rotate_app_recovery_code/.test(recoveryHandoffSql) || !/previous_codes_invalidated/.test(recoveryHandoffSql)
  || !/revoke all on function public\.register_app_user_with_invite[\s\S]*service_role/i.test(recoveryHandoffSql)) {
  failures.push('El traspaso de recuperación no es idempotente o no invalida el código anterior al rotarlo.');
}
if (!/localStorage\.setItem/.test(recoveryHandoff) || !/crypto\.getRandomValues/.test(recoveryHandoff)
  || /password/i.test(recoveryHandoff.match(/export function savePendingRecovery[\s\S]*?export function createPendingRegistration/)?.[0] || '')) {
  failures.push('El código de recuperación debe generarse en el navegador y guardarse temporalmente sin almacenar la contraseña.');
}
if (!/resumeRegistrationFromReceipt/.test(auth) || !/verifyPassword\(password/.test(auth) || !/authenticated: false/.test(auth)
  || !/action === 'recovery-code:rotate'/.test(auth) || !/verifyPassword\(currentPassword/.test(auth)) {
  failures.push('auth-api debe reanudar altas idempotentes, separar cuenta/sesión y permitir rotar el código con contraseña actual.');
}
const recoverySessionService = await readFile(join(root, 'assets/js/services/session-service.js'), 'utf8');
const recoveryController = await readFile(join(root, 'assets/js/controllers/app-controller.js'), 'utf8') + await readFile(join(root, 'assets/js/controllers/auth-controller.js'), 'utf8');
if (!/payload\.authenticated === true && payload\.accessToken && payload\.refreshToken/.test(recoverySessionService)
  || !/createPendingRegistration/.test(recoveryController) || !/isUncertainRequestError/.test(recoveryController)
  || !/id="recovery-code-form"/.test(authView)) {
  failures.push('El frontend no conserva la recuperación cuando la sesión falla o no expone la rotación del código.');
}
if (!/name="invitationCode"[\s\S]*required/.test(authView)) {
  failures.push('El formulario de registro debe solicitar el código de invitación.');
}
const controller = await readFile(join(root, 'assets/js/controllers/app-controller.js'), 'utf8') + await readFile(join(root, 'assets/js/controllers/navigation-controller.js'), 'utf8') + await readFile(join(root, 'assets/js/controllers/letter-controller.js'), 'utf8') + await readFile(join(root, 'assets/js/controllers/draft-controller.js'), 'utf8') + await readFile(join(root, 'assets/js/controllers/settings-controller.js'), 'utf8') + await readFile(join(root, 'assets/js/controllers/notification-controller.js'), 'utf8');
if (!/requireSession\(req\)/.test(letters)) failures.push('letters-api no exige sesión propia.');
const consistencyMigration = await readFile(join(root, 'supabase/migrations/20261119090000_shared_letter_purge_and_reply_guard.sql'), 'utf8');
const sharedPurgeTest = await readFile(join(root, 'supabase/tests/shared_letter_purge.test.sql'), 'utf8');
if (!/new\.reply_to_letter_id is distinct from old\.reply_to_letter_id/.test(consistencyMigration)
  || !/already_confirmed_waiting/.test(consistencyMigration)
  || !/pending_other_participant/.test(consistencyMigration)
  || !/purged/.test(sharedPurgeTest)
  || !/plan\(14\)/.test(sharedPurgeTest)
  || !/v_state\.trashed_at is not null[\s\S]*'status','discarded'/.test(consistencyMigration)
  || !/save_letter_draft\([\s\S]*'discarded'/.test(sharedPurgeTest)) {
  failures.push('La migración o prueba pgTAP de eliminación compartida está incompleta.');
}
if (!/const accountId = this\.session\?\.user\?\.id \|\| 'guest'/.test(controller)
  || !/this\.state\.editor = null/.test(controller)
  || !/this\.pendingLetterActions = new Set\(\)/.test(controller)) {
  failures.push('El estado privado debe quedar aislado por cuenta y bloquear acciones repetidas de carta.');
}
if (!/allowedThemes = new Set\(\['light','dark','system'\]\)/.test(letters) || !/theme, time_zone: timeZone/.test(letters)) failures.push('letters-api no valida y persiste el tema en las preferencias del usuario.');
if (!/p_username text[\s\S]*normalize\(btrim\(coalesce\(p_username, ''\)\), NFKC\)/.test(await readFile(join(root, 'supabase/migrations/20261117025358_unicode_usernames_and_system_theme.sql'), 'utf8'))) failures.push('El registro no normaliza nombres de usuario Unicode.');
if (!/action === 'account:update'/.test(auth) || !/action === 'password:update'/.test(auth) || !/action === 'account:delete'/.test(auth) || !/\\p\{L\}/.test(auth)) failures.push('auth-api no incluye edición de datos, contraseña, eliminación segura de cuenta y validación Unicode.');
const passwordMigration = await readFile(join(root, 'supabase/migrations/20261117030115_secure_profile_and_password_updates.sql'), 'utf8');
if (!/change_app_password/.test(passwordMigration) || !/revoke execute[\s\S]*from public, anon, authenticated/i.test(passwordMigration) || !/grant execute[\s\S]*to service_role/i.test(passwordMigration)) failures.push('El RPC de cambio de contraseña no está protegido para uso exclusivo del backend.');
const profileRenameMigration = await readFile(join(root, 'supabase/migrations/20261120235900_transactional_profile_rename.sql'), 'utf8');
if (!/rpc<unknown>\('rename_app_profile'/.test(letters) || /Promise\.all/.test(letters.slice(letters.indexOf("case 'profile:rename'"), letters.indexOf("case 'sessions'"))) || !/update public\.app_users[\s\S]*insert into public\.user_profiles[\s\S]*on conflict \(user_id\) do update/.test(profileRenameMigration)) failures.push('El cambio de nombre visible debe actualizar app_users y user_profiles dentro de un único RPC transaccional.');
const draftQueue = await readFile(join(root, 'assets/js/services/draft-sync-queue.js'), 'utf8');
const poller = await readFile(join(root, 'assets/js/services/adaptive-poller.js'), 'utf8');
if (!/new DraftSyncQueue\(\)/.test(await readFile(join(root, 'assets/js/controllers/app-controller.js'), 'utf8')) || !/draftSyncQueue\.enqueue/.test(await readFile(join(root, 'assets/js/controllers/draft-controller.js'), 'utf8')) || !/120_000/.test(poller) || !/600_000/.test(poller) || !/visibilitychange/.test(poller) || !/failures/.test(poller) || !/2 \* 60_000/.test(await readFile(join(root, 'assets/js/controllers/notification-controller.js'), 'utf8')) || !/15 \* 60_000/.test(await readFile(join(root, 'assets/js/controllers/settings-controller.js'), 'utf8'))) failures.push('La cola de borradores o el poller adaptativo no está implementado correctamente.');
if ((await readFile(join(root, 'assets/js/controllers/app-controller.js'), 'utf8')).split('\n').length > 900) failures.push('app-controller.js sigue concentrando demasiadas responsabilidades.');
if (!/pg_advisory_xact_lock[\s\S]*v_account_count >= 2/i.test(authSql)) failures.push('El alta no garantiza concurrencia y límite de dos cuentas.');
if (!/revoke execute[\s\S]*from public, anon, authenticated/i.test(authSql) || !/grant execute[\s\S]*to service_role/i.test(authSql)) {
  failures.push('El RPC de registro no está reservado a service_role.');
}
if (/supabase\.auth\.(?:signUp|signInWithPassword|signOut)/i.test(`${auth}\n${letters}\n${core}`)) {
  failures.push('Se detectó un flujo de Supabase Auth prohibido.');
}
const draftMigration = await readFile(join(root, 'supabase/migrations/20261116164909_drafts_without_second_account.sql'), 'utf8');
if (!/alter column participant_b_id drop not null/i.test(draftMigration) || !/alter column recipient_id drop not null/i.test(draftMigration) || !/recipient_unavailable/.test(draftMigration)) failures.push('La migración de borradores provisionales no permite guardar con una sola cuenta y asignar destinatario al enviar.');
if (!/name="theme"/.test(authView) || !/value="dark"/.test(authView)) failures.push('Configuración no expone el selector del tema oscuro.');
const css = await readFile(join(root, 'assets/css/app.css'), 'utf8');
if (!/html\[data-theme="dark"\]/.test(css) || !/--paper:#171615/.test(css)) failures.push('No se encontraron los tokens del tema oscuro.');
const registerStart = authView.indexOf('id="register-form"');
const registerEnd = authView.indexOf('</form>', registerStart);
const registerMarkup = registerStart >= 0 && registerEnd > registerStart ? authView.slice(registerStart, registerEnd) : '';
if (!registerMarkup || /bootstrapSecret|type="email"|name="email"/.test(registerMarkup)) {
  failures.push('El formulario de registro solicita correo o secretos de bootstrap; el email solo se edita después desde la cuenta.');
}

const packageJson = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
const paginationMigration = await readFile(join(root, 'supabase/migrations/20261120173200_fix_orphaned_purge_and_list_pagination.sql'), 'utf8');
if (!/^deno check --config=/m.test(packageJson.scripts['check:edge'] || '')
  || !/purge_shared_letters_after_account_disabled/.test(paginationMigration)
  || !/public\.list_user_letters/.test(paginationMigration)) {
  failures.push('Falta la comprobación Deno de Edge Functions o la migración de purga/paginación.');
}
const workflow = await readFile(join(root, '.github/workflows/pages.yml'), 'utf8');
if (!/actions\/configure-pages@v6/.test(workflow) || /static_site_generator:\s*custom/.test(workflow)) {
  failures.push('GitHub Pages debe usar configure-pages v6 sin el generador custom no compatible.');
}
if (!/npm run check/.test(workflow) || !/npm run check:edge/.test(workflow) || !/denoland\/setup-deno@v2/.test(workflow) || !/npm test/.test(workflow) || !/npm run build:pages/.test(workflow) || !/path: \.\/_site/.test(workflow)) {
  failures.push('El workflow debe verificar el proyecto, ejecutar pruebas y publicar _site.');
}
if (!/showConfirmDialog/.test(controller) || /\b(?:window\.)?confirm\s*\(/.test(controller)) {
  failures.push('Las confirmaciones deben usar el diálogo accesible y unificado, no confirm() nativo.');
}
if (await access(join(root, 'public')).then(() => true).catch(() => false)) {
  failures.push('La carpeta public/ permanece y puede causar confusión con la raíz del sitio.');
}


const accessibilityHtml = await readFile(join(root, 'index.html'), 'utf8');
const accessibilityView = await readFile(join(root, 'assets/js/views/app-view.js'), 'utf8');
const accessibilityController = await readFile(join(root, 'assets/js/controllers/app-controller.js'), 'utf8');
const accessibilityDom = await readFile(join(root, 'assets/js/utils/dom.js'), 'utf8');
if (/<div\s+id="app"[^>]*aria-live=/i.test(accessibilityHtml)
  || !/id="app-announcer"[^>]*role="status"[^>]*aria-live="polite"/.test(accessibilityHtml)
  || !/id="app-alert-announcer"[^>]*role="alert"[^>]*aria-live="assertive"/.test(accessibilityHtml)
  || !/toast\.setAttribute\('role', 'group'\)/.test(accessibilityDom)) {
  failures.push('Las regiones vivas deben ser pequeñas y estables, no envolver el árbol completo de la aplicación.');
}
if (!/class="skip-link" href="#main-content"/.test(accessibilityView)
  || !/id="main-content" tabindex="-1"/.test(accessibilityView)
  || !/id="page-heading" tabindex="-1"/.test(accessibilityView)
  || !/aria-current="page"/.test(accessibilityView)
  || !/toggleAttribute\('inert', hideSidebar\)/.test(accessibilityController)
  || !/toggleAttribute\('inert', hideMain\)/.test(accessibilityController)
  || !/closeButton\?\.focus/.test(accessibilityController)) {
  failures.push('Falta el enlace de salto, el foco de página o la gestión accesible del menú móvil.');
}
const accessibilityCss = await readFile(join(root, 'assets/css/app.css'), 'utf8');
if (!/@media \(pointer: coarse\)[\s\S]*?min-height: 44px/.test(accessibilityCss)
  || !/@media \(prefers-reduced-motion: reduce\)/.test(accessibilityCss)) {
  failures.push('Los controles táctiles deben tener tamaño mínimo y respetar movimiento reducido.');
}
const readme = await readFile(join(root, 'README.md'), 'utf8');
const baseline = await readFile(join(root, 'docs/REMOTE_BASELINE.md'), 'utf8');
const zipScript = await readFile(join(root, 'scripts/package-zip.mjs'), 'utf8');
if (!/auth-api[^\n]{0,100}v11|auth-api[^\n]{0,100}versión 11/i.test(readme)
  || /auth-api[^\n]{0,100}v10|auth-api[^\n]{0,100}versión 10/i.test(readme)
  || !/`auth-api` \| ACTIVE \| 11/.test(baseline)
  || !/npm run package:zip/.test(readme)
  || !/'.git'/.test(zipScript) || !/'node_modules'/.test(zipScript) || !/'_site'/.test(zipScript)
  || !/name === '.env'/.test(zipScript)) {
  failures.push('La documentación de versiones o las exclusiones del paquete ZIP no coinciden con el baseline.');
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
