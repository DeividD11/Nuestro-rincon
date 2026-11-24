const BUCKET = 'private-media';
const BUCKET_LIMIT_BYTES = 5 * 1024 * 1024;
const ALLOWED_MEDIA_MIME = ['image/jpeg', 'image/png', 'image/webp'];

// Se memoriza por instancia si el proyecto permite transformaciones de imagen.
// En planes/proyectos sin esta función se usa la URL privada original.
let privateImageTransformsAvailable: boolean | null = null;

type PrivateSignedUrlCacheEntry = { url: string; expiresAt: number };
const privateSignedUrlCache = new Map<string, PrivateSignedUrlCacheEntry>();
const privateSignedUrlPending = new Map<string, Promise<string>>();

function cachedPrivateUrl(key: string): string | null {
  const entry = privateSignedUrlCache.get(key);
  if (!entry) return null;
  if (entry.expiresAt <= Date.now()) {
    privateSignedUrlCache.delete(key);
    return null;
  }
  // LRU sencillo: las firmas más utilizadas permanecen al final del Map.
  privateSignedUrlCache.delete(key);
  privateSignedUrlCache.set(key, entry);
  return entry.url;
}

function rememberPrivateUrl(key: string, url: string, expiresIn: number): string {
  const lifetime = Math.max(30, Math.min(expiresIn - 120, 22 * 60 * 60)) * 1000;
  privateSignedUrlCache.set(key, { url, expiresAt: Date.now() + lifetime });
  for (const [entryKey, entry] of privateSignedUrlCache) {
    if (entry.expiresAt <= Date.now()) privateSignedUrlCache.delete(entryKey);
    if (privateSignedUrlCache.size <= 2048) break;
  }
  while (privateSignedUrlCache.size > 2048) {
    const oldestKey = privateSignedUrlCache.keys().next().value;
    if (!oldestKey) break;
    privateSignedUrlCache.delete(oldestKey);
  }
  return url;
}

function rememberTransformAvailabilityError(error: unknown): void {
  const message = String((error as Error)?.message || error || '');
  // Solo memorizar errores propios de disponibilidad/permisos de la función.
  // Un error temporal de red o un objeto inexistente no debe desactivar las
  // transformaciones para todas las demás imágenes de la instancia.
  if (message === 'MEDIA_IMAGE_TRANSFORM_UNAVAILABLE' || /^MEDIA_STORAGE_HTTP_(400|402|403|422)$/.test(message)) {
    privateImageTransformsAvailable = false;
  }
}

function projectUrl(): string {
  const value = Deno.env.get('SUPABASE_URL');
  if (!value) throw new Error('MISSING_SUPABASE_URL');
  return value.replace(/\/$/, '');
}

function serviceHeaders(extra: HeadersInit = {}): Headers {
  let secret = '';
  let legacyJwt = false;
  const raw = Deno.env.get('SUPABASE_SECRET_KEYS');
  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      if (typeof parsed?.default === 'string' && parsed.default) secret = parsed.default;
    } catch { throw new Error('MEDIA_STORAGE_CONFIGURATION_INVALID'); }
  }
  if (!secret) {
    secret = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';
    legacyJwt = Boolean(secret);
  }
  if (!secret) throw new Error('MISSING_SUPABASE_SERVER_SECRET');
  const headers = new Headers(extra);
  headers.set('apikey', secret);
  // Las nuevas claves sb_secret_* son claves opacas, no JWT: se envían solo
  // mediante apikey. El Bearer se conserva únicamente para service_role JWT legado.
  headers.delete('Authorization');
  if (legacyJwt) headers.set('Authorization', `Bearer ${secret}`);
  headers.set('Cache-Control', 'no-store');
  return headers;
}

function encodePath(path: string): string {
  return path.split('/').map(segment => encodeURIComponent(segment)).join('/');
}

async function storageFetch(url: string, init: RequestInit = {}): Promise<Response> {
  try {
    return await fetch(url, { ...init, cache: 'no-store' });
  } catch {
    throw new Error('MEDIA_STORAGE_NETWORK_ERROR');
  }
}

