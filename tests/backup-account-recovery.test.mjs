import test from 'node:test';
import { readAppViewSource } from './helpers/view-source.mjs';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { encryptRecoveryVault, decryptRecoveryVault } from '../assets/js/services/recovery-vault.js';
import { createPendingRegistration, readPendingRecovery, clearPendingRecovery } from '../assets/js/services/recovery-handoff.js';
import { readControllerSource } from './helpers/controller-source.mjs';

const read = path => readFile(new URL(path, import.meta.url), 'utf8');
const sampleCodes = Array.from({ length: 10 }, (_, index) => [String(index + 1).padStart(6, '0'), ...Array.from({ length: 7 }, (_, group) => (index + 1).toString(16).toUpperCase().padStart(6, '0').slice(-6))].join('-'));

test('la copia de recuperación se cifra y descifra en el navegador sin exponer los códigos', async () => {
  const passphrase = 'frase secreta extensa de respaldo';
  const vault = await encryptRecoveryVault(sampleCodes, passphrase);
  const serialized = JSON.stringify(vault);
  for (const code of sampleCodes) assert.equal(serialized.includes(code), false);
  assert.deepEqual(await decryptRecoveryVault(serialized, passphrase), sampleCodes);
  assert.equal(vault.cipher.name, 'AES-256-GCM');
  assert.equal(vault.kdf.iterations, 600_000);
});

test('una frase incorrecta o un archivo alterado no permite abrir la copia', async () => {
  const vault = await encryptRecoveryVault(sampleCodes, 'otra frase secreta de respaldo');
  await assert.rejects(() => decryptRecoveryVault(vault, 'frase equivocada'), /COPIA_PROTEGIDA/);
  const tampered = structuredClone(vault);
  tampered.cipher.ciphertext = `${tampered.cipher.ciphertext.slice(0, -2)}AA`;
  await assert.rejects(() => decryptRecoveryVault(tampered, 'otra frase secreta de respaldo'), /COPIA_PROTEGIDA/);
});

test('el registro usa un código compatible con auth-api v11 y no guarda la contraseña en el traspaso', () => {
  const previousStorage = globalThis.localStorage;
  const values = new Map();
  globalThis.localStorage = {
    getItem: key => values.has(key) ? values.get(key) : null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: key => values.delete(key)
  };
  try {
    const pending = createPendingRegistration({ invitationCode: 'NR1-TEST', displayName: 'Persona', username: 'persona-test', password: 'no-debe-guardarse' });
    const restored = readPendingRecovery();
    assert.equal(pending.purpose, 'registration');
    assert.match(pending.recoveryCode, /^(?:[A-F0-9]{6}-){7}[A-F0-9]{6}$/);
    assert.equal(restored.recoveryCode, pending.recoveryCode);
    assert.doesNotMatch(values.values().next().value, /no-debe-guardarse|password/i);
  } finally {
    clearPendingRecovery();
    if (previousStorage === undefined) delete globalThis.localStorage;
    else globalThis.localStorage = previousStorage;
  }
});

