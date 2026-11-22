import test from 'node:test';
import { readAppViewSource } from './helpers/view-source.mjs';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = path => readFile(new URL(path, import.meta.url), 'utf8');
import { readControllerSource } from './helpers/controller-source.mjs';

test('los borradores locales se separan por identificador de cuenta', async () => {
  const controller = await readControllerSource();
  assert.match(controller, /localDraftKeyFor\(key\)[\s\S]*return `\$\{userId\}:\$\{key\}`/);
  assert.match(controller, /getLocalDraft\(this\.localDraftKey\)/);
  assert.doesNotMatch(controller, /getLocalDraft\('new'\)/);
});

test('la recuperación de contraseña está limitada por intentos', async () => {
  const auth = await read('../supabase/functions/auth-api/index.ts');
  assert.match(auth, /hmacSha256Hex\(`auth-attempt-identifier:v1:\$\{identifier\}`\)/);
  assert.match(auth, /startAuthAttempt\(req, username, 'recovery'\)/);
  assert.match(auth, /start_app_auth_attempt/);
  assert.match(auth, /complete_app_login_attempt/);
  const recoveryHandoff = await read('../assets/js/services/recovery-handoff.js');
  assert.match(recoveryHandoff, /new Uint8Array\(24\)/);
  assert.match(auth, /consume_app_recovery_code/);
});

