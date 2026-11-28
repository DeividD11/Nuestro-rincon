import test from 'node:test';
import assert from 'node:assert/strict';
import { AppView } from '../assets/js/views/app-view.js';

const view = new AppView(null);
const userA = '11111111-1111-4111-8111-111111111111';
const userB = '22222222-2222-4222-8222-222222222222';
const fileId = '33333333-3333-4333-8333-333333333333';
const path = `letters/${userA}/${userB}/${fileId}.webp`;
const base = {
  id: userA,
  sender_id: userB,
  recipient_id: userA,
  status: 'sent',
  title: 'Una carta para recordar',
  body: `<p>Un recuerdo</p><img data-image-path="${path}" alt="Imagen adjunta">`,
  created_at: '2026-11-20T12:00:00.000Z'
};

test('letter-stamp construye el sello pendiente con identidad y ruta de la primera imagen', () => {
  const markup = view.letterCard({ ...base });
  assert.match(markup, /class="letter-stamp has-image is-loading is-pending-source"/);
  assert.match(markup, new RegExp(`data-letter-id="${userA}"`));
  assert.match(markup, new RegExp(`data-image-path="${path.replaceAll('/', '\\/')}"`));
  assert.match(markup, /letter-stamp-fallback-mark">▧/);
});

test('letter-stamp representa una URL privada ya firmada desde el origen permitido', () => {
  const signedUrl = `https://tiqbmuubpbmxqvtkcdhq.supabase.co/storage/v1/object/sign/private-media/${path}?token=test`;
  const markup = view.letterCard({ ...base, firstImageUrl: signedUrl });
  assert.match(markup, /class="letter-stamp has-image is-loading"/);
  assert.ok(markup.includes(`src="${signedUrl}"`));
  assert.match(markup, /width="96" height="96" loading="lazy" decoding="async"/);
});

test('letter-stamp descarta rutas que no pertenecen al autor o al hilo y usa el icono normal', () => {
  const invalidPath = `letters/${userB}/${userB}/${fileId}.webp`;
  const markup = view.letterCard({ ...base, body: `<img data-image-path="${invalidPath}" alt="Imagen adjunta">` });
  assert.match(markup, /class="letter-stamp" aria-hidden="true">✉<\/div>/);
  assert.doesNotMatch(markup, /data-image-path=/);
});

test('letter-stamp conserva la ruta de la carta padre para una respuesta', () => {
  const replyId = '44444444-4444-4444-8444-444444444444';
  const markup = view.letterCard({ ...base, id: replyId, reply_to_letter_id: userA });
  assert.match(markup, new RegExp(`data-letter-id="${replyId}"`));
  assert.match(markup, new RegExp(`data-reply-to-letter-id="${userA}"`));
  assert.ok(markup.includes(`data-image-path="${path}"`));
});

test('los estados Borradores y Papelera mantienen acciones distintas sin alterar la miniatura', () => {
  const localDraft = view.letterCard({ ...base, id: 'local:one', status: 'draft', localDraftKey: 'draft-one', body: '' });
  assert.match(localDraft, /data-action="edit-local-draft"/);
  assert.match(localDraft, /Guardado en este dispositivo/);
  assert.match(localDraft, /data-action="discard-local-draft"/);
  const trash = view.letterCard({ ...base, isInTrash: true, purgeConfirmedAt: null }, false, { pendingLetterActions: new Set() });
  assert.match(trash, /data-action="restore-letter"/);
  assert.match(trash, /data-action="purge-letter"/);
});

test('una carta enviada por el usuario incluye su acción Editar; un compact no muestra acciones', () => {
  const own = view.letterCard({ ...base, sender_id: userA }, false, { user: { id: userA } });
  assert.match(own, /data-action="edit-sent-letter"/);
  const compact = view.letterCard({ ...base, sender_id: userA }, true, { user: { id: userA } });
  assert.match(compact, /class="letter-card compact"/);
  assert.doesNotMatch(compact, /data-action="edit-sent-letter"/);
});
