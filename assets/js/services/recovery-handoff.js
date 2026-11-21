const STORAGE_KEY = 'nuestro-rincon:pending-recovery:v1';

function createRecoveryCode() {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  const hex = Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('').toUpperCase();
  return hex.match(/.{1,6}/g)?.join('-') || hex;
}

function makeRequestId() {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function readPendingRecovery() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const pending = JSON.parse(raw);
    if (!pending || pending.version !== 1
      || !['registration', 'rotation'].includes(pending.purpose)
      || typeof pending.requestId !== 'string'
      || typeof pending.recoveryCode !== 'string'
      || !/^(?:[A-F0-9]{6}-){7}[A-F0-9]{6}$/.test(pending.recoveryCode)) {
      localStorage.removeItem(STORAGE_KEY);
      return null;
    }
    return pending;
  } catch {
    return null;
  }
}

export function savePendingRecovery(pending) {
  if (!pending || !['registration', 'rotation'].includes(pending.purpose)) {
    throw new Error('RECOVERY_HANDOFF_INVALID');
  }
  const safe = {
    version: 1,
    purpose: pending.purpose,
    requestId: String(pending.requestId || makeRequestId()),
    recoveryCode: String(pending.recoveryCode || createRecoveryCode()),
    serverConfirmed: pending.serverConfirmed === true,
    createdAt: pending.createdAt || new Date().toISOString()
  };
  if (safe.purpose === 'registration') {
    safe.invitationCode = String(pending.invitationCode || '').trim();
    safe.displayName = String(pending.displayName || '').trim();
    safe.username = String(pending.username || '').trim();
  }
  try {
    // Nunca almacenar contraseñas. El código permanece en el perfil local del
    // navegador hasta que la persona confirme que ya lo guardó fuera del dispositivo.
    // Esto permite recuperarlo tras cerrar accidentalmente la pestaña o el navegador.
    localStorage.setItem(STORAGE_KEY, JSON.stringify(safe));
  } catch {
    throw new Error('RECOVERY_STORAGE_UNAVAILABLE');
  }
  return safe;
}

export function createPendingRegistration(data = {}) {
  return savePendingRecovery({
    purpose: 'registration',
    requestId: makeRequestId(),
    recoveryCode: createRecoveryCode(),
    invitationCode: data.invitationCode,
    displayName: data.displayName,
    username: data.username
  });
}

export function createPendingRotation() {
  return savePendingRecovery({
    purpose: 'rotation',
    requestId: makeRequestId(),
    recoveryCode: createRecoveryCode()
  });
}

export function markPendingRecoveryConfirmed() {
  const pending = readPendingRecovery();
  if (!pending) return null;
  return savePendingRecovery({ ...pending, serverConfirmed: true });
}

export function clearPendingRecovery() {
  try { localStorage.removeItem(STORAGE_KEY); } catch { /* almacenamiento privado o bloqueado */ }
}

export function isUncertainRequestError(error) {
  const status = Number(error?.status || 0);
  return !status || status >= 500 || error?.code === 'NETWORK_ERROR' || error?.code === 'TIMEOUT';
}

export { STORAGE_KEY as PENDING_RECOVERY_STORAGE_KEY };
