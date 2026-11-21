import { DOMParser } from 'linkedom';

const encoder = new TextEncoder();
const ACCESS_TTL_MS = 15 * 60 * 1000;
const IDLE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const ABSOLUTE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const PBKDF2_ITERATIONS = 600_000;

export type AppUser = {
  id: string;
  username: string;
  email: string;
  display_name: string;
  status: string;
  password_hash?: string;
};

export type AppSession = {
  userId: string;
  sessionId: string;
  user: AppUser;
  claims: Record<string, unknown>;
};

export function requiredEnv(name: string): string {
  const value = Deno.env.get(name);
  if (!value) throw new Error(`MISSING_ENV_${name}`);
  return value;
}

function decodeBase64Url(value: string): Uint8Array {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - value.length % 4) % 4);
  const binary = atob(normalized);
  return Uint8Array.from(binary, char => char.charCodeAt(0));
}

// Deno 2 / TypeScript 5.9 distinguen Uint8Array<ArrayBufferLike> de
// BufferSource. Copiamos el salt a un ArrayBuffer propio antes de Web Crypto.
function toOwnedArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return buffer;
}

export function base64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

export function randomToken(byteLength = 32): string {
  return base64Url(crypto.getRandomValues(new Uint8Array(byteLength)));
}

export async function sha256Hex(value: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(value)));
  return [...digest].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

