import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { backupStorageObjects, restoreStorageObjects } from '../scripts/backup/storage-objects.mjs';

const projectRef = '01234567890123456789';
const key = 'eyJhbGciOiJIUzI1NiJ9.test.signature';
const userId = '10000000-0000-4000-8000-000000000001';
const imageId = '20000000-0000-4000-8000-000000000002';
const imagePath = `${userId}/avatars/${imageId}.webp`;
const bytes = Buffer.from('fixture-webp-image-bytes');
const hash = createHash('sha256').update(bytes).digest('hex');
const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });

function withFetch(handler) {
  const original = globalThis.fetch;
  globalThis.fetch = handler;
  return () => { globalThis.fetch = original; };
}

test('backup de Storage enumera carpetas, descarga solo objetos permitidos y verifica SHA-256', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'nr-storage-backup-'));
  let listCalls = 0;
  const restoreFetch = withFetch(async (input, init = {}) => {
    const url = new URL(input);
    if (url.pathname === '/storage/v1/object/list/private-media') {
      const { prefix } = JSON.parse(init.body || '{}');
      listCalls++;
      const listings = {
        '': [{ name: userId, id: null, metadata: null }],
        [userId]: [{ name: 'avatars', id: null, metadata: null }],
        [`${userId}/avatars`]: [{ name: `${imageId}.webp`, id: 'object-1', metadata: { mimetype: 'image/webp' } }]
      };
      return json(listings[prefix] || []);
    }
    if (url.pathname === `/storage/v1/object/authenticated/private-media/${imagePath}`) {
      return new Response(bytes, { status: 200, headers: { 'content-type': 'image/webp' } });
    }
    throw new Error(`Unexpected request: ${init.method || 'GET'} ${url.pathname}`);
  });
  try {
    const result = await backupStorageObjects({ projectRef, key, destination: directory });
    assert.deepEqual({ objectCount: result.objectCount, totalBytes: result.totalBytes }, { objectCount: 1, totalBytes: bytes.length });
    assert.equal(listCalls, 6, 'se inspecciona el inventario antes y después de descargar');
    assert.deepEqual(await readFile(join(directory, 'storage', 'objects', imagePath)), bytes);
    const manifest = JSON.parse(await readFile(join(directory, 'storage-manifest.json'), 'utf8'));
    assert.equal(manifest.objectCount, 1);
    assert.equal(manifest.objects[0].path, imagePath);
    assert.equal(manifest.objects[0].sha256, hash);
  } finally {
    restoreFetch();
    await rm(directory, { recursive: true, force: true });
  }
});

test('restore de Storage es idempotente y no sobrescribe un objeto distinto', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'nr-storage-restore-'));
  const objectFile = join(directory, 'storage', 'objects', imagePath);
  await mkdir(join(directory, 'storage', 'objects', userId, 'avatars'), { recursive: true });
  await writeFile(objectFile, bytes);
  await writeFile(join(directory, 'storage-manifest.json'), JSON.stringify({
    format: 'nuestro-rincon-storage-backup', formatVersion: 1, projectRef,
    bucket: 'private-media', createdAt: new Date().toISOString(),
    objectCount: 1, totalBytes: bytes.length,
    objects: [{ path: imagePath, size: bytes.length, contentType: 'image/webp', sha256: hash }]
  }));

  let stored = null;
  let uploadCount = 0;
  const restoreFetch = withFetch(async (input, init = {}) => {
    const url = new URL(input);
    if (url.pathname === '/storage/v1/bucket/private-media' && (init.method || 'GET') === 'GET') {
      return json({ id: 'private-media', name: 'private-media', public: false, file_size_limit: 5242880, allowed_mime_types: ['image/jpeg','image/png','image/webp'] });
    }
    if (url.pathname === `/storage/v1/object/authenticated/private-media/${imagePath}` && (init.method || 'GET') === 'GET') {
      return stored
        ? new Response(stored, { status: 200, headers: { 'content-type': 'image/webp' } })
        : new Response('', { status: 404 });
    }
    if (url.pathname === `/storage/v1/object/private-media/${imagePath}` && init.method === 'POST') {
      stored = Buffer.from(init.body);
      uploadCount++;
      return json({ Key: imagePath });
    }
    throw new Error(`Unexpected request: ${init.method || 'GET'} ${url.pathname}`);
  });
  try {
    const first = await restoreStorageObjects({ projectRef, key, sourceDirectory: directory });
    assert.deepEqual(first, { objectCount: 1, totalBytes: bytes.length, uploaded: 1, alreadyPresent: 0 });
    const second = await restoreStorageObjects({ projectRef, key, sourceDirectory: directory });
    assert.deepEqual(second, { objectCount: 1, totalBytes: bytes.length, uploaded: 0, alreadyPresent: 1 });
    assert.equal(uploadCount, 1);
  } finally {
    restoreFetch();
    await rm(directory, { recursive: true, force: true });
  }
});

test('restore rechaza un archivo cuyo SHA-256 no coincide con el manifiesto', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'nr-storage-tamper-'));
  await mkdir(join(directory, 'storage', 'objects', userId, 'avatars'), { recursive: true });
  await writeFile(join(directory, 'storage', 'objects', imagePath), Buffer.from('tampered'));
  await writeFile(join(directory, 'storage-manifest.json'), JSON.stringify({
    format: 'nuestro-rincon-storage-backup', formatVersion: 1, projectRef,
    bucket: 'private-media', createdAt: new Date().toISOString(),
    objectCount: 1, totalBytes: bytes.length,
    objects: [{ path: imagePath, size: bytes.length, contentType: 'image/webp', sha256: hash }]
  }));
  let calls = 0;
  const restoreFetch = withFetch(async () => { calls++; return json({}); });
  try {
    await assert.rejects(restoreStorageObjects({ projectRef, key, sourceDirectory: directory }), /STORAGE_BACKUP_FILE_SIZE_MISMATCH/);
    assert.equal(calls, 0, 'no contacta el proyecto de destino cuando el respaldo local no pasa el checksum');
  } finally {
    restoreFetch();
    await rm(directory, { recursive: true, force: true });
  }
});
