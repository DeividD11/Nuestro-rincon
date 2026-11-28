import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = path => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

test('la CSP permite Blob solo para imágenes y no abre script-src', async () => {
  const html = await read('index.html');
  const csp = html.match(/Content-Security-Policy" content="([^"]+)"/)?.[1] || '';
  const img = csp.match(/(?:^|; )img-src ([^;]+)/)?.[1] || '';
  const scripts = csp.match(/(?:^|; )script-src ([^;]+)/)?.[1] || '';
  assert.match(img, /\bblob:/);
  assert.doesNotMatch(scripts, /\bblob:/);
  assert.match(await read('assets/js/services/image-processing.js'), /URL\.createObjectURL/);
  assert.match(await read('assets/js/controllers/settings-controller.js'), /URL\.createObjectURL/);
});

test('la purga registra las imágenes en una cola idempotente y solo borra por Storage API', async () => {
  const migration = await read('supabase/migrations/20261125010000_private_media_cleanup_queue.sql');
  const storage = await read('supabase/functions/_shared/storage.ts');
  const letters = await read('supabase/functions/letters-api/index.ts');
  assert.match(migration, /private_media_cleanup_jobs/);
  assert.match(migration, /before update of body on public\.letters/);
  assert.match(migration, /before delete on public\.letter_versions/);
  assert.match(migration, /for update skip locked/);
  assert.match(migration, /not exists \([\s\S]*public\.letters/);
  assert.match(migration, /not exists \([\s\S]*public\.letter_versions/);
  assert.match(migration, /grant execute[\s\S]*to service_role/);
  assert.match(letters, /case 'purge':[\s\S]*processPendingPrivateMediaCleanup/);
  assert.match(letters, /case 'draft:save':[\s\S]*processPendingPrivateMediaCleanup/);
  assert.match(letters, /case 'media:cleanup-pending'/);
  assert.match(storage, /MEDIA_STORAGE_HTTP_404[\s\S]*return/);
  assert.doesNotMatch(`${migration}\n${storage}`, /delete\s+from\s+storage\.objects/i);
});

test('el workflow de respaldo cifra también los objetos privados y usa un secreto fuera del repositorio', async () => {
  const workflow = await read('.github/workflows/backup-database.yml');
  const backup = await read('scripts/backup/create-backup.sh');
  const helper = await read('scripts/backup/storage-objects.mjs');
  assert.match(workflow, /NR_BACKUP_STORAGE_SERVICE_KEY: \$\{\{ secrets\.NR_BACKUP_STORAGE_SERVICE_KEY \}\}/);
  assert.match(backup, /storage-objects\.mjs" backup/);
  assert.match(backup, /formatVersion: 2/);
  assert.match(backup, /storage-manifest\.json/);
  assert.match(backup, /age -r/);
  assert.match(helper, /createHash\('sha256'\)/);
  assert.match(helper, /STORAGE_OBJECT_PATH_UNSUPPORTED/);
  assert.match(helper, /RESTORE_BUCKET_MUST_BE_PRIVATE/);
});

test('la restauración valida manifiestos, evita rutas TAR inseguras y bloquea producción', async () => {
  const restore = await read('scripts/backup/restore-to-isolated.sh');
  const helper = await read('scripts/backup/storage-objects.mjs');
  assert.match(restore, /production_ref='tiqbmuubpbmxqvtkcdhq'/);
  assert.match(restore, /NR_RESTORE_STORAGE_SERVICE_KEY/);
  assert.match(restore, /El TAR contiene una ruta insegura/);
  assert.match(restore, /El TAR contiene enlaces/);
  assert.match(restore, /storage-manifest\.json/);
  assert.match(restore, /storage-objects\.mjs" restore/);
  assert.match(helper, /RESTORE_STORAGE_COLLISION/);
  assert.match(helper, /STORAGE_RESTORE_POST_UPLOAD_CHECKSUM_MISMATCH/);
});