// HMAC con la credencial privada inyectada por Supabase. Se usa para
// anonimizar la IP de intentos de invitación sin almacenar la dirección real.
export async function hmacSha256Hex(value: string): Promise<string> {
  const secret = getSecretKey().key;
  const key = await crypto.subtle.importKey(
    'raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const signature = new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(value)));
  return [...signature].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

export async function hashPassword(password: string): Promise<string> {
  if (password.length < 12 || password.length > 128) throw new Error('PASSWORD_POLICY');
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const material = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' },
    material,
    256
  );
  return `pbkdf2-sha256$${PBKDF2_ITERATIONS}$${base64Url(salt)}$${base64Url(new Uint8Array(bits))}`;
}

export async function verifyPassword(password: string, encoded: string): Promise<boolean> {
  const parts = String(encoded || '').split('$');
  if (parts.length !== 4 || parts[0] !== 'pbkdf2-sha256') return false;
  const iterations = Number(parts[1]);
  if (!Number.isInteger(iterations) || iterations < 300_000 || iterations > 1_000_000) return false;
  try {
    const salt = decodeBase64Url(parts[2]);
    const expected = decodeBase64Url(parts[3]);
    const material = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveBits']);
    const bits = new Uint8Array(await crypto.subtle.deriveBits(
      { name: 'PBKDF2', salt: toOwnedArrayBuffer(salt), iterations, hash: 'SHA-256' }, material, expected.length * 8
    ));
    const actual = base64Url(bits);
    const wanted = base64Url(expected);
    if (actual.length !== wanted.length) return false;
    let difference = 0;
    for (let index = 0; index < actual.length; index++) difference |= actual.charCodeAt(index) ^ wanted.charCodeAt(index);
    return difference === 0;
  } catch {
    return false;
  }
}

// Supabase injects this server credential into Edge Functions automatically.
// It is never copied to the browser or committed to this repository.
function getSecretKey(): { key: string; legacy: boolean } {
  const rawKeys = Deno.env.get('SUPABASE_SECRET_KEYS');
  if (rawKeys) {
    try {
      const keys = JSON.parse(rawKeys);
      if (keys.default) return { key: keys.default, legacy: false };
    } catch {
      throw new Error('INVALID_SUPABASE_SECRET_KEYS');
    }
  }
  const legacy = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (legacy) return { key: legacy, legacy: true };
  throw new Error('MISSING_SUPABASE_SERVER_SECRET');
}

function dbHeaders(extra: HeadersInit = {}): Headers {
  const secret = getSecretKey();
  const headers = new Headers(extra);
  headers.set('apikey', secret.key);
  if (secret.legacy) headers.set('Authorization', `Bearer ${secret.key}`);
  return headers;
}

function supabaseUrl(path: string): string {
  return `${requiredEnv('SUPABASE_URL').replace(/\/$/, '')}/rest/v1/${path.replace(/^\//, '')}`;
}

export async function dbRequest<T = unknown>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = dbHeaders(init.headers || {});
  if (init.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
  headers.set('Cache-Control', 'no-store');
  const response = await fetch(supabaseUrl(path), { ...init, headers, cache: 'no-store' });
  const raw = await response.text();
  let data: unknown = null;
  try { data = raw ? JSON.parse(raw) : null; } catch { data = raw; }
  if (!response.ok) {
    const message = typeof data === 'object' && data && 'message' in data
      ? String((data as Record<string, unknown>).message)
      : 'Database operation failed';
    throw new Error(`DATABASE_${response.status}:${message}`);
  }
  return data as T;
}

export function selectRows<T = Record<string, unknown>>(table: string, params: Record<string, string>): Promise<T[]> {
  return dbRequest<T[]>(`${table}?${new URLSearchParams(params).toString()}`);
}

export type PageRows<T> = {
  items: T[];
  total: number | null;
  offset: number;
  limit: number;
  hasMore: boolean;
  nextOffset: number;
};

/** Consulta paginada PostgREST con recuento exacto y ordenación definida por el llamador. */
export async function selectPageRows<T = Record<string, unknown>>(
  table: string,
  params: Record<string, string>,
  offset: number,
  limit: number
): Promise<PageRows<T>> {
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    throw new Error('PAGINATION_INPUT_INVALID');
  }
  const queryParams = new URLSearchParams(params);
  queryParams.delete('limit');
  queryParams.delete('offset');
  const headers = dbHeaders({
    Range: `${offset}-${offset + limit - 1}`,
    'Range-Unit': 'items',
    Prefer: 'count=exact'
  });
  headers.set('Cache-Control', 'no-store');
  const response = await fetch(supabaseUrl(`${table}?${queryParams.toString()}`), {
    method: 'GET', headers, cache: 'no-store'
  });
  const raw = await response.text();
  let parsed: unknown = null;
  try { parsed = raw ? JSON.parse(raw) : []; } catch { parsed = raw; }
  if (!response.ok) {
    const message = typeof parsed === 'object' && parsed && 'message' in parsed
      ? String((parsed as Record<string, unknown>).message)
      : 'Database operation failed';
    throw new Error(`DATABASE_${response.status}:${message}`);
  }
  if (!Array.isArray(parsed)) throw new Error('DATABASE_PAGE_RESPONSE_INVALID');
  const contentRange = response.headers.get('Content-Range') || '';
  const totalPart = contentRange.split('/').at(-1) || '';
  const parsedTotal = totalPart === '*' ? NaN : Number(totalPart);
  const total = Number.isSafeInteger(parsedTotal) && parsedTotal >= 0 ? parsedTotal : null;
  const items = parsed as T[];
  const nextOffset = offset + items.length;
  return {
    items, total, offset, limit,
    hasMore: total === null ? items.length === limit : nextOffset < total,
    nextOffset
  };
}

export async function selectOne<T = Record<string, unknown>>(table: string, params: Record<string, string>): Promise<T | null> {
  const rows = await selectRows<T>(table, { ...params, limit: params.limit || '1' });
  return rows[0] || null;
}

export async function rpc<T = unknown>(name: string, payload: Record<string, unknown>): Promise<T> {
  return dbRequest<T>(`rpc/${name}`, { method: 'POST', body: JSON.stringify(payload) });
}

export async function patchRows<T = unknown>(
  table: string,
  params: Record<string, string>,
  payload: Record<string, unknown>,
  prefer = 'return=minimal'
): Promise<T> {
  return dbRequest<T>(`${table}?${new URLSearchParams(params).toString()}`, {
    method: 'PATCH', headers: { Prefer: prefer }, body: JSON.stringify(payload)
  });
}

export async function issueAccessToken(userId: string, sessionId: string): Promise<string> {
  const token = randomToken(32);
  const updated = await patchRows<Record<string, unknown>[]>(
    'user_sessions',
    { id: `eq.${sessionId}`, user_id: `eq.${userId}`, revoked_at: 'is.null' },
    {
      access_token_hash: await sha256Hex(token),
      access_expires_at: new Date(Date.now() + ACCESS_TTL_MS).toISOString()
    },
    'return=representation'
  );
  if (!Array.isArray(updated) || updated.length !== 1) throw new Error('SESSION_CREATE_FAILED');
  return token;
}

