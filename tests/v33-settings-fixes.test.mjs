import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { prepareImageFile } from '../assets/js/services/image-processing.js';

const read = path => readFile(new URL(path, import.meta.url), 'utf8');

test('el selector de avatar tiene un solo control visible y conserva un input accesible', async () => {
  const view = await read('../assets/js/views/settings-view.js');
  const css = await read('../assets/css/app.css');
  assert.match(view, /label class="btn btn-soft" for="profile-avatar-input"/);
  assert.match(view, /id="profile-avatar-input" class="visually-hidden profile-avatar-input"/);
  assert.match(css, /\.visually-hidden\s*\{[\s\S]*?clip-path:\s*inset\(50%\)/);
  assert.doesNotMatch(view, /<button[^>]+data-action="choose-avatar"/);
});

test('el avatar muestra una vista previa local antes de iniciar la subida y mantiene la imagen persistida', async () => {
  const view = await read('../assets/js/views/settings-view.js');
  const controller = await read('../assets/js/controllers/settings-controller.js');
  assert.match(view, /state\.profile\?\.previewUrl\s*\|\|\s*avatarUrl/);
  assert.match(view, /class="profile-avatar-preview \$\{avatarPreviewUrl/);
  assert.match(view, /alt="" loading="eager" decoding="async" fetchpriority="high"/);
  assert.doesNotMatch(view, /alt="Avatar de/);
  assert.match(controller, /URL\.createObjectURL\(file\)/);
  assert.match(controller, /this\.updateAvatarPreview\(previewUrl/);
  assert.match(controller, /this\.repository\.setAvatar\(media\.path\)/);
});

test('la revocación masiva está en el extremo derecho del encabezado de sesiones', async () => {
  const view = await read('../assets/js/views/settings-view.js');
  const css = await read('../assets/css/app.css');
  assert.match(view, /setting-card-heading sessions-card-heading[\s\S]*?data-action="revoke-other-sessions"[\s\S]*?sessions-card-body/);
  assert.match(css, /\.revoke-other-sessions\{[^}]*margin:0 0 0 auto!important/);
});

test('la revocación masiva actualiza la lista de forma optimista, mantiene el scroll y no recorre sesiones una por una', async () => {
  const click = await read('../assets/js/controllers/app-click-handler.js');
  const api = await read('../supabase/functions/letters-api/index.ts');
  const migration = (await read('../supabase/migrations/20261123205422_revoke_other_app_sessions_atomically.sql'));
  const block = click.slice(click.indexOf("case 'revoke-other-sessions':"), click.indexOf("case 'revoke-session':"));
  assert.match(block, /repository\.revokeOtherSessions\(\)/);
  assert.match(block, /this\.state\.sessions = originalSessions\.filter\(item => item\.isCurrent\)/);
  assert.match(block, /session-row:not\(\.is-current\)/);
  assert.match(block, /restoreScroll\(\)/);
  assert.match(block, /sessionList\.innerHTML = originalListMarkup/);
  assert.match(block, /error\.code === 'UNKNOWN_ACTION'/);
  assert.doesNotMatch(block, /repository\.revokeSession\(sessionId\)|for \(const sessionId of fallbackIds\)|this\.render\(|refreshSessions\(/);
  assert.match(api, /rpc<number>\('revoke_other_app_sessions'/);
  assert.match(api, /p_current_session_id: session\.sessionId/);
  assert.match(migration, /security invoker/i);
  assert.match(migration, /s\.id <> p_current_session_id/);
  assert.match(migration, /user_session_refresh_tokens/);
  assert.match(migration, /push_subscriptions/);
  assert.match(migration, /access_token_hash = null/);
  assert.match(migration, /grant execute[\s\S]*to service_role/i);
});

test('el procesador limita las codificaciones, admite PNG del navegador y elige el MIME real', async () => {
  const previousBitmap = globalThis.createImageBitmap;
  const previousDocument = globalThis.document;
  const outputTypes = [];
  let outputCount = 0;
  let closed = false;
  let canvas;
  globalThis.createImageBitmap = async () => ({
    width: 1600, height: 1200,
    draw: () => {},
    close: () => { closed = true; }
  });
  globalThis.document = {
    createElement: () => {
      canvas = {
        width: 0, height: 0,
        getContext: () => ({
          drawImage: () => {}, clearRect: () => {}, fillRect: () => {},
          save: () => {}, restore: () => {}
        }),
        toBlob: (callback, type, quality) => {
          outputTypes.push(type);
          outputCount++;
          if (type === 'image/webp') {
            callback(new Blob([new Uint8Array(Math.ceil(canvas.width * canvas.height * 0.01))], { type: 'image/png' }));
          } else {
            const bytes = Math.ceil(canvas.width * canvas.height * 0.01 * (quality || 1));
            callback(new Blob([new Uint8Array(bytes)], { type: 'image/jpeg' }));
          }
        }
      };
      return canvas;
    }
  };
  try {
    const source = new Blob([new Uint8Array(128)], { type: 'image/jpeg' });
    const result = await prepareImageFile(source, { maxDimension: 640, maxBytes: 1000 });
    assert.equal(result.type, 'image/jpeg');
    assert.ok(result.size <= 1000);
    assert.ok(outputTypes.includes('image/webp'));
    assert.ok(outputTypes.includes('image/jpeg'));
    assert.ok(canvas.width < 640, 'debe probar una dimensión menor si no cabe');
    assert.ok(outputCount <= 10, 'no debe generar decenas de codificaciones secuenciales');
    assert.equal(closed, true, 'debe liberar el bitmap decodificado');
  } finally {
    if (previousBitmap === undefined) delete globalThis.createImageBitmap;
    else globalThis.createImageBitmap = previousBitmap;
    if (previousDocument === undefined) delete globalThis.document;
    else globalThis.document = previousDocument;
  }
});

test('el contrato visual de avatar admite una respuesta PNG del navegador dentro del límite', async () => {
  const processor = await read('../assets/js/services/image-processing.js');
  const api = await read('../supabase/functions/letters-api/index.ts');
  assert.match(processor, /candidate\.type !== 'image\/webp'/);
  assert.match(processor, /fallback\.type/);
  assert.match(processor, /Math\.sqrt\(maxBytes \/ Math\.max\(1, candidate\.size\)\)/);
  assert.match(processor, /smallerScale/);
  assert.match(api, /image\/png/);
  assert.match(api, /MIME_EXTENSION/);
});

test('el procesador conserva PNG si el navegador no exporta WebP ni JPEG', async () => {
  const previousBitmap = globalThis.createImageBitmap;
  const previousDocument = globalThis.document;
  let canvas;
  globalThis.createImageBitmap = async () => ({ width: 1600, height: 1200, close() {} });
  globalThis.document = {
    createElement: () => {
      canvas = {
        width: 0, height: 0,
        getContext: () => ({ drawImage() {}, clearRect() {}, fillRect() {}, save() {}, restore() {} }),
        toBlob: callback => callback(new Blob([new Uint8Array(Math.ceil(canvas.width * canvas.height * 0.01))], { type: 'image/png' }))
      };
      return canvas;
    }
  };
  try {
    const source = new Blob([new Uint8Array(128)], { type: 'image/png' });
    const result = await prepareImageFile(source, { maxDimension: 640, maxBytes: 1500 });
    assert.equal(result.type, 'image/png');
    assert.ok(result.size <= 1500);
    assert.ok(result.size > 0);
  } finally {
    if (previousBitmap === undefined) delete globalThis.createImageBitmap;
    else globalThis.createImageBitmap = previousBitmap;
    if (previousDocument === undefined) delete globalThis.document;
    else globalThis.document = previousDocument;
  }
});
