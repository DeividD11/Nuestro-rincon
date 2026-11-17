import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = path => readFile(new URL(path, import.meta.url), 'utf8');

test('los borradores locales se separan por identificador de cuenta', async () => {
  const controller = await read('../assets/js/controllers/app-controller.js');
  assert.match(controller, /localDraftKeyFor\(key\)[\s\S]*return `\$\{userId\}:\$\{key\}`/);
  assert.match(controller, /getLocalDraft\(this\.localDraftKey\)/);
  assert.doesNotMatch(controller, /getLocalDraft\('new'\)/);
});

test('la recuperación de contraseña está limitada por intentos', async () => {
  const auth = await read('../supabase/functions/auth-api/index.ts');
  assert.match(auth, /sha256Hex\(`recover:\$\{username\}`\)/);
  assert.match(auth, /start_app_login_attempt/);
  assert.match(auth, /complete_app_login_attempt/);
  assert.match(auth, /new Uint8Array\(24\)/);
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
  assert.match(letters, /folder === 'inbox' \|\| folder === 'sent'[\s\S]*!row\.isArchived/);
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
  const view = await read('../assets/js/views/app-view.js');
  assert.match(letters, /async function recipientStatesFor\(rows: Record<string, unknown>\[\]\)/);
  assert.match(letters, /readByRecipientAt: recipientState\?\.read_at/);
  assert.match(letters, /recipientStatesFor\(rows\)/);
  assert.match(view, /Leída el \$\{formatDate\(letter\.readByRecipientAt\)\}/);
  assert.match(view, /Entregada · pendiente de lectura/);
  assert.match(view, /Recibida · pendiente de lectura/);
});


test('el editor permite borradores vacíos y reserva la validación de contenido para el envío', async () => {
  const letters = await read('../supabase/functions/letters-api/index.ts');
  assert.match(letters, /case 'draft:create':[\s\S]*rpc<Record<string,unknown>>\('create_letter_draft'/);
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
