const VAULT_FORMAT = 'nuestro-rincon-recovery-vault';
const VAULT_VERSION = 1;
const PBKDF2_ITERATIONS = 600_000;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

function ownedBuffer(bytes) {
  const source = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const copy = new Uint8Array(source.byteLength);
  copy.set(source);
  return copy.buffer;
}

function toBase64Url(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function fromBase64Url(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value)) throw new Error('COPIA_PROTEGIDA_INVALIDA');
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - value.length % 4) % 4);
  const binary = atob(normalized);
  return Uint8Array.from(binary, character => character.charCodeAt(0));
}

function validRecoveryCode(value) {
  return /^(?:[A-F0-9]{6}-){7}[A-F0-9]{6}$/.test(String(value || ''));
}

async function deriveVaultKey(passphrase, salt, usages) {
  const material = await crypto.subtle.importKey(
    'raw', ownedBuffer(encoder.encode(passphrase)), 'PBKDF2', false, ['deriveKey']
  );
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: ownedBuffer(salt), iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    usages
  );
}

export async function encryptRecoveryVault(codes, passphrase) {
  if (!Array.isArray(codes) || codes.length !== 10 || !codes.every(validRecoveryCode) || new Set(codes).size !== 10) {
    throw new Error('RECOVERY_VAULT_CODES_INVALID');
  }
  if (typeof passphrase !== 'string' || passphrase.length < 14 || passphrase.length > 256) {
    throw new Error('RECOVERY_VAULT_PASSPHRASE_POLICY');
  }

  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveVaultKey(passphrase, salt, ['encrypt']);
  const payload = encoder.encode(JSON.stringify({
    format: VAULT_FORMAT,
    version: VAULT_VERSION,
    createdAt: new Date().toISOString(),
    codes
  }));
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: ownedBuffer(iv), tagLength: 128 },
    key,
    ownedBuffer(payload)
  );

  return {
    format: VAULT_FORMAT,
    version: VAULT_VERSION,
    kdf: { name: 'PBKDF2', hash: 'SHA-256', iterations: PBKDF2_ITERATIONS, salt: toBase64Url(salt) },
    cipher: { name: 'AES-256-GCM', iv: toBase64Url(iv), ciphertext: toBase64Url(new Uint8Array(ciphertext)) }
  };
}

export async function decryptRecoveryVault(serialized, passphrase) {
  if (typeof passphrase !== 'string' || passphrase.length < 1 || passphrase.length > 256) {
    throw new Error('COPIA_PROTEGIDA_PASSPHRASE_INVALIDA');
  }
  let envelope;
  try { envelope = typeof serialized === 'string' ? JSON.parse(serialized) : serialized; }
  catch { throw new Error('COPIA_PROTEGIDA_INVALIDA'); }

  if (envelope?.format !== VAULT_FORMAT || envelope?.version !== VAULT_VERSION
    || envelope?.kdf?.name !== 'PBKDF2' || envelope?.kdf?.hash !== 'SHA-256'
    || envelope?.kdf?.iterations !== PBKDF2_ITERATIONS || envelope?.cipher?.name !== 'AES-256-GCM') {
    throw new Error('COPIA_PROTEGIDA_FORMATO_NO_COMPATIBLE');
  }

  try {
    const salt = fromBase64Url(envelope.kdf.salt);
    const iv = fromBase64Url(envelope.cipher.iv);
    const ciphertext = fromBase64Url(envelope.cipher.ciphertext);
    if (salt.length !== 16 || iv.length !== 12 || ciphertext.length < 32 || ciphertext.length > 100_000) {
      throw new Error('COPIA_PROTEGIDA_INVALIDA');
    }
    const key = await deriveVaultKey(passphrase, salt, ['decrypt']);
    const plaintext = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: ownedBuffer(iv), tagLength: 128 }, key, ownedBuffer(ciphertext)
    );
    const payload = JSON.parse(decoder.decode(plaintext));
    if (payload?.format !== VAULT_FORMAT || payload?.version !== VAULT_VERSION
      || !Array.isArray(payload.codes) || payload.codes.length !== 10
      || !payload.codes.every(validRecoveryCode) || new Set(payload.codes).size !== 10) {
      throw new Error('COPIA_PROTEGIDA_CONTENIDO_INVALIDO');
    }
    return payload.codes;
  } catch (error) {
    if (error?.message?.startsWith('COPIA_PROTEGIDA_')) throw error;
    throw new Error('COPIA_PROTEGIDA_NO_SE_PUDO_ABRIR');
  }
}

export function downloadRecoveryVault(envelope) {
  const blob = new Blob([JSON.stringify(envelope, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `nuestro-rincon-copia-recuperacion-${new Date().toISOString().slice(0, 10)}.json`;
  anchor.hidden = true;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}
