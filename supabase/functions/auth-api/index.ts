import {
  absoluteSessionExpiry, corsHeaders, dbRequest, errorStatus, hashPassword,
  idleSessionExpiry, issueAccessToken, jsonResponse, nowIso, publicUser,
  randomToken, readJson, requireSession, rpc, selectOne, selectRows, sha256Hex, hmacSha256Hex, verifyPassword
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


function normalizeRecoveryCode(value: unknown) {
  return String(value || '').replace(/[^a-f0-9]/gi, '').toLowerCase();
}

function normalizeRegistrationInvitation(value: unknown): string | null {
  const input = String(value || '').normalize('NFKC').trim().toUpperCase();
  if (!/^NR1[-\s]/.test(input)) return null;
  const compact = input.slice(4).replace(/[\s-]/g, '');
  return /^[0-9A-F]{64}$/.test(compact) ? compact.toLowerCase() : null;
}

function createRegistrationInvitationCode() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const hex = [...bytes].map(byte => byte.toString(16).padStart(2, '0')).join('');
  const groups = hex.toUpperCase().match(/.{8}/g) || [];
  return { hex, code: `NR1-${groups.join('-')}` };
}

function invitationClientAddress(req: Request) {
  // Supabase Edge Functions corre detrás de Cloudflare. Se prioriza la cabecera
  // de cliente que añade el proxy; nunca se registra la IP en claro.
  return (req.headers.get('cf-connecting-ip') || 'unknown')
    .trim().slice(0, 128) || 'unknown';
}


async function authAttemptIpDigest(req: Request): Promise<string | null> {
  // Solo se acepta la IP escrita por el proxy de borde; no se confía en
  // x-forwarded-for ni en cabeceras arbitrarias enviadas por el navegador.
  const address = String(req.headers.get('cf-connecting-ip') || '').trim();
  if (!address || address.toLowerCase() === 'unknown' || address.length > 128) return null;
  if (!/^[0-9a-f:.]+$/i.test(address)) return null;
  return hmacSha256Hex(`auth-attempt-ip:v1:${address}`);
}

async function startAuthAttempt(req: Request, identifier: string, action: 'login' | 'recovery' | 'registration') {
  const attempt = await rpc<Record<string, unknown>>('start_app_auth_attempt', {
    p_identifier_hash: await hmacSha256Hex(`auth-attempt-identifier:v1:${identifier}`),
    p_ip_digest: await authAttemptIpDigest(req),
    p_action: action,
    p_now: nowIso()
  });
  // El enfriamiento aplica solo a la combinación cuenta+IP o al volumen de
  // una IP. Los intentos distribuidos sobre una cuenta se auditan, pero no
  // ralentizan ni bloquean globalmente al titular desde otra conexión.
  return attempt;
}

async function applyDistributedFailureFriction(attempt: Record<string, unknown>, failed: boolean) {
  // El contador agregado solo ralentiza RESPUESTAS fallidas: nunca se aplica
  // antes de comprobar la contraseña/código y nunca retrasa un acceso correcto.
  // No bloquea la cuenta; limita la velocidad de un ataque distribuido sin
  // permitir que un tercero provoque el bloqueo del titular legítimo.
  if (!failed) return;
  const previousFailures = Math.max(0, Number(attempt.account_failure_count) || 0);
  const totalFailures = previousFailures + 1;
  if (totalFailures < 10) return;
  const delayMs = Math.min(1600, 100 * (2 ** Math.min(totalFailures - 10, 4)));
  await new Promise<void>(resolve => setTimeout(resolve, delayMs));
}