async function storageRequest(path: string, init: RequestInit = {}): Promise<{ response: Response; data: Record<string, unknown> }> {
  const headers = serviceHeaders(init.headers || {});
  if (init.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
  const response = await storageFetch(`${projectUrl()}/storage/v1/${path}`, { ...init, headers });
  let data: Record<string, unknown> = {};
  try {
    const value: unknown = await response.json();
    if (value && typeof value === 'object' && !Array.isArray(value)) data = value as Record<string, unknown>;
  } catch { /* Responses without JSON are handled by the status. */ }
  if (!response.ok) throw new Error(`MEDIA_STORAGE_HTTP_${response.status}`);
  return { response, data };
}

/**
 * El bucket se prepara mediante Storage API (no mediante DML sobre storage.buckets).
 * Esto permite que el primer avatar/adjunto funcione en un proyecto recién
 * preparado, conservando siempre el acceso privado y los límites previstos.
 */
export async function ensurePrivateMediaBucket(): Promise<void> {
  const bucketPath = `bucket/${BUCKET}`;
  const headers = serviceHeaders();
  const base = `${projectUrl()}/storage/v1/`;
  const readBucket = async (): Promise<Record<string, unknown> | null> => {
    const response = await storageFetch(`${base}${bucketPath}`, { method: 'GET', headers });
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`MEDIA_BUCKET_READ_HTTP_${response.status}`);
    const value: unknown = await response.json();
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('MEDIA_BUCKET_RESPONSE_INVALID');
    return value as Record<string, unknown>;
  };

  let bucket = await readBucket();
  const desired = {
    public: false,
    file_size_limit: BUCKET_LIMIT_BYTES,
    allowed_mime_types: ALLOWED_MEDIA_MIME
  };
  if (!bucket) {
    const response = await storageFetch(`${base}bucket`, {
      method: 'POST',
      headers: serviceHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ id: BUCKET, name: BUCKET, ...desired })
    });
    if (!response.ok && response.status !== 409) throw new Error(`MEDIA_BUCKET_CREATE_HTTP_${response.status}`);
    bucket = await readBucket();
    if (!bucket) throw new Error('MEDIA_BUCKET_CREATE_FAILED');
  }

  const currentMime = Array.isArray(bucket.allowed_mime_types)
    ? bucket.allowed_mime_types.map(value => String(value).toLowerCase()).sort()
    : [];
  const desiredMime = [...ALLOWED_MEDIA_MIME].sort();
  const needsUpdate = bucket.public !== false
    || Number(bucket.file_size_limit) !== BUCKET_LIMIT_BYTES
    || currentMime.length !== desiredMime.length
    || currentMime.some((value, index) => value !== desiredMime[index]);
  if (needsUpdate) {
    const response = await storageFetch(`${base}${bucketPath}`, {
      method: 'PUT',
      headers: serviceHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify(desired)
    });
    if (!response.ok) throw new Error(`MEDIA_BUCKET_CONFIGURATION_HTTP_${response.status}`);
    const verified = await readBucket();
    if (!verified || verified.public !== false || Number(verified.file_size_limit) !== BUCKET_LIMIT_BYTES) {
      throw new Error('MEDIA_BUCKET_CONFIGURATION_FAILED');
    }
    const verifiedMime = Array.isArray(verified.allowed_mime_types)
      ? verified.allowed_mime_types.map(value => String(value).toLowerCase()).sort() : [];
    if (verifiedMime.length !== desiredMime.length || verifiedMime.some((value, index) => value !== desiredMime[index])) {
      throw new Error('MEDIA_BUCKET_CONFIGURATION_FAILED');
    }
  }
}

export async function createPrivateUploadUrl(path: string): Promise<string> {
  await ensurePrivateMediaBucket();
  const { data } = await storageRequest(`object/upload/sign/${BUCKET}/${encodePath(path)}`, {
    method: 'POST', body: JSON.stringify({})
  });
  const token = String(data.token || '');
  if (!token) throw new Error('MEDIA_UPLOAD_URL_INVALID');
  return `${projectUrl()}/storage/v1/object/upload/sign/${BUCKET}/${encodePath(path)}?token=${encodeURIComponent(token)}`;
}

type PrivateImageTransform = Readonly<{
  width: number;
  height: number;
  resize: 'cover' | 'contain' | 'fill';
  quality: number;
}>;