export async function requireSession(req: Request): Promise<AppSession> {
  const authorization = req.headers.get('Authorization') || '';
  const token = authorization.startsWith('Bearer ') ? authorization.slice(7) : '';
  if (token.length < 40 || token.length > 256) throw new Error('UNAUTHORIZED');

  const now = Date.now();
  const nowIsoValue = new Date(now).toISOString();
  const tokenHash = await sha256Hex(token);
  const session = await selectOne<Record<string, unknown>>('user_sessions', {
    select: 'id,user_id,last_seen_at,idle_expires_at,absolute_expires_at,access_expires_at,revoked_at',
    access_token_hash: `eq.${tokenHash}`,
    revoked_at: 'is.null',
    access_expires_at: `gt.${nowIsoValue}`
  });

  if (!session
    || new Date(String(session.idle_expires_at)).getTime() <= now
    || new Date(String(session.absolute_expires_at)).getTime() <= now) {
    throw new Error('SESSION_EXPIRED');
  }

  // last_seen_at / idle_expires_at no necesitan una escritura por cada llamada.
  // Se renuevan como máximo una vez por minuto, y en paralelo con la lectura
  // del usuario, reduciendo una ida y vuelta secuencial a Postgres por petición.
  const lastSeenAt = Date.parse(String(session.last_seen_at || ''));
  const shouldTouchSession = !Number.isFinite(lastSeenAt) || now - lastSeenAt >= 60_000;
  const activityUpdate = shouldTouchSession
    ? patchRows('user_sessions', {
        id: `eq.${session.id}`, user_id: `eq.${session.user_id}`, revoked_at: 'is.null'
      }, {
        last_seen_at: nowIsoValue,
        idle_expires_at: new Date(Math.min(
          now + IDLE_TTL_MS,
          new Date(String(session.absolute_expires_at)).getTime()
        )).toISOString()
      })
    : Promise.resolve();

  const [user] = await Promise.all([
    selectOne<AppUser>('app_users', {
      select: 'id,username,email,display_name,status',
      id: `eq.${session.user_id}`,
      status: 'eq.active'
    }),
    activityUpdate
  ]);
  if (!user) throw new Error('UNAUTHORIZED');
  return { userId: user.id, sessionId: String(session.id), user, claims: {} };
}

// Requests use a bearer token and never browser cookies. Wildcard CORS is therefore
// compatible with GitHub Pages custom domains without an origin secret/allowlist.
export function corsHeaders(_req: Request): Headers {
  return new Headers({
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-client-info',
    'Access-Control-Max-Age': '86400'
  });
}

export function jsonResponse(_req: Request, payload: Record<string, unknown>, status = 200, cors?: Headers): Response {
  const headers = cors || new Headers();
  headers.set('Content-Type', 'application/json; charset=utf-8');
  headers.set('Cache-Control', 'no-store');
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('Referrer-Policy', 'no-referrer');
  return new Response(JSON.stringify(payload), { status, headers });
}

export async function readJson(req: Request): Promise<Record<string, unknown>> {
  const contentLength = Number(req.headers.get('content-length') || 0);
  if (contentLength > 150_000) throw new Error('PAYLOAD_TOO_LARGE');
  const text = await req.text();
  if (text.length > 150_000) throw new Error('PAYLOAD_TOO_LARGE');
  const parsed = text ? JSON.parse(text) : {};
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('INVALID_BODY');
  return parsed as Record<string, unknown>;
}