test('el alta nueva inserta hashes de los diez códigos y protege su RPC', async () => {
  const migration = await read('../supabase/migrations/20261121200000_recovery_code_bundles.sql');
  const api = await read('../supabase/functions/auth-api/index.ts');
  assert.match(migration, /create table if not exists public\.recovery_code_bundle_receipts/);
  assert.match(migration, /create table if not exists public\.registration_recovery_bundle_receipts/);
  assert.match(migration, /create or replace function public\.register_app_user_with_invite_idempotent_bundle/);
  assert.match(migration, /jsonb_array_length\(p_code_hashes\) <> 10/);
  assert.match(migration, /insert into public\.user_recovery_codes\(user_id, code_hash, created_at\)[\s\S]*jsonb_array_elements_text\(p_code_hashes\)/);
  assert.match(migration, /recovery_codes_issued', 10/);
  assert.match(migration, /rotate_app_recovery_codes_bundle/);
  assert.match(migration, /jsonb_array_length\(p_code_hashes\) <> 10/);
  assert.match(migration, /used_at is null/);
  assert.match(migration, /update public\.user_recovery_codes[\s\S]*where user_id = v_user\.id and used_at is null/);
  assert.match(migration, /revoke all on function[\s\S]*from public, anon, authenticated/);
  assert.match(api, /action === 'recovery-codes:rotate'/);
  assert.match(api, /register_app_user_with_invite_idempotent_bundle/);
  assert.match(api, /body\.recoveryCodes/);
  assert.match(api, /const rawRecoveryCodes = body\.recoveryCodes;[\s\S]*const isRecoveryBundle = Array\.isArray\(rawRecoveryCodes\)/);
  assert.match(api, /rotate_app_recovery_codes_bundle/);
  assert.match(api, /recoveryCodes\.length !== 10/);
});

test('la copia se entrega como bundle temporal y permite compatibilidad con una rotación anterior', async () => {
  const handoff = await read('../assets/js/services/recovery-handoff.js');
  const controller = await readControllerSource();
  const view = await readAppViewSource();
  assert.match(handoff, /createPendingRecoveryCodeBundle/);
  assert.match(handoff, /rotation_bundle/);
  assert.match(handoff, /purpose: 'registration'/);
  assert.match(handoff, /adaptPendingRegistrationToSingleCode/);
  assert.match(handoff, /recoveryCodes\.length !== 10/);
  assert.match(controller, /pending\.purpose === 'rotation'/);
  assert.match(controller, /pending\.recoveryCodes/);
  assert.match(view, /recovery-vault-export-form/);
  assert.match(view, /recovery-vault-import-form/);
});

test('el workflow diario nunca sube volcados sin cifrar a GitHub Actions artifacts', async () => {
  const workflow = await read('../.github/workflows/backup-database.yml');
  const script = await read('../scripts/backup/create-backup.sh');
  assert.match(workflow, /schedule:[\s\S]*cron: '25 7 \* \* \*'/);
  assert.match(workflow, /environment:\s*database-backups/);
  assert.match(workflow, /NR_BACKUP_DATABASE_URL:\s*\$\{\{ secrets\.NR_BACKUP_DATABASE_URL \}\}/);
  assert.match(script, /supabase db dump --remote=\"\$NR_BACKUP_DATABASE_URL\"/);
  assert.match(script, /read_migration_history/);
  assert.match(script, /--role-only/);
  assert.match(script, /--schema public/);
  assert.match(script, /--data-only --use-copy/);
  assert.match(script, /age -r \"\$NR_BACKUP_AGE_RECIPIENT\"/);
  assert.match(script, /aws s3 cp \"\$encrypted\"/);
  assert.match(script, /sha256sum/);
  assert.match(script, /roundtrip/);
  assert.match(script, /schema-after\.sql/);
  assert.match(script, /row_counts_before/);
  assert.match(script, /consistencyChecks/);
  assert.match(script, /monthly/);
  assert.match(script, /app_users/);
  assert.doesNotMatch(workflow, /upload-artifact/);
});

test('el script de restauración protege el proyecto de producción y exige un destino vacío', async () => {
  const script = await read('../scripts/backup/restore-to-isolated.sh');
  assert.match(script, /production_ref='tiqbmuubpbmxqvtkcdhq'/);
  assert.match(script, /RESTORE_TO_ISOLATED_PROJECT/);
  assert.match(script, /sha256sum/);
  assert.match(script, /archive_members/);
  assert.match(script, /NR_RESTORE_CHECKSUM_FILE/);
  assert.match(script, /NR_RESTORE_EXPECTED_COUNTS/);
  assert.match(script, /isolated_backup_restore/);
  assert.match(script, /existing_objects/);
  assert.match(script, /public.*not empty|public.*objetos|public del destino no está vacío/i);
  assert.match(script, /--single-transaction/);
  assert.match(script, /NR_RESTORE_ALLOW_CROSS_PROJECT/);
});

test('la licencia no declara MIT y el README refleja derechos reservados', async () => {
  const readme = await read('../README.md');
  const license = await read('../LICENSE');
  assert.doesNotMatch(readme, /License-MIT|licencia MIT|términos de la licencia MIT/i);
  assert.match(readme, /Todos los derechos reservados/);
  assert.match(license, /All rights reserved/i);
  assert.match(license, /no se concede una licencia general/i);
  assert.match(license, /por sí sola, no concede permisos de reutilización/i);
});

test('el ejecutor pgTAP usa psql en una base aislada y bloquea producción', async () => {
  const runner = await read('../scripts/run-db-tests.mjs');
  assert.match(runner, /NR_TEST_CONFIRM_ISOLATED !== 'YES'/);
  assert.match(runner, /productionProjectRef/);
  assert.match(runner, /new URL\(databaseUrl\)/);
  assert.match(runner, /spawnSync\('psql'/);
  assert.match(runner, /CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions/);
  assert.match(runner, /SET search_path TO extensions, public/);
  assert.match(runner, /not ok/);
  assert.doesNotMatch(runner, /supabase', \[.*test.*db/);
});

test('los scripts de respaldo pasan la validación sintáctica Bash', async () => {
  for (const path of ['../scripts/backup/create-backup.sh', '../scripts/backup/restore-to-isolated.sh']) {
    const source = await read(path);
    const result = spawnSync('bash', ['-n'], { input: source, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr || `${path} no pasó bash -n`);
  }
});


test('un reintento de alta con bundle mantiene bloqueados invitación, nombre y usuario', async () => {
  const view = await readAppViewSource();
  const controller = await readControllerSource();
  assert.match(view, /\['registration', 'registration_bundle'\]\.includes\(pending\?\.purpose\)/);
  assert.match(controller, /\['registration', 'registration_bundle'\]\.includes\(pending\?\.purpose\)/);
});

test('una restauración en un proyecto aislado revoca sesiones y refresh tokens importados', async () => {
  const script = await read('../scripts/backup/restore-to-isolated.sh');
  assert.match(script, /isolated_backup_restore/);
  assert.match(script, /update public\.user_session_refresh_tokens/);
  assert.match(script, /where revoked_at is null/);
});