export async function createPrivateReadUrl(
  path: string,
  expiresIn = 86400,
  transform?: PrivateImageTransform
): Promise<string> {
  const duration = Math.min(86400, Math.max(60, Math.trunc(expiresIn)));
  const transformKey = transform
    ? `${transform.width}x${transform.height}:${transform.resize}:${transform.quality}`
    : 'original';
  const cacheKey = `${path}|${duration}|${transformKey}`;
  const cached = cachedPrivateUrl(cacheKey);
  if (cached) return cached;
  const pending = privateSignedUrlPending.get(cacheKey);
  if (pending) return pending;
  const request = (async () => {
    const payload: Record<string, unknown> = { expiresIn: duration };
    if (transform) payload.transform = transform;
    const { data } = await storageRequest(`object/sign/${BUCKET}/${encodePath(path)}`, {
      method: 'POST', body: JSON.stringify(payload)
    });
    const raw = String(data.signedURL || data.signedUrl || data.url || '');
    if (!raw) throw new Error('MEDIA_SIGNED_URL_INVALID');
    const signed = /^https:\/\//i.test(raw)
      ? raw
      : `${projectUrl()}${raw.startsWith('/storage/v1/') ? raw : raw.startsWith('/') ? `/storage/v1${raw}` : `/${raw}`}`;
    return rememberPrivateUrl(cacheKey, signed, duration);
  })();
  privateSignedUrlPending.set(cacheKey, request);
  try { return await request; }
  finally { if (privateSignedUrlPending.get(cacheKey) === request) privateSignedUrlPending.delete(cacheKey); }
}

/**
 * Firma un avatar pequeño y cuadrado para la interfaz. El original privado
 * permanece intacto y se usa automáticamente cuando no hay transformaciones.
 */
export async function createPrivateAvatarUrl(path: string, expiresIn = 86400): Promise<string> {
  if (privateImageTransformsAvailable === false) return createPrivateReadUrl(path, expiresIn);
  try {
    const optimized = await createPrivateReadUrl(path, expiresIn, {
      width: 256, height: 256, resize: 'cover', quality: 78
    });
    const url = new URL(optimized);
    if (!url.pathname.startsWith(`/storage/v1/render/image/sign/${BUCKET}/`)) {
      throw new Error('MEDIA_IMAGE_TRANSFORM_UNAVAILABLE');
    }
    privateImageTransformsAvailable = true;
    return url.href;
  } catch (error) {
    rememberTransformAvailabilityError(error);
    return createPrivateReadUrl(path, expiresIn);
  }
}

/**
 * Firma una miniatura privada cuadrada y pequeña para letter-stamp. Si Storage
 * no tiene habilitadas las transformaciones (p. ej. plan sin esa función),
 * recuerda ese estado en la instancia y usa la URL privada original.
 */
export async function createPrivateThumbnailUrl(path: string, expiresIn = 86400): Promise<string> {
  if (privateImageTransformsAvailable === false) return createPrivateReadUrl(path, expiresIn);
  try {
    const optimized = await createPrivateReadUrl(path, expiresIn, {
      width: 96, height: 96, resize: 'cover', quality: 72
    });
    const url = new URL(optimized);
    if (!url.pathname.startsWith(`/storage/v1/render/image/sign/${BUCKET}/`)) {
      throw new Error('MEDIA_IMAGE_TRANSFORM_UNAVAILABLE');
    }
    privateImageTransformsAvailable = true;
    return url.href;
  } catch (error) {
    rememberTransformAvailabilityError(error);
    return createPrivateReadUrl(path, expiresIn);
  }
}

/**
 * URL firmada optimizada para imágenes dentro de una carta. Se limita a un
 * tamaño de visualización razonable y nunca modifica el objeto original.
 * Si el proyecto no ofrece transformaciones, conserva el acceso privado y
 * recurre al archivo original sin interrumpir la lectura.
 */
export async function createPrivateDisplayUrl(path: string, expiresIn = 86400): Promise<string> {
  if (privateImageTransformsAvailable === false) return createPrivateReadUrl(path, expiresIn);
  try {
    const optimized = await createPrivateReadUrl(path, expiresIn, {
      width: 1440, height: 1440, resize: 'contain', quality: 78
    });
    const url = new URL(optimized);
    if (!url.pathname.startsWith(`/storage/v1/render/image/sign/${BUCKET}/`)) {
      throw new Error('MEDIA_IMAGE_TRANSFORM_UNAVAILABLE');
    }
    privateImageTransformsAvailable = true;
    return url.href;
  } catch (error) {
    rememberTransformAvailabilityError(error);
    return createPrivateReadUrl(path, expiresIn);
  }
}

export async function privateObjectExists(path: string): Promise<boolean> {
  const headers = serviceHeaders();
  const response = await storageFetch(`${projectUrl()}/storage/v1/object/${BUCKET}/${encodePath(path)}`, {
    method: 'HEAD', headers
  });
  if (response.status === 404) return false;
  if (!response.ok) throw new Error(`MEDIA_STORAGE_HTTP_${response.status}`);
  return true;
}

export async function deletePrivateObject(path: string): Promise<void> {
  await storageRequest(`object/${BUCKET}/${encodePath(path)}`, { method: 'DELETE' });
}
