import {
  absoluteSessionExpiry, corsHeaders, dbRequest, errorStatus, hashPassword,
  idleSessionExpiry, issueAccessToken, jsonResponse, nowIso, publicUser,
  randomToken, readJson, requireSession, rpc, selectOne, selectRows, sha256Hex, verifyPassword
} from '../_shared/core.ts';

function normalizeUsername(value: unknown) {
  return String(value || '').normalize('NFKC').trim().toLocaleLowerCase('es-CO');
}

function validUsername(value: string) {
  return /^[\p{L}\p{N}][\p{L}\p{M}\p{N}._@+-]{2,47}$/u.test(value);
}

function validContactEmail(value: string) {
  return value.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(value);
}

async function findUser(username: string) {
  if (!validUsername(username)) return null;
  return selectOne<Record<string, unknown>>('app_users', {
    select: 'id,username,username_normalized,email,display_name,password_hash,status',
    username_normalized: `eq.${username}`,
    limit: '1'
  });
}

function deviceLabel(userAgent: string | null) {
  const ua = userAgent || '';
  const device = /iPhone|iPad|Android/i.test(ua) ? 'Dispositivo móvil'
    : /Macintosh|Mac OS/i.test(ua) ? 'Mac'
    : /Windows/i.test(ua) ? 'Windows'
    : /Linux/i.test(ua) ? 'Linux' : 'Navegador';
  const browser = /Edg\//i.test(ua) ? 'Edge'
    : /Firefox\//i.test(ua) ? 'Firefox'
    : /Chrome\//i.test(ua) ? 'Chrome'
    : /Safari\//i.test(ua) ? 'Safari' : 'Web';
  return `${browser} · ${device}`;
}

function createRecoveryCode() {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  const hex = [...bytes].map(byte => byte.toString(16).padStart(2, '0')).join('').toUpperCase();
  return hex.match(/.{1,6}/g)?.join('-') || hex;
}

function normalizeRecoveryCode(value: unknown) {
  return String(value || '').replace(/[^a-f0-9]/gi, '').toLowerCase();
}

async function createSession(user: Record<string, unknown>, userAgent: string | null) {
  const sessionId = crypto.randomUUID();
  const refreshToken = randomToken(32);
  const result = await rpc<Record<string, unknown>>('create_app_session_with_refresh', {
    p_session_id: sessionId,
    p_user_id: user.id,
    p_idle_expires_at: idleSessionExpiry(),
    p_absolute_expires_at: absoluteSessionExpiry(),
    p_refresh_token_hash: await sha256Hex(refreshToken),
    p_user_agent: (userAgent || '').slice(0, 500),
    p_device_label: deviceLabel(userAgent),
    p_now: nowIso()
  });
  if (result.status !== 'created') throw new Error('SESSION_CREATE_FAILED');
  const accessToken = await issueAccessToken(String(user.id), sessionId);
  return { ok: true, sessionId, accessToken, refreshToken, expiresIn: 900, user: publicUser(user as never) };
}