function inviteAttemptReason(error: unknown) {
  const message = error instanceof Error ? error.message : '';
  if (message === 'INVITATION_INVALID') return 'invalid_or_expired';
  if (message === 'ACCOUNT_EXISTS') return 'account_conflict';
  if (message === 'ACCOUNT_LIMIT_REACHED') return 'account_limit';
  if (message === 'PASSWORD_POLICY') return 'password_policy';
  return 'registration_failed';
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
  try {
    const accessToken = await issueAccessToken(String(user.id), sessionId);
    return { ok: true, sessionId, accessToken, refreshToken, expiresIn: 900, user: publicUser(user as never) };
  } catch (error) {
    const revokedAt = nowIso();
    try {
      await dbRequest(`user_sessions?id=eq.${encodeURIComponent(sessionId)}&user_id=eq.${encodeURIComponent(String(user.id))}`, {
        method: 'PATCH', headers: { Prefer: 'return=minimal' },
        body: JSON.stringify({ revoked_at: revokedAt, revocation_reason: 'incomplete_session_setup', access_token_hash: null, access_expires_at: revokedAt })
      });
      await dbRequest(`user_session_refresh_tokens?session_id=eq.${encodeURIComponent(sessionId)}`, {
        method: 'PATCH', headers: { Prefer: 'return=minimal' },
        body: JSON.stringify({ revoked_at: revokedAt })
      });
    } catch { console.error('incomplete session cleanup failed'); }
    throw error;
  }
}

async function registrationSessionResponse(
  req: Request,
  headers: Headers,
  userId: string,
  recoveryCodeCurrent: boolean
) {
  let user: Record<string, unknown> | null = null;
  try {
    user = await selectOne<Record<string, unknown>>('app_users', {
      select: 'id,username,email,display_name,status',
      id: `eq.${userId}`,
      status: 'eq.active'
    });
  } catch (error) {
    // La cuenta y el código ya quedaron confirmados en PostgreSQL. Un fallo
    // de lectura posterior no debe convertirse en un error que sugiera que
    // el alta se revirtió ni provocar que el navegador descarte el código.
    console.error('registration user lookup deferred', errorStatus(error).code);
  }

  if (!user) {
    return jsonResponse(req, {
      ok: true,
      accountCreated: true,
      authenticated: false,
      recoveryCodeCurrent,
      user: null,
      message: 'La cuenta y el código de recuperación ya quedaron guardados. No pudimos completar el inicio de sesión; conserva el código y entra con tu usuario y contraseña. Si hace falta, reintenta el mismo registro en esta pestaña.'
    }, 200, headers);
  }

  try {
    const session = await createSession(user, req.headers.get('user-agent'));
    return jsonResponse(req, {
      ...session,
      accountCreated: true,
      authenticated: true,
      recoveryCodeCurrent,
      message: 'La cuenta está creada. Guarda el código de recuperación antes de continuar.'
    }, 200, headers);
  } catch (error) {
    console.error('registration session deferred', errorStatus(error).code);
    return jsonResponse(req, {
      ok: true,
      accountCreated: true,
      authenticated: false,
      recoveryCodeCurrent,
      user: publicUser(user as never),
      message: 'La cuenta está creada, pero no se pudo abrir la sesión en este momento. El código de recuperación queda conservado en el almacenamiento local de este navegador. Guárdalo y después inicia sesión; también puedes reintentar el registro con los mismos datos sin consumir otra invitación.'
    }, 200, headers);
  }
}

