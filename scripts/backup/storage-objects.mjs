#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, stat } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const BUCKET = 'private-media';
const BUCKET_LIMIT = 5 * 1024 * 1024;
const ALLOWED_MIME = new Set(['image/jpeg', 'image/png', 'image/webp']);
const PAGE_SIZE = 100;
const MAX_OBJECTS = 100_000;
const MAX_TOTAL_BYTES = 10 * 1024 * 1024 * 1024; // 10 GiB por ejecución; evita copias accidentales ilimitadas.
const MAX_CONCURRENCY = 4;
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';
const AVATAR_PATH = new RegExp(`^${UUID}/avatars/${UUID}\\.(?:jpg|jpeg|png|webp)$`, 'i');
const LETTER_PATH = new RegExp(`^letters/${UUID}/${UUID}/${UUID}\\.(?:jpg|jpeg|png|webp)$`, 'i');

function sha256(buffer) { return createHash('sha256').update(buffer).digest('hex'); }
function safePath(path) {
  return typeof path === 'string' && path.length <= 512
    && !path.startsWith('/') && !path.includes('\\')
    && path.split('/').every(part => part && part !== '.' && part !== '..')
    && (AVATAR_PATH.test(path) || LETTER_PATH.test(path));
}
function projectUrl(ref) {
  if (!/^[a-z0-9]{20}$/.test(ref || '')) throw new Error('PROJECT_REF_INVALID');
  return `https://${ref}.supabase.co`;
}
function authHeaders(key, extra = {}) {
  if (typeof key !== 'string' || key.length < 20 || key.length > 4096) throw new Error('STORAGE_KEY_MISSING_OR_INVALID');
  const headers = new Headers(extra);
  headers.set('apikey', key);
  // Legacy service_role keys are JWTs; modern sb_secret keys are opaque and use apikey only.
  if (/^eyJ[A-Za-z0-9_-]+\./.test(key)) headers.set('Authorization', `Bearer ${key}`);
  headers.set('Cache-Control', 'no-store');
  return headers;
}
async function requestJson(base, key, path, init = {}) {
  const headers = authHeaders(key, init.headers || {});
  if (init.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
  let response;
  try {
    response = await fetch(`${base}/storage/v1/${path}`, {
      ...init, headers, cache: 'no-store', signal: init.signal || AbortSignal.timeout(45_000)
    });
  } catch {
    throw new Error('STORAGE_NETWORK_ERROR');
  }
  const body = await response.text();
  let value = null;
  try { value = body ? JSON.parse(body) : null; } catch { value = null; }
  if (!response.ok) throw new Error(`STORAGE_HTTP_${response.status}`);
  return value;
}
function encodePath(path) { return path.split('/').map(encodeURIComponent).join('/'); }
function joinPrefix(prefix, name) {
  const value = String(name || '');
  if (!value || value.startsWith('/') || value.includes('\\')
    || value.split('/').some(part => !part || part === '.' || part === '..')) {
    throw new Error('STORAGE_PATH_INVALID');
  }
  const path = !prefix || value.startsWith(`${prefix}/`) ? value : `${prefix}/${value}`;
  if (path.length > 512 || path.split('/').some(part => !part || part === '.' || part === '..')) {
    throw new Error('STORAGE_PATH_INVALID');
  }
  return path;
}

export async function listPrivateStorageObjects({ base, key }) {
  const files = new Map();
  const folders = [''];
  const visited = new Set();
  while (folders.length) {
    const prefix = folders.shift();
    if (visited.has(prefix)) continue;
    visited.add(prefix);
    let offset = 0;
    while (true) {
      const rows = await requestJson(base, key, `object/list/${BUCKET}`, {
        method: 'POST',
        body: JSON.stringify({
          prefix,
          limit: PAGE_SIZE,
          offset,
          sortBy: { column: 'name', order: 'asc' }
        })
      });
      if (!Array.isArray(rows)) throw new Error('STORAGE_LIST_RESPONSE_INVALID');
      for (const row of rows) {
        const objectPath = joinPrefix(prefix, row?.name);
        const isFolder = row?.id == null || row?.metadata == null;
        if (isFolder) {
          if (objectPath !== prefix) folders.push(objectPath);
          continue;
        }
        if (!safePath(objectPath)) throw new Error('STORAGE_OBJECT_PATH_UNSUPPORTED');
        files.set(objectPath, row);
        if (files.size > MAX_OBJECTS) throw new Error('STORAGE_OBJECT_LIMIT_EXCEEDED');
      }
      if (rows.length < PAGE_SIZE) break;
      offset += rows.length;
    }
  }
  return [...files.keys()].sort();
}

async function runWithConcurrency(items, concurrency, worker) {
  let cursor = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (true) {
      const index = cursor++;
      if (index >= items.length) return;
      await worker(items[index], index);
    }
  });
  await Promise.all(workers);
}