test('la identidad de las operaciones de cartas procede de la sesión validada', async () => {
  const letters = await read('../supabase/functions/letters-api/index.ts');
  assert.match(letters, /const userId = session\.userId/);
  assert.match(letters, /const session = await requireSession\(req\)/);
  assert.doesNotMatch(letters, /String\(body\.userId/);
});

test('archivar oculta de bandejas sin borrar el estado personal ni el registro', async () => {
  const letters = await read('../supabase/functions/letters-api/index.ts');
  const migration = await read('../supabase/migrations/20261120173200_fix_orphaned_purge_and_list_pagination.sql');
  assert.match(migration, /p_folder = 'inbox'[\s\S]*us\.archived_at is null/);
  assert.match(migration, /p_folder = 'archive'[\s\S]*us\.archived_at is not null/);
  assert.match(letters, /set_letter_archive_state/);
});

test('la migración elimina el acceso público y reserva RPC/tablas al backend', async () => {
  const sql = await read('../supabase/migrations/20261116045159_lock_down_direct_data_api.sql');
  assert.match(sql, /revoke all privileges on table[\s\S]*from public, anon, authenticated/i);
  assert.match(sql, /to service_role/i);
  assert.match(sql, /commit;/i);
});


test('las cartas enviadas incluyen la marca de lectura registrada para el destinatario', async () => {
  const letters = await read('../supabase/functions/letters-api/index.ts');
  const view = await readAppViewSource();
  assert.match(letters, /async function recipientStatesFor\(rows: Record<string, unknown>\[\]\)/);
  assert.match(letters, /readByRecipientAt: recipientState\?\.read_at/);
  assert.match(letters, /recipientStatesFor\(threadRows\)/);
  assert.match(letters, /recipient_read_at/);
  assert.match(view, /Leída el \$\{formatDate\(letter\.readByRecipientAt\)\}/);
  assert.match(view, /Entregada · pendiente de lectura/);
  assert.match(view, /Recibida · pendiente de lectura/);
});


test('el backend rechaza borradores nuevos vacíos y valida las respuestas antes de crearlas', async () => {
  const letters = await read('../supabase/functions/letters-api/index.ts');
  assert.match(letters, /case 'draft:create':[\s\S]*if \(!stripTags\(html\)\.replace\(\/&nbsp;\/g, ' '\)\.trim\(\)\) return \{ status: 'empty' \}[\s\S]*rpc<unknown>\('create_letter_draft'/);
  assert.match(letters, /parseCreateDraftRpcResult\(raw\)/);
  assert.match(letters, /case 'draft:save':[\s\S]*rpc\('save_letter_draft'/);
  assert.match(letters, /case 'draft:send':[\s\S]*send_letter_draft/);
  assert.match(letters, /case 'reply':[\s\S]*if \(!stripTags\(html\)\.trim\(\)\) throw new Error\('INVALID_INPUT'\)/);
});

test('las notificaciones distinguen la lectura de una carta del envío o respuesta', async () => {
  const letters = await read('../supabase/functions/letters-api/index.ts');
  assert.match(letters, /item\.notification_type === 'letter_read' \? 'leyó tu carta'/);
  assert.match(letters, /item\.notification_type === 'letter_reply_received'\s*\? 'respondió a tu carta'/);
});


test('el registro sin email limita el espacio a dos cuentas y protege el RPC', async () => {
  const sql = await read('../supabase/migrations/20261116055118_opaque_sessions_local_recovery.sql');
  const auth = await read('../supabase/functions/auth-api/index.ts');
  assert.match(sql, /pg_advisory_xact_lock\(hashtextextended\('private-letters-account-cap'/);
  assert.match(sql, /v_account_count >= 2/);
  assert.match(sql, /register_app_user_without_email/);
  assert.match(sql, /revoke execute[\s\S]*from public, anon, authenticated/i);
  assert.match(sql, /grant execute[\s\S]*to service_role/i);
  assert.doesNotMatch(sql, /security definer/i);
  assert.match(auth, /action === 'register'/);
  assert.match(auth, /recover-with-code/);
});


test('los borradores provisionales no necesitan una segunda cuenta; el destinatario se vincula al enviar', async () => {
  const sql = await read('../supabase/migrations/20261116164909_drafts_without_second_account.sql');
  const letters = await read('../supabase/functions/letters-api/index.ts');
  assert.match(sql, /alter column participant_b_id drop not null/i);
  assert.match(sql, /alter column recipient_id drop not null/i);
  assert.match(sql, /values \(p_sender_id, null, p_sender_id\)/i);
  assert.match(sql, /if v_letter\.recipient_id is null then[\s\S]*recipient_unavailable[\s\S]*set recipient_id = v_recipient_id/i);
  assert.match(sql, /grant execute[\s\S]*to service_role/i);
  assert.match(letters, /row\.recipient_id \? String\(row\.recipient_id\) : ''/);
});


test('la sesión renueva actividad como máximo una vez por minuto y en paralelo al perfil', async () => {
  const core = await read('../supabase/functions/_shared/core.ts');
  assert.match(core, /now - lastSeenAt >= 60_000/);
  assert.match(core, /Promise\.all\(\[[\s\S]*selectOne<AppUser>\('app_users'/);
  assert.match(core, /activityUpdate/);
});


test('el registro exige un código privado y el backend consume la invitación en la misma transacción', async () => {
  const auth = await read('../supabase/functions/auth-api/index.ts');
  const core = await read('../supabase/functions/_shared/core.ts');
  const view = await readAppViewSource();
  const controller = await readControllerSource();
  const migration = await read('../supabase/migrations/20261118203751_private_registration_invitations.sql');
  assert.match(view, /name="invitationCode"[^>]*required/);
  assert.match(auth, /normalizeRegistrationInvitation/);
  assert.match(auth, /registration-invite:v1:/);
  assert.match(auth, /start_app_registration_invite_attempt/);
  assert.match(auth, /check_app_registration_invite/);
  assert.match(auth, /register_app_user_with_invite/);
  assert.match(auth, /complete_app_registration_invite_attempt/);
  assert.match(core, /hmacSha256Hex/);
  assert.match(controller, /invitation:create/);
  assert.match(controller, /invitation:status/);
  assert.match(migration, /select id into v_invitation_id[\s\S]*for update/i);
  assert.match(migration, /set consumed_at = p_now,[\s\S]*consumed_user_id = v_user_id/i);
  assert.match(migration, /create or replace function public.register_app_user_with_invite/i);
});

test('los códigos de invitación solo se almacenan como hash y no quedan rutas de registro antiguas', async () => {
  const migration = await read('../supabase/migrations/20261118203751_private_registration_invitations.sql');
  const auth = await read('../supabase/functions/auth-api/index.ts');
  assert.match(migration, /token_hash text not null unique/);
  assert.match(migration, /registration-invite:v1:/);
  assert.match(migration, /revoke all privileges on function[\s\S]*from public, anon, authenticated, service_role/i);
  assert.match(migration, /bootstrap_app_registration_invite/);
  assert.match(migration, /current_user <> 'postgres'/);
  assert.doesNotMatch(auth, /register_app_user_without_email/);
  assert.doesNotMatch(auth, /localStorage.*invitation|sessionStorage.*invitation/i);
  const indexes = await read('../supabase/migrations/20261118204339_registration_invitation_fk_indexes.sql');
  assert.match(indexes, /registration_invites_invited_by_user_id_idx/);
  assert.match(indexes, /registration_invites_consumed_user_id_idx/);
  assert.match(indexes, /registration_invite_attempts_user_id_idx/);
});

test('los intentos de invitación tienen límites por IP y código y dejan auditoría sin IP en claro', async () => {
  const migration = await read('../supabase/migrations/20261118203751_private_registration_invitations.sql');
  const auth = await read('../supabase/functions/auth-api/index.ts');
  assert.match(migration, /v_ip_count >= 10/);
  assert.match(migration, /v_token_count >= 5/);
  assert.match(migration, /interval '15 minutes'/);
  assert.match(migration, /registration\.invite_rate_limited/);
  assert.match(migration, /registration\.invite_rejected/);
  assert.match(auth, /hmacSha256Hex\(`registration-invite-ip:v1:/);
  assert.match(auth, /cf-connecting-ip/);
  assert.doesNotMatch(auth, /headers\.get\(['"](?:x-real-ip|x-forwarded-for)['"]\)/i);
});


test('el límite de autenticación combina cuenta e IP sin bloquear globalmente a la persona', async () => {
  const auth = await read('../supabase/functions/auth-api/index.ts');
  const migration = await read('../supabase/migrations/20261119064344_auth_attempt_rate_limits.sql');
  assert.match(auth, /cf-connecting-ip/);
  assert.match(auth, /auth-attempt-ip:v1/);
  assert.match(auth, /startAuthAttempt\(req, username, 'login'\)/);
  assert.match(auth, /auth-attempt-identifier:v1/);
  assert.match(auth, /startAuthAttempt\(req, username, 'recovery'\)/);
  assert.match(migration, /login_attempts_ip_recent_idx/);
  assert.match(migration, /login_attempts_account_ip_recent_idx/);
  assert.match(migration, /v_pair_count >= 5/);
  assert.match(migration, /v_ip_count >= 25/);
  assert.match(migration, /make_interval\(secs => v_pair_delay\)/);
  assert.match(migration, /auth\.suspicious_account_attempts/);
  assert.match(auth, /startAuthAttempt\(req, username, 'recovery'\)/);
  const startAttemptStart = auth.indexOf('async function startAuthAttempt(');
  const startAttemptEnd = auth.indexOf('async function applyDistributedFailureFriction(', startAttemptStart);
  const startAttemptBody = auth.slice(startAttemptStart, startAttemptEnd);
  assert.doesNotMatch(startAttemptBody, /setTimeout/, 'no se debe retrasar antes de validar las credenciales');
  assert.match(auth, /async function applyDistributedFailureFriction\([\s\S]*?if \(!failed\) return;[\s\S]*?totalFailures < 10[\s\S]*?Math\.min\(1600/);
  const loginFlow = auth.slice(auth.indexOf("if (action === 'login')"), auth.indexOf("if (action === 'refresh')"));
  const recoveryFlow = auth.slice(auth.indexOf("if (action === 'recover-with-code')"), auth.indexOf("if (action === 'invitation:status')"));
  assert.match(loginFlow, /if \(!valid \|\| !user\) \{[\s\S]*?applyDistributedFailureFriction\(attempt, true\)/);
  assert.match(recoveryFlow, /if \(result\.status !== 'recovered'\) \{[\s\S]*?applyDistributedFailureFriction\(attempt, true\)/);
  assert.match(migration, /auth\.suspicious_ip_activity/);
  assert.match(migration, /auth\.rate_limited/);
  assert.match(migration, /RLS|row level security/i);
  assert.match(migration, /revoke all on function public\.start_app_auth_attempt[\s\S]*from public, anon, authenticated/i);
  assert.match(migration, /grant execute on function public\.start_app_auth_attempt[\s\S]*to service_role/i);
  assert.match(migration, /no se bloquea la cuenta[\s\S]*desde otra IP/i);
  assert.match(migration, /account_failure_count', v_account_failures/);
  assert.match(migration, /v_account_failures >= 10 and not exists/);
  assert.match(migration, /occurred_at > p_now - interval '10 minutes'/);
});
