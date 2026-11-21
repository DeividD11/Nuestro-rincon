const STORAGE_KEY = 'nuestro-rincon:pending-recovery:v1';

function createRecoveryCode() {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  const hex = Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('').toUpperCase();
  return hex.match(/.{1,6}/g)?.join('-') || hex;
}

function createRecoveryCodeBundle(count = 10) {
  return Array.from({ length: count }, () => createRecoveryCode());
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
    const validCode = value => typeof value === 'string' && /^(?:[A-F0-9]{6}-){7}[A-F0-9]{6}$/.test(value);
    const baseValid = pending && typeof pending.requestId === 'string'
      && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(pending.requestId);
    const singleValid = pending?.version === 1
      && ['registration', 'rotation'].includes(pending.purpose)
      && baseValid && validCode(pending.recoveryCode);
    const bundleValid = pending?.version === 2
      && ['registration_bundle', 'rotation_bundle'].includes(pending.purpose)
      && baseValid && Array.isArray(pending.recoveryCodes)
      && pending.recoveryCodes.length === 10
      && pending.recoveryCodes.every(validCode)
      && new Set(pending.recoveryCodes).size === 10
      && (pending.purpose !== 'registration_bundle' || (typeof pending.invitationCode === 'string' && typeof pending.displayName === 'string' && typeof pending.username === 'string'));
    if (!singleValid && !bundleValid) {
      localStorage.removeItem(STORAGE_KEY);
      return null;
    }
    return pending;
  } catch {
    return null;
  }
}

export function savePendingRecovery(pending) {
  if (!pending || !['registration', 'rotation', 'rotation_bundle', 'registration_bundle'].includes(pending.purpose)) {
    throw new Error('RECOVERY_HANDOFF_INVALID');
  }
  const requestId = String(pending.requestId || makeRequestId());
  const isBundle = ['rotation_bundle', 'registration_bundle'].includes(pending.purpose);
  const safe = isBundle
    ? {
        version: 2,
        purpose: pending.purpose,
        requestId,
        recoveryCodes: Array.isArray(pending.recoveryCodes) ? pending.recoveryCodes.map(String) : [],
        serverConfirmed: pending.serverConfirmed === true,
        createdAt: pending.createdAt || new Date().toISOString()
      }
    : {
        version: 1,
        purpose: pending.purpose,
        requestId,
        recoveryCode: String(pending.recoveryCode || createRecoveryCode()),
        serverConfirmed: pending.serverConfirmed === true,
        createdAt: pending.createdAt || new Date().toISOString()
      };
  if (isBundle) {
    if (safe.recoveryCodes.length !== 10 || !safe.recoveryCodes.every(code => /^(?:[A-F0-9]{6}-){7}[A-F0-9]{6}$/.test(code)) || new Set(safe.recoveryCodes).size !== 10) {
      throw new Error('RECOVERY_BUNDLE_INVALID');
    }
  }
  if (['registration', 'registration_bundle'].includes(safe.purpose)) {
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
    purpose: 'registration_bundle',
    requestId: makeRequestId(),
    recoveryCodes: createRecoveryCodeBundle(10),
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

export function createPendingRecoveryCodeBundle() {
  return savePendingRecovery({
    purpose: 'rotation_bundle',
    requestId: makeRequestId(),
    recoveryCodes: createRecoveryCodeBundle(10)
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