export function sanitizeRichHtml(html: unknown): string {
  const input = String(html ?? '');
  if (input.length > 150_000) throw new Error('LETTER_TOO_LARGE');
  const document = new DOMParser().parseFromString(`<html><body>${input}</body></html>`, 'text/html');
  const body = document.querySelector('body');
  if (!body) return '';
  const allowedTags = new Set(['P', 'DIV', 'BR', 'STRONG', 'B', 'EM', 'I', 'U', 'UL', 'OL', 'LI', 'BLOCKQUOTE']);
  const allowedAlignments = new Set(['left', 'center', 'right', 'justify']);
  const encode = (value: string) => value
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  const walk = (node: any): string => {
    if (node.nodeType === 3) return encode(node.textContent || '');
    if (node.nodeType !== 1) return '';
    const tag = String(node.tagName || '').toUpperCase();
    const children = [...(node.childNodes || [])].map(walk).join('');
    if (!allowedTags.has(tag)) return children;
    const align = String(node.style?.textAlign || '').toLowerCase();
    const style = allowedAlignments.has(align) ? ` style="text-align:${align}"` : '';
    const name = tag.toLowerCase();
    if (tag === 'BR') return '<br>';
    return `<${name}${style}>${children}</${name}>`;
  };
  return Array.from(body.childNodes).map(walk).join('').slice(0, 120_000);
}

export function publicUser(user: AppUser) {
  return { id: user.id, username: user.username, email: user.email, displayName: user.display_name };
}

export function errorStatus(error: unknown): { status: number; code: string; message: string } {
  const code = error instanceof Error ? error.message.split(':')[0] : 'INTERNAL_ERROR';
  if (code === 'UNAUTHORIZED' || code === 'SESSION_EXPIRED') {
    return { status: 401, code, message: 'Tu sesión no es válida o ha expirado. Inicia sesión de nuevo.' };
  }
  if (code === 'PAYLOAD_TOO_LARGE' || code === 'LETTER_TOO_LARGE') {
    return { status: 413, code, message: 'El contenido supera el tamaño permitido.' };
  }
  if (code.startsWith('MISSING_SUPABASE_')) {
    return { status: 503, code, message: 'Supabase no está proporcionando las credenciales internas necesarias.' };
  }
  if (code === 'PASSWORD_POLICY') {
    return { status: 400, code, message: 'La contraseña debe tener entre 12 y 128 caracteres.' };
  }
  if (code === 'REGISTRATION_RETRY_CREDENTIALS_INVALID') {
    return { status: 401, code, message: 'La cuenta ya existe, pero la contraseña no coincide. Introduce la contraseña utilizada durante el registro.' };
  }
  if (code === 'REGISTRATION_REQUEST_CONFLICT' || code === 'REGISTRATION_REQUEST_UNAVAILABLE'
    || code === 'REGISTRATION_REQUEST_ID_INVALID' || code === 'ACCOUNT_EXISTS'
    || code === 'ACCOUNT_LIMIT_REACHED' || code === 'INVITATION_INVALID'
    || code === 'INVITATION_ALREADY_PENDING' || code === 'INVITATION_BOOTSTRAP_REQUIRED'
    || code === 'RECOVERY_ROTATION_CONFLICT' || code === 'RECOVERY_ROTATION_SUPERSEDED') {
    return { status: 409, code, message: 'La operación ya no puede continuar con los datos de este intento. Revisa la invitación, la cuenta o vuelve a iniciar la operación.' };
  }
  if (code === 'REGISTRATION_RECOVERY_HANDOFF_INVALID' || code === 'RECOVERY_ROTATION_INVALID'
    || code === 'CURRENT_PASSWORD_INVALID') {
    return { status: 400, code, message: 'Los datos de seguridad no son válidos. Comprueba la contraseña y vuelve a intentarlo.' };
  }
  if (code === 'INVALID_BODY' || code === 'INVALID_INPUT') {
    return { status: 400, code, message: 'Los datos enviados no son válidos.' };
  }
  if (code.startsWith('DATABASE_')) {
    return { status: 500, code: 'DATABASE_ERROR', message: 'No se pudo completar la operación en la base de datos.' };
  }
  return { status: 500, code: 'INTERNAL_ERROR', message: 'Ocurrió un error inesperado. Vuelve a intentarlo.' };
}

export const nowIso = () => new Date().toISOString();
export const absoluteSessionExpiry = () => new Date(Date.now() + ABSOLUTE_TTL_MS).toISOString();
export const idleSessionExpiry = () => new Date(Date.now() + IDLE_TTL_MS).toISOString();