async function resumeRegistrationFromReceipt(
  req: Request,
  headers: Headers,
  input: { requestHash: string; invitationHash: string; username: string; recoveryCodeHash: string; password: string }
): Promise<Response | null> {
  const receipt = await selectOne<Record<string, unknown>>('registration_request_receipts', {
    select: 'request_hash,invitation_hash,username_normalized,recovery_code_hash,user_id',
    request_hash: `eq.${input.requestHash}`
  });
  if (!receipt) return null;

  if (String(receipt.invitation_hash) !== input.invitationHash
    || String(receipt.username_normalized) !== input.username
    || String(receipt.recovery_code_hash) !== input.recoveryCodeHash
    || !receipt.user_id) {
    throw new Error('REGISTRATION_REQUEST_CONFLICT');
  }

  const user = await selectOne<Record<string, unknown>>('app_users', {
    select: 'id,password_hash,status',
    id: `eq.${receipt.user_id}`,
    status: 'eq.active'
  });
  if (!user || !await verifyPassword(input.password, String(user.password_hash || ''))) {
    throw new Error('REGISTRATION_RETRY_CREDENTIALS_INVALID');
  }

  const currentCode = await selectOne<Record<string, unknown>>('user_recovery_codes', {
    select: 'id',
    user_id: `eq.${receipt.user_id}`,
    code_hash: `eq.${input.recoveryCodeHash}`,
    used_at: 'is.null'
  });
  return await registrationSessionResponse(req, headers, String(receipt.user_id), Boolean(currentCode));
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
      const requestId = String(body.requestId || '').trim().toLowerCase();
      const recoveryCode = normalizeRecoveryCode(body.recoveryCode);
      if (password.length < 12 || password.length > 128) throw new Error('PASSWORD_POLICY');
      if (!displayName || displayName.length > 80 || !validUsername(username)) throw new Error('INVALID_INPUT');
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(requestId)
        || recoveryCode.length !== 48) throw new Error('REGISTRATION_RECOVERY_HANDOFF_INVALID');

      const rawInvitation = String(body.invitationCode || '').slice(0, 256);
      const invitationHex = normalizeRegistrationInvitation(rawInvitation);
      const invitationHash = invitationHex
        ? await sha256Hex(`registration-invite:v1:${invitationHex}`)
        : await sha256Hex(`registration-invite-invalid:v1:${rawInvitation.normalize('NFKC').trim().toUpperCase()}`);
      const requestHash = await sha256Hex(`registration-request:v1:${requestId}`);
      const recoveryCodeHash = await sha256Hex(recoveryCode);

      const ipHash = await hmacSha256Hex(`registration-invite-ip:v1:${invitationClientAddress(req)}`);
      const inviteAttempt = await rpc<Record<string, unknown>>('start_app_registration_invite_attempt', {
        p_ip_hash: ipHash,
        p_token_hash: invitationHash,
        p_now: nowIso()
      });
      if (!inviteAttempt.allowed) {
        return jsonResponse(req, {
          ok: false, code: 'INVITATION_RATE_LIMITED',
          message: 'Se han realizado demasiados intentos con este código o desde esta conexión. Espera 15 minutos y vuelve a intentarlo.'
        }, 429, headers);
      }

      const inviteAttemptId = String(inviteAttempt.attempt_id || '');
      let inviteAttemptCompleted = false;
      const completeInviteAttempt = async (outcome: 'accepted' | 'rejected', reason: string, userId: string | null = null) => {
        if (inviteAttemptCompleted) return;
        inviteAttemptCompleted = true;
        await rpc('complete_app_registration_invite_attempt', {
          p_attempt_id: inviteAttemptId,
          p_outcome: outcome,
          p_reason: reason,
          p_user_id: userId,
          p_now: nowIso()
        });
      };

      try {
        // Los reintentos idempotentes también pasan por el limitador de intentos.
        // No se permite usar la consulta del recibo para ensayar contraseñas sin límite.
        const resumed = await resumeRegistrationFromReceipt(req, headers, {
          requestHash, invitationHash, username, recoveryCodeHash, password
        });
        if (resumed) {
          await completeInviteAttempt('accepted', 'idempotent_registration_recovered');
          return resumed;
        }

        if (!invitationHex) throw new Error('INVITATION_INVALID');
        const invitationCheck = await rpc<Record<string, unknown>>('check_app_registration_invite', {
          p_token_hash: invitationHash, p_now: nowIso()
        });
        if (invitationCheck.status !== 'valid') {
          // Otra petición idéntica pudo consumir la invitación entre el primer
          // lookup y este chequeo. Comprueba de nuevo el recibo antes de fallar.
          const concurrentResume = await resumeRegistrationFromReceipt(req, headers, {
            requestHash, invitationHash, username, recoveryCodeHash, password
          });
          if (concurrentResume) {
            await completeInviteAttempt('accepted', 'idempotent_registration_recovered');
            return concurrentResume;
          }
          throw new Error('INVITATION_INVALID');
        }

        const attempt = await startAuthAttempt(req, `signup:${username}`, 'registration');
        if (!attempt.allowed) {
          await completeInviteAttempt('rejected', 'registration_identifier_rate_limited');
          return jsonResponse(req, {
            ok: false, code: 'RATE_LIMITED', retryAfterSeconds: Number(attempt.retry_after_seconds || 30),
            message: 'Se han detectado demasiados intentos desde esta conexión. Espera un momento y vuelve a intentarlo.'
          }, 429, headers);
        }

        const registered = await rpc<Record<string, unknown>>('register_app_user_with_invite_idempotent', {
          p_request_hash: requestHash,
          p_invitation_hash: invitationHash,
          p_display_name: displayName,
          p_username: username,
          p_password_hash: await hashPassword(password),
          p_recovery_code_hash: recoveryCodeHash,
          p_now: nowIso()
        });

        const isCreated = registered.status === 'created' || registered.status === 'already_created';
        if (registered.status === 'already_created') {
          const existingUser = await selectOne<Record<string, unknown>>('app_users', {
            select: 'id,password_hash,status',
            id: `eq.${registered.user_id}`,
            status: 'eq.active'
          });
          if (!existingUser || !await verifyPassword(password, String(existingUser.password_hash || ''))) {
            throw new Error('REGISTRATION_RETRY_CREDENTIALS_INVALID');
          }
        }
        try {
          await rpc('complete_app_login_attempt', {
            p_attempt_id: attempt.attempt_id, p_success: isCreated, p_now: nowIso()
          });
        } catch (error) {
          // Este contador es auxiliar; si falla después del COMMIT del alta,
          // nunca debe ocultar el código ni convertir la cuenta en un error.
          console.error('registration login-attempt audit deferred', errorStatus(error).code);
        }

        if (!isCreated) {
          const reason = String(registered.status || 'registration_failed').slice(0, 80);
          await completeInviteAttempt('rejected', reason);
          if (registered.status === 'invalid_invitation') throw new Error('INVITATION_INVALID');
          if (registered.status === 'account_limit_reached') throw new Error('ACCOUNT_LIMIT_REACHED');
          if (registered.status === 'username_or_email_exists') throw new Error('ACCOUNT_EXISTS');
          if (registered.status === 'request_conflict') throw new Error('REGISTRATION_REQUEST_CONFLICT');
          if (registered.status === 'request_unavailable') throw new Error('REGISTRATION_REQUEST_UNAVAILABLE');
          if (registered.status === 'invalid_input') throw new Error('INVALID_INPUT');
          throw new Error('REGISTRATION_FAILED');
        }

        try { await completeInviteAttempt('accepted', 'accepted', String(registered.user_id)); }
        catch { console.error('registration invite acceptance audit completion failed'); }

        // Incluso si crear la sesión falla, la cuenta ya está creada y el
        // navegador conserva el código en localStorage hasta que la persona
        // confirme que lo guardó. No se presenta como fallo de alta.
        return await registrationSessionResponse(req, headers, String(registered.user_id), true);
      } catch (error) {
        if (!inviteAttemptCompleted) {
          try { await completeInviteAttempt('rejected', inviteAttemptReason(error)); }
          catch { console.error('registration invite attempt completion failed'); }
        }
        throw error;
      }
    }

    if (action === 'login') {
      const username = normalizeUsername(body.identifier || body.username);
      const password = String(body.password || '');
      if (!username || !password || username.length > 48 || password.length > 128) throw new Error('INVALID_INPUT');
      const attempt = await startAuthAttempt(req, username, 'login');
      if (!attempt.allowed) {
        return jsonResponse(req, {
          ok: false, code: 'RATE_LIMITED', retryAfterSeconds: Number(attempt.retry_after_seconds || 30),
          message: 'Se han detectado demasiados intentos desde esta conexión. Espera un momento y vuelve a intentarlo.'
        }, 429, headers);
      }
      const user = await findUser(username);
      const valid = Boolean(user && user.status === 'active'
        && await verifyPassword(password, String(user.password_hash || '')));
      await rpc('complete_app_login_attempt', {
        p_attempt_id: attempt.attempt_id, p_success: valid, p_now: nowIso()
      });
      if (!valid || !user) {
        await applyDistributedFailureFriction(attempt, true);
        throw new Error('INVALID_CREDENTIALS');
      }
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
      const attempt = await startAuthAttempt(req, username, 'recovery');
      if (!attempt.allowed) {
        return jsonResponse(req, {
          ok: false, code: 'RATE_LIMITED', retryAfterSeconds: Number(attempt.retry_after_seconds || 30),
          message: 'Se han detectado demasiados intentos desde esta conexión. Espera un momento y vuelve a intentarlo.'
        }, 429, headers);
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
      if (result.status !== 'recovered') {
        await applyDistributedFailureFriction(attempt, true);
        throw new Error('RECOVERY_CODE_INVALID');
      }
      return jsonResponse(req, {
        ok: true,
        message: 'Contraseña actualizada. Ya puedes iniciar sesión con la nueva contraseña.'
      }, 200, headers);
    }

    if (action === 'invitation:status') {
      const session = await requireSession(req);
      const status = await rpc<Record<string, unknown>>('get_app_registration_invitation_status', {
        p_user_id: session.userId, p_now: nowIso()
      });
      if (status.status !== 'ok') throw new Error('UNAUTHORIZED');
      return jsonResponse(req, {
        ok: true,
        canCreate: status.can_create === true,
        pending: status.pending === true,
        expiresAt: status.expires_at || null,
        accountCount: Number(status.account_count || 0)
      }, 200, headers);
    }

    if (action === 'invitation:create') {
      const session = await requireSession(req);
      const generated = createRegistrationInvitationCode();
      const tokenHash = await sha256Hex(`registration-invite:v1:${generated.hex}`);
      const now = new Date();
      const expiresAt = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString();
      const result = await rpc<Record<string, unknown>>('create_app_registration_invite', {
        p_inviter_user_id: session.userId,
        p_token_hash: tokenHash,
        p_expires_at: expiresAt,
        p_now: now.toISOString()
      });
      if (result.status !== 'created') {
        if (result.status === 'account_limit_reached') throw new Error('ACCOUNT_LIMIT_REACHED');
        if (result.status === 'pending_invitation_exists') throw new Error('INVITATION_ALREADY_PENDING');
        if (result.status === 'bootstrap_required') throw new Error('INVITATION_BOOTSTRAP_REQUIRED');
        throw new Error('INVITATION_CREATE_FAILED');
      }
      // El código en claro solo se devuelve en esta respuesta. Nunca se escribe
      // en PostgreSQL, localStorage, sessionStorage ni en los registros del servidor.
      return jsonResponse(req, { ok: true, code: generated.code, expiresAt: result.expires_at || expiresAt }, 200, headers);
    }

    if (action === 'invitation:revoke') {
      const session = await requireSession(req);
      const result = await rpc<Record<string, unknown>>('revoke_app_registration_invite', {
        p_inviter_user_id: session.userId, p_now: nowIso()
      });
      if (result.status === 'unauthorized') throw new Error('UNAUTHORIZED');
      if (result.status !== 'revoked') throw new Error('INVITATION_NOT_FOUND');
      return jsonResponse(req, { ok: true, revoked: true }, 200, headers);
    }

    if (action === 'recovery-code:rotate') {
      const session = await requireSession(req);
      const currentPassword = String(body.currentPassword || '');
      const recoveryCode = normalizeRecoveryCode(body.recoveryCode);
      const requestId = String(body.requestId || '').trim().toLowerCase();
      if (!currentPassword || currentPassword.length > 128) throw new Error('CURRENT_PASSWORD_INVALID');
      if (recoveryCode.length !== 48
        || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(requestId)) {
        throw new Error('RECOVERY_ROTATION_INVALID');
      }
      const current = await selectOne<Record<string, unknown>>('app_users', {
        select: 'id,password_hash,status', id: `eq.${session.userId}`, status: 'eq.active'
      });
      if (!current || !await verifyPassword(currentPassword, String(current.password_hash || ''))) {
        throw new Error('CURRENT_PASSWORD_INVALID');
      }
      const result = await rpc<Record<string, unknown>>('rotate_app_recovery_code', {
        p_user_id: session.userId,
        p_session_id: session.sessionId,
        p_request_hash: await sha256Hex(`recovery-code-rotation:v1:${requestId}`),
        p_recovery_code_hash: await sha256Hex(recoveryCode),
        p_now: nowIso()
      });
      if (result.status === 'session_invalid') throw new Error('SESSION_EXPIRED');
      if (result.status === 'request_conflict') throw new Error('RECOVERY_ROTATION_CONFLICT');
      if (result.status === 'request_superseded') throw new Error('RECOVERY_ROTATION_SUPERSEDED');
      if (result.status !== 'rotated' && result.status !== 'already_rotated') throw new Error('RECOVERY_ROTATION_FAILED');
      return jsonResponse(req, {
        ok: true,
        rotated: true,
        alreadyRotated: result.status === 'already_rotated',
        message: 'El nuevo código de recuperación está activo. Todos los códigos anteriores quedaron invalidados.'
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
    else if (message === 'REGISTRATION_RECOVERY_HANDOFF_INVALID') mapped = { status: 400, code: 'REGISTRATION_RECOVERY_HANDOFF_INVALID', message: 'No se pudo preparar la entrega segura del código. Vuelve a intentarlo.' };
    else if (message === 'REGISTRATION_REQUEST_CONFLICT') mapped = { status: 409, code: 'REGISTRATION_REQUEST_CONFLICT', message: 'El intento de registro no coincide con el código guardado. Repite el proceso con los mismos datos o inicia sesión si la cuenta ya existe.' };
    else if (message === 'REGISTRATION_REQUEST_UNAVAILABLE') mapped = { status: 409, code: 'REGISTRATION_REQUEST_UNAVAILABLE', message: 'El registro anterior ya no está disponible. Inicia sesión o solicita una nueva invitación.' };
    else if (message === 'REGISTRATION_RETRY_CREDENTIALS_INVALID') mapped = { status: 401, code: 'REGISTRATION_RETRY_CREDENTIALS_INVALID', message: 'La cuenta ya se creó, pero la contraseña no coincide. Repite el intento con la contraseña original o inicia sesión.' };
    else if (message === 'RECOVERY_ROTATION_INVALID') mapped = { status: 400, code: 'RECOVERY_ROTATION_INVALID', message: 'No se pudo validar el código nuevo. Vuelve a intentarlo.' };
    else if (message === 'RECOVERY_ROTATION_CONFLICT') mapped = { status: 409, code: 'RECOVERY_ROTATION_CONFLICT', message: 'El intento de renovación no coincide con el código guardado. Vuelve a generar uno nuevo.' };
    else if (message === 'RECOVERY_ROTATION_SUPERSEDED') mapped = { status: 409, code: 'RECOVERY_ROTATION_SUPERSEDED', message: 'Este código fue sustituido por una renovación posterior. Genera un código nuevo desde Configuración.' };
    else if (message === 'RECOVERY_ROTATION_FAILED') mapped = { status: 500, code: 'RECOVERY_ROTATION_FAILED', message: 'No se pudo renovar el código. El código anterior no se modificó.' };
    else if (message === 'INVITATION_INVALID') mapped = { status: 400, code: 'INVITATION_INVALID', message: 'El código de invitación no es válido, ha caducado, fue revocado o ya se utilizó.' };
    else if (message === 'INVITATION_ALREADY_PENDING') mapped = { status: 409, code: 'INVITATION_ALREADY_PENDING', message: 'Ya existe una invitación pendiente. Revócala si perdiste el código antes de generar otra.' };
    else if (message === 'INVITATION_BOOTSTRAP_REQUIRED') mapped = { status: 409, code: 'INVITATION_BOOTSTRAP_REQUIRED', message: 'El primer código de invitación debe generarse desde el SQL Editor de Supabase.' };
    else if (message === 'INVITATION_CREATE_FAILED') mapped = { status: 409, code: 'INVITATION_CREATE_FAILED', message: 'No se pudo generar la invitación. Actualiza Configuración y vuelve a intentarlo.' };
    else if (message === 'INVITATION_NOT_FOUND') mapped = { status: 404, code: 'INVITATION_NOT_FOUND', message: 'No hay una invitación pendiente que puedas revocar.' };
    else if (message === 'ACCOUNT_LIMIT_REACHED') mapped = { status: 409, code: 'ACCOUNT_LIMIT_REACHED', message: 'Este espacio privado ya tiene sus dos cuentas.' };
    else if (message === 'REGISTRATION_FAILED') mapped = { status: 400, code: 'REGISTRATION_FAILED', message: 'No se pudo crear la cuenta. Revisa los datos e inténtalo de nuevo.' };
    else if (message === 'RECOVERY_CODE_INVALID') mapped = { status: 400, code: 'RECOVERY_CODE_INVALID', message: 'El usuario o el código de recuperación no son válidos, o el código ya fue utilizado.' };
    else if (message === 'SESSION_CREATE_FAILED') mapped = { status: 503, code: 'SESSION_CREATE_FAILED', message: 'No se pudo crear la sesión. Vuelve a intentarlo.' };
    console.error('auth-api error', mapped.code);
    return jsonResponse(req, { ok: false, code: mapped.code, message: mapped.message }, mapped.status, headers);
  }
});