export async function backupStorageObjects({ projectRef, key, destination }) {
  const base = projectUrl(projectRef);
  const root = resolve(destination);
  const objects = await listPrivateStorageObjects({ base, key });
  const entries = [];
  let totalBytes = 0;
  await runWithConcurrency(objects, MAX_CONCURRENCY, async objectPath => {
    const response = await fetch(`${base}/storage/v1/object/authenticated/${BUCKET}/${encodePath(objectPath)}`, {
      method: 'GET', headers: authHeaders(key), cache: 'no-store', signal: AbortSignal.timeout(60_000)
    }).catch(() => { throw new Error('STORAGE_DOWNLOAD_NETWORK_ERROR'); });
    if (!response.ok) throw new Error(`STORAGE_DOWNLOAD_HTTP_${response.status}`);
    const contentType = String(response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    if (!ALLOWED_MIME.has(contentType)) throw new Error('STORAGE_OBJECT_MIME_UNSUPPORTED');
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length < 1 || bytes.length > BUCKET_LIMIT) throw new Error('STORAGE_OBJECT_SIZE_INVALID');
    if (totalBytes + bytes.length > MAX_TOTAL_BYTES) throw new Error('STORAGE_BACKUP_TOTAL_SIZE_LIMIT');
    const destinationPath = resolve(root, 'storage', 'objects', ...objectPath.split('/'));
    const expectedRoot = resolve(root, 'storage', 'objects') + sep;
    if (!destinationPath.startsWith(expectedRoot)) throw new Error('STORAGE_PATH_TRAVERSAL_BLOCKED');
    await mkdir(dirname(destinationPath), { recursive: true, mode: 0o700 });
    await writeFile(destinationPath, bytes, { mode: 0o600, flag: 'wx' });
    entries.push({ path: objectPath, size: bytes.length, contentType, sha256: sha256(bytes) });
    totalBytes += bytes.length;
  });

  const afterDownload = await listPrivateStorageObjects({ base, key });
  if (JSON.stringify(afterDownload) !== JSON.stringify(objects)) {
    throw new Error('STORAGE_OBJECT_SET_CHANGED_DURING_BACKUP');
  }
  entries.sort((a, b) => a.path.localeCompare(b.path));
  const manifest = {
    format: 'nuestro-rincon-storage-backup',
    formatVersion: 1,
    projectRef,
    bucket: BUCKET,
    createdAt: new Date().toISOString(),
    objectCount: entries.length,
    totalBytes,
    objects: entries
  };
  await mkdir(resolve(root, 'storage', 'objects'), { recursive: true, mode: 0o700 });
  await writeFile(resolve(root, 'storage-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
  return { objectCount: entries.length, totalBytes, manifest: resolve(root, 'storage-manifest.json') };
}

async function ensurePrivateBucket({ base, key }) {
  let bucket;
  try {
    bucket = await requestJson(base, key, `bucket/${BUCKET}`, { method: 'GET' });
  } catch (error) {
    if (!(error instanceof Error) || error.message !== 'STORAGE_HTTP_404') throw error;
    try {
      await requestJson(base, key, 'bucket', {
        method: 'POST',
        body: JSON.stringify({ id: BUCKET, name: BUCKET, public: false, file_size_limit: BUCKET_LIMIT, allowed_mime_types: [...ALLOWED_MIME] })
      });
    } catch (createError) {
      if (!(createError instanceof Error) || createError.message !== 'STORAGE_HTTP_409') throw createError;
    }
    bucket = await requestJson(base, key, `bucket/${BUCKET}`, { method: 'GET' });
  }
  if (!bucket || bucket.public !== false) throw new Error('RESTORE_BUCKET_MUST_BE_PRIVATE');
  const currentMime = Array.isArray(bucket.allowed_mime_types)
    ? bucket.allowed_mime_types.map(value => String(value).toLowerCase()).sort() : [];
  const requiredMime = [...ALLOWED_MIME].sort();
  const needsUpdate = Number(bucket.file_size_limit) !== BUCKET_LIMIT
    || currentMime.length !== requiredMime.length
    || currentMime.some((value, index) => value !== requiredMime[index]);
  if (needsUpdate) {
    await requestJson(base, key, `bucket/${BUCKET}`, {
      method: 'PUT',
      body: JSON.stringify({ public: false, file_size_limit: BUCKET_LIMIT, allowed_mime_types: [...ALLOWED_MIME] })
    });
    const verified = await requestJson(base, key, `bucket/${BUCKET}`, { method: 'GET' });
    const verifiedMime = Array.isArray(verified?.allowed_mime_types)
      ? verified.allowed_mime_types.map(value => String(value).toLowerCase()).sort() : [];
    if (!verified || verified.public !== false || Number(verified.file_size_limit) !== BUCKET_LIMIT
      || JSON.stringify(verifiedMime) !== JSON.stringify(requiredMime)) {
      throw new Error('RESTORE_BUCKET_CONFIGURATION_FAILED');
    }
  }
}

async function downloadObject({ base, key, objectPath }) {
  const response = await fetch(`${base}/storage/v1/object/authenticated/${BUCKET}/${encodePath(objectPath)}`, {
    method: 'GET', headers: authHeaders(key), cache: 'no-store', signal: AbortSignal.timeout(60_000)
  }).catch(() => { throw new Error('STORAGE_VERIFY_NETWORK_ERROR'); });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`STORAGE_VERIFY_HTTP_${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}

export async function restoreStorageObjects({ projectRef, key, sourceDirectory }) {
  const base = projectUrl(projectRef);
  const root = resolve(sourceDirectory);
  const manifestPath = resolve(root, 'storage-manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  if (manifest?.format !== 'nuestro-rincon-storage-backup' || manifest?.formatVersion !== 1
    || manifest?.bucket !== BUCKET || !/^[a-z0-9]{20}$/.test(manifest?.projectRef || '')
    || !Array.isArray(manifest.objects) || manifest.objectCount !== manifest.objects.length
    || manifest.objectCount > MAX_OBJECTS
    || !Number.isSafeInteger(manifest.totalBytes) || manifest.totalBytes < 0 || manifest.totalBytes > MAX_TOTAL_BYTES) {
    throw new Error('STORAGE_MANIFEST_INVALID');
  }
  if (!Number.isFinite(Date.parse(manifest.createdAt || ''))) throw new Error('STORAGE_MANIFEST_DATE_INVALID');
  const seen = new Set();
  let totalBytes = 0;
  const checked = [];
  for (const item of manifest.objects) {
    if (!safePath(item?.path) || seen.has(item.path)
      || !Number.isSafeInteger(item.size) || item.size < 1 || item.size > BUCKET_LIMIT
      || !ALLOWED_MIME.has(String(item.contentType || '').toLowerCase())
      || !/^[a-f0-9]{64}$/i.test(item.sha256 || '')) throw new Error('STORAGE_MANIFEST_OBJECT_INVALID');
    seen.add(item.path);
    const filePath = resolve(root, 'storage', 'objects', ...item.path.split('/'));
    const expectedRoot = resolve(root, 'storage', 'objects') + sep;
    if (!filePath.startsWith(expectedRoot)) throw new Error('STORAGE_PATH_TRAVERSAL_BLOCKED');
    const info = await stat(filePath);
    if (!info.isFile() || info.size !== item.size) throw new Error('STORAGE_BACKUP_FILE_SIZE_MISMATCH');
    const bytes = await readFile(filePath);
    if (sha256(bytes) !== item.sha256.toLowerCase()) throw new Error('STORAGE_BACKUP_CHECKSUM_MISMATCH');
    totalBytes += bytes.length;
    checked.push({ ...item, filePath });
  }
  if (totalBytes !== manifest.totalBytes) throw new Error('STORAGE_MANIFEST_TOTAL_MISMATCH');

  await ensurePrivateBucket({ base, key });
  let uploaded = 0;
  let alreadyPresent = 0;
  for (const item of checked) {
    const current = await downloadObject({ base, key, objectPath: item.path });
    if (current) {
      if (current.length !== item.size || sha256(current) !== item.sha256.toLowerCase()) {
        throw new Error('RESTORE_STORAGE_COLLISION');
      }
      alreadyPresent++;
      continue;
    }
    const bytes = await readFile(item.filePath);
    let response;
    try {
      response = await fetch(`${base}/storage/v1/object/${BUCKET}/${encodePath(item.path)}`, {
        method: 'POST',
        headers: authHeaders(key, { 'Content-Type': item.contentType, 'x-upsert': 'false' }),
        body: bytes,
        cache: 'no-store',
        signal: AbortSignal.timeout(60_000)
      });
    } catch { throw new Error('STORAGE_RESTORE_UPLOAD_NETWORK_ERROR'); }
    if (!response.ok) {
      // Un conflicto concurrente solo se acepta si el objeto que ya existe coincide byte a byte.
      if (response.status === 409 || response.status === 400) {
        const existing = await downloadObject({ base, key, objectPath: item.path });
        if (existing && existing.length === item.size && sha256(existing) === item.sha256.toLowerCase()) {
          alreadyPresent++;
          continue;
        }
      }
      throw new Error(`STORAGE_RESTORE_UPLOAD_HTTP_${response.status}`);
    }
    const verified = await downloadObject({ base, key, objectPath: item.path });
    if (!verified || verified.length !== item.size || sha256(verified) !== item.sha256.toLowerCase()) {
      throw new Error('STORAGE_RESTORE_POST_UPLOAD_CHECKSUM_MISMATCH');
    }
    uploaded++;
  }
  return { objectCount: checked.length, totalBytes, uploaded, alreadyPresent };
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : '';
if (invokedPath === fileURLToPath(import.meta.url)) {
  const [mode, directory] = process.argv.slice(2);
  if (mode === 'backup' && directory) {
    const result = await backupStorageObjects({
      projectRef: process.env.NR_BACKUP_PROJECT_REF,
      key: process.env.NR_BACKUP_STORAGE_SERVICE_KEY,
      destination: directory
    });
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } else if (mode === 'restore' && directory) {
    const result = await restoreStorageObjects({
      projectRef: process.env.NR_RESTORE_PROJECT_REF,
      key: process.env.NR_RESTORE_STORAGE_SERVICE_KEY,
      sourceDirectory: directory
    });
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } else {
    console.error('Uso: node scripts/backup/storage-objects.mjs <backup|restore> <directorio>');
    process.exit(2);
  }
}