Deno.serve(async (req: Request) => {
  const headers = corsHeaders(req);
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers });
  if (req.method !== 'POST') {
    return jsonResponse(req, { ok: false, code: 'METHOD_NOT_ALLOWED', message: 'Método no permitido.' }, 405, headers);
  }

  try {
    const body = await readJson(req);
    const action = String(body.action || '');

    if (action === 'register') {
      const displayName = String(body.displayName || '').trim();
      const username = normalizeUsername(body.username);
      const password = String(body.password || '');
      if (password.length < 12 || password.length > 128) throw new Error('PASSWORD_POLICY');
      if (!displayName || displayName.length > 80 || !validUsername(username)) {
        throw new Error('INVALID_INPUT');
      }

      const attempt = await rpc<Record<string, unknown>>('start_app_login_attempt', {
        p_identifier_hash: await sha256Hex(`signup:${username}`), p_now: nowIso()
      });
      if (!attempt.allowed) {
        return jsonResponse(req, { ok: false, code: 'RATE_LIMITED', message: 'Demasiados intentos. Vuelve a probar más tarde.' }, 429, headers);
      }

      const recoveryCode = createRecoveryCode();
      const registered = await rpc<Record<string, unknown>>('register_app_user_without_email', {
        p_display_name: displayName,
        p_username: username,
        p_password_hash: await hashPassword(password),
        p_recovery_code_hash: await sha256Hex(normalizeRecoveryCode(recoveryCode)),
        p_now: nowIso()
      });
      await rpc('complete_app_login_attempt', {
        p_attempt_id: attempt.attempt_id,
        p_success: registered.status === 'created',
        p_now: nowIso()
      });

      if (registered.status !== 'created') {
        if (registered.status === 'account_limit_reached') throw new Error('ACCOUNT_LIMIT_REACHED');
        if (registered.status === 'username_or_email_exists') throw new Error('ACCOUNT_EXISTS');
        throw new Error('REGISTRATION_FAILED');
      }

      const user = await selectOne<Record<string, unknown>>('app_users', {
        select: 'id,username,email,display_name,status',
        id: `eq.${registered.user_id}`,
        status: 'eq.active'
      });
      if (!user) throw new Error('USER_CREATE_FAILED');
      const session = await createSession(user, req.headers.get('user-agent'));
      return jsonResponse(req, {
        ...session,
        recoveryCode,
        message: 'Cuenta creada. Guarda tu código de recuperación en un lugar seguro: solo se muestra una vez.'
      }, 200, headers);
    }

    if (action === 'login') {
      const username = normalizeUsername(body.identifier || body.username);
      const password = String(body.password || '');
      if (!username || !password || username.length > 48 || password.length > 128) throw new Error('INVALID_INPUT');
      const attempt = await rpc<Record<string, unknown>>('start_app_login_attempt', {
        p_identifier_hash: await sha256Hex(username), p_now: nowIso()
      });
      if (!attempt.allowed) {
        return jsonResponse(req, { ok: false, code: 'RATE_LIMITED', message: 'Demasiados intentos. Vuelve a probar más tarde.' }, 429, headers);
      }
      const user = await findUser(username);
      const valid = Boolean(user && user.status === 'active'
        && await verifyPassword(password, String(user.password_hash || '')));
      await rpc('complete_app_login_attempt', {
        p_attempt_id: attempt.attempt_id, p_success: valid, p_now: nowIso()
      });
      if (!valid || !user) throw new Error('INVALID_CREDENTIALS');
      await dbRequest(`app_users?id=eq.${encodeURIComponent(String(user.id))}`, {
        method: 'PATCH', headers: { Prefer: 'return=minimal' },
        body: JSON.stringify({ last_login_at: nowIso(), updated_at: nowIso() })
      });
      return jsonResponse(req, await createSession(user, req.headers.get('user-agent')), 200, headers);
    }

    if (action === 'refresh') {
      const refreshToken = String(body.refreshToken || '');
      if (refreshToken.length < 30 || refreshToken.length > 256) throw new Error('UNAUTHORIZED');
      const replacement = randomToken(32);
      const rotated = await rpc<Record<string, unknown>>('rotate_app_refresh_token', {
        p_token_hash: await sha256Hex(refreshToken),
        p_new_token_hash: await sha256Hex(replacement),
        p_now: nowIso()
      });
      if (rotated.status !== 'rotated') throw new Error('SESSION_EXPIRED');
      const user = await selectOne<Record<string, unknown>>('app_users', {
        select: 'id,username,email,display_name,status',
        id: `eq.${rotated.user_id}`,
        status: 'eq.active'
      });
      if (!user) throw new Error('SESSION_EXPIRED');
      return jsonResponse(req, {
        ok: true,
        sessionId: String(rotated.session_id),
        accessToken: await issueAccessToken(String(user.id), String(rotated.session_id)),
        refreshToken: replacement,
        expiresIn: 900,
        user: publicUser(user as never)
      }, 200, headers);
    }

    if (action === 'recover-with-code') {
      const username = normalizeUsername(body.username);
      const recoveryCode = normalizeRecoveryCode(body.recoveryCode);
      const password = String(body.password || '');
      if (!validUsername(username) || recoveryCode.length !== 48) {
        throw new Error('RECOVERY_CODE_INVALID');
      }
      const attempt = await rpc<Record<string, unknown>>('start_app_login_attempt', {
        p_identifier_hash: await sha256Hex(`recover:${username}`), p_now: nowIso()
      });
      if (!attempt.allowed) {
        return jsonResponse(req, { ok: false, code: 'RATE_LIMITED', message: 'Espera antes de volver a intentarlo.' }, 429, headers);
      }
      const result = await rpc<Record<string, unknown>>('consume_app_recovery_code', {
        p_username_normalized: username,
        p_code_hash: await sha256Hex(recoveryCode),
        p_new_password_hash: await hashPassword(password),
        p_now: nowIso()
      });
      await rpc('complete_app_login_attempt', {
        p_attempt_id: attempt.attempt_id, p_success: result.status === 'recovered', p_now: nowIso()
      });
      if (result.status !== 'recovered') throw new Error('RECOVERY_CODE_INVALID');
      return jsonResponse(req, {
        ok: true,
        message: 'Contraseña actualizada. Ya puedes iniciar sesión con la nueva contraseña.'
      }, 200, headers);
    }

    if (action === 'account:update') {
      const session = await requireSession(req);
      const currentPassword = String(body.currentPassword || '');
      if (!currentPassword || currentPassword.length > 128) throw new Error('CURRENT_PASSWORD_INVALID');
      const current = await selectOne<Record<string, unknown>>('app_users', {
        select: 'id,username,email,password_hash,status',
        id: `eq.${session.userId}`, status: 'eq.active'
      });
      if (!current || !await verifyPassword(currentPassword, String(current.password_hash || ''))) {
        throw new Error('CURRENT_PASSWORD_INVALID');
      }

      const username = normalizeUsername(body.username);
      if (!validUsername(username)) throw new Error('USERNAME_INVALID');
      const emailInput = String(body.email || '').trim().toLowerCase();
      if (emailInput && !validContactEmail(emailInput)) throw new Error('EMAIL_INVALID');
      const email = emailInput || `${username}@accounts.nuestro-rincon.invalid`;

      try {
        await dbRequest(`app_users?id=eq.${encodeURIComponent(session.userId)}&status=eq.active`, {
          method: 'PATCH', headers: { Prefer: 'return=minimal' },
          body: JSON.stringify({ username, email, updated_at: nowIso() })
        });
      } catch (error) {
        if (error instanceof Error && error.message.startsWith('DATABASE_409')) throw new Error('ACCOUNT_DETAILS_TAKEN');
        throw error;
      }

      const updated = await selectOne<Record<string, unknown>>('app_users', {
        select: 'id,username,email,display_name,status',
        id: `eq.${session.userId}`, status: 'eq.active'
      });
      if (!updated) throw new Error('UNAUTHORIZED');
      return jsonResponse(req, {
        ok: true,
        user: { id: updated.id, username: updated.username, email: updated.email, displayName: updated.display_name }
      }, 200, headers);
    }

    if (action === 'password:update') {
      const session = await requireSession(req);
      const currentPassword = String(body.currentPassword || '');
      const newPassword = String(body.newPassword || '');
      if (newPassword.length < 12 || newPassword.length > 128) throw new Error('PASSWORD_POLICY');
      const current = await selectOne<Record<string, unknown>>('app_users', {
        select: 'id,password_hash,status', id: `eq.${session.userId}`, status: 'eq.active'
      });
      if (!current || !await verifyPassword(currentPassword, String(current.password_hash || ''))) {
        throw new Error('CURRENT_PASSWORD_INVALID');
      }
      if (await verifyPassword(newPassword, String(current.password_hash || ''))) throw new Error('PASSWORD_UNCHANGED');
      const changed = await rpc<Record<string, unknown>>('change_app_password', {
        p_user_id: session.userId,
        p_current_session_id: session.sessionId,
        p_new_password_hash: await hashPassword(newPassword),
        p_now: nowIso()
      });
      if (changed.status !== 'changed') throw new Error('PASSWORD_UPDATE_FAILED');
      return jsonResponse(req, { ok: true, message: 'Contraseña actualizada. Las demás sesiones fueron revocadas.' }, 200, headers);
    }

    if (action === 'account:delete') {
      const session = await requireSession(req);
      const currentPassword = String(body.currentPassword || '');
      const confirmation = String(body.confirmation || '');
      if (confirmation !== 'ELIMINAR' || !currentPassword || currentPassword.length > 128) {
        throw new Error('ACCOUNT_DELETE_CONFIRMATION_INVALID');
      }
      const current = await selectOne<Record<string, unknown>>('app_users', {
        select: 'id,password_hash,status', id: `eq.${session.userId}`, status: 'eq.active'
      });
      if (!current || !await verifyPassword(currentPassword, String(current.password_hash || ''))) {
        throw new Error('CURRENT_PASSWORD_INVALID');
      }
      const result = await rpc<Record<string, unknown>>('delete_app_account', {
        p_user_id: session.userId, p_current_session_id: session.sessionId, p_now: nowIso()
      });
      if (result.status !== 'deleted') {
        if (result.status === 'session_invalid') throw new Error('SESSION_EXPIRED');
        throw new Error('ACCOUNT_DELETE_FAILED');
      }
      return jsonResponse(req, { ok: true, deleted: true, sharedLettersPreserved: result.shared_letters_preserved === true }, 200, headers);
    }

    if (action === 'logout') {
      const session = await requireSession(req);
      const now = nowIso();
      await dbRequest(`user_sessions?id=eq.${encodeURIComponent(session.sessionId)}&user_id=eq.${encodeURIComponent(session.userId)}`, {
        method: 'PATCH', headers: { Prefer: 'return=minimal' },
        body: JSON.stringify({ revoked_at: now, revocation_reason: 'user_logout', access_token_hash: null, access_expires_at: now })
      });
      await dbRequest(`user_session_refresh_tokens?session_id=eq.${encodeURIComponent(session.sessionId)}`, {
        method: 'PATCH', headers: { Prefer: 'return=minimal' },
        body: JSON.stringify({ revoked_at: now })
      });
      return jsonResponse(req, { ok: true }, 200, headers);
    }

    if (action === 'session') {
      const session = await requireSession(req);
      return jsonResponse(req, { ok: true, sessionId: session.sessionId, user: publicUser(session.user) }, 200, headers);
    }

    return jsonResponse(req, { ok: false, code: 'UNKNOWN_ACTION', message: 'Acción no reconocida.' }, 404, headers);
  } catch (error) {
    const message = error instanceof Error ? error.message : '';
    let mapped = errorStatus(error);
    if (message === 'INVALID_CREDENTIALS') mapped = { status: 401, code: 'INVALID_CREDENTIALS', message: 'Nombre de usuario o contraseña incorrectos.' };
    else if (message === 'CURRENT_PASSWORD_INVALID') mapped = { status: 401, code: 'CURRENT_PASSWORD_INVALID', message: 'La contraseña actual no es correcta.' };
    else if (message === 'USERNAME_INVALID') mapped = { status: 400, code: 'USERNAME_INVALID', message: 'El usuario debe tener entre 3 y 48 caracteres: letras, acentos, números y . _ @ + -; no admite espacios.' };
    else if (message === 'EMAIL_INVALID') mapped = { status: 400, code: 'EMAIL_INVALID', message: 'Escribe un correo electrónico válido o deja el campo vacío.' };
    else if (message === 'ACCOUNT_DETAILS_TAKEN') mapped = { status: 409, code: 'ACCOUNT_DETAILS_TAKEN', message: 'Ese nombre de usuario o correo ya está en uso.' };
    else if (message === 'PASSWORD_UNCHANGED') mapped = { status: 400, code: 'PASSWORD_UNCHANGED', message: 'La nueva contraseña debe ser diferente de la actual.' };
    else if (message === 'PASSWORD_UPDATE_FAILED') mapped = { status: 500, code: 'PASSWORD_UPDATE_FAILED', message: 'No se pudo actualizar la contraseña. Inténtalo de nuevo.' };
    else if (message === 'ACCOUNT_DELETE_CONFIRMATION_INVALID') mapped = { status: 400, code: 'ACCOUNT_DELETE_CONFIRMATION_INVALID', message: 'Escribe ELIMINAR y confirma con tu contraseña actual.' };
    else if (message === 'ACCOUNT_DELETE_FAILED') mapped = { status: 500, code: 'ACCOUNT_DELETE_FAILED', message: 'No se pudo eliminar la cuenta. No se modificaron tus datos; vuelve a intentarlo.' };
    else if (message === 'ACCOUNT_EXISTS') mapped = { status: 409, code: 'ACCOUNT_EXISTS', message: 'Ese nombre de usuario ya está registrado.' };
    else if (message === 'ACCOUNT_LIMIT_REACHED') mapped = { status: 409, code: 'ACCOUNT_LIMIT_REACHED', message: 'Este espacio privado ya tiene sus dos cuentas.' };
    else if (message === 'REGISTRATION_FAILED') mapped = { status: 400, code: 'REGISTRATION_FAILED', message: 'No se pudo crear la cuenta. Revisa los datos e inténtalo de nuevo.' };
    else if (message === 'RECOVERY_CODE_INVALID') mapped = { status: 400, code: 'RECOVERY_CODE_INVALID', message: 'El usuario o el código de recuperación no son válidos, o el código ya fue utilizado.' };
    else if (message === 'SESSION_CREATE_FAILED') mapped = { status: 503, code: 'SESSION_CREATE_FAILED', message: 'No se pudo crear la sesión. Vuelve a intentarlo.' };
    console.error('auth-api error', mapped.code);
    return jsonResponse(req, { ok: false, code: mapped.code, message: mapped.message }, mapped.status, headers);
  }
});
