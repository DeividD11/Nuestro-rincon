import webPush from 'web-push';
import {
  corsHeaders, dbRequest, errorStatus, jsonResponse, nowIso, patchRows,
  readJson, requireSession, rpc, sanitizeRichHtml, selectOne, selectCursorPageRows, selectRows, sha256Hex
} from '../_shared/core.ts';

const LETTER_FIELDS = 'id,thread_id,sender_id,recipient_id,reply_to_letter_id,title,body,status,revision,created_at,updated_at,sent_at,content_purged_at,creation_request_id';


type VapidConfig = { publicKey: string; privateKey: string; subject: string };

function vapidConfig(): VapidConfig | null {
  const publicKey = Deno.env.get('VAPID_PUBLIC_KEY') || '';
  const privateKey = Deno.env.get('VAPID_PRIVATE_KEY') || '';
  const subject = Deno.env.get('VAPID_SUBJECT') || '';
  const configuredValues = [publicKey, privateKey, subject].filter(Boolean).length;
  if (configuredValues === 0) return null;
  if (configuredValues !== 3) throw new Error('PUSH_VAPID_CONFIGURATION_INVALID');
  if (!/^[A-Za-z0-9_-]{80,100}$/.test(publicKey) || !/^[A-Za-z0-9_-]{40,100}$/.test(privateKey)
    || !/^(mailto:[^\s]+|https:\/\/[^\s]+)$/.test(subject)) {
    throw new Error('PUSH_VAPID_CONFIGURATION_INVALID');
  }
  return { publicKey, privateKey, subject };
}

function parsePushEndpoint(value: unknown): string {
  const raw = String(value || '');
  if (!raw || raw.length > 2048) throw new Error('PUSH_ENDPOINT_INVALID');
  let url: URL;
  try { url = new URL(raw); } catch { throw new Error('PUSH_ENDPOINT_INVALID'); }
  const host = url.hostname.toLowerCase();
  const allowedHost = host === 'fcm.googleapis.com'
    || host === 'web.push.apple.com'
    || host.endsWith('.push.services.mozilla.com')
    || host.endsWith('.notify.windows.com');
  if (url.protocol !== 'https:' || !allowedHost || url.username || url.password
    || (url.port && url.port !== '443') || url.hash) {
    throw new Error('PUSH_ENDPOINT_INVALID');
  }
  return url.toString();
}

function actionRateGroup(action: string): 'letter_list' | 'read' | 'write' | 'security' {
  if (action === 'list') return 'letter_list';
  if (['dashboard', 'get', 'notifications', 'notification:read', 'settings:get', 'push:config', 'sessions'].includes(action)) return 'read';
  if (['purge', 'session:revoke', 'push:subscribe', 'push:unsubscribe'].includes(action)) return 'security';
  return 'write';
}

async function dispatchPushForLetter(letterId: string | null, recipientId: string | null) {
  if (!letterId || !recipientId) return;
  let config: VapidConfig | null;
  try { config = vapidConfig(); } catch { console.error('push configuration invalid'); return; }
  if (!config) return;

  const notification = await selectOne<Record<string, unknown>>('notifications', {
    select: 'id,user_id,letter_id,notification_type',
    user_id: `eq.${recipientId}`, letter_id: `eq.${letterId}`,
    notification_type: 'in.(letter_received,letter_reply_received)',
    order: 'created_at.desc', limit: '1'
  });
  if (!notification) return;

  const subscriptions = await selectRows<Record<string, unknown>>('push_subscriptions', {
    select: 'id,session_id,endpoint,p256dh,auth', user_id: `eq.${recipientId}`, limit: '20'
  });
  if (!subscriptions.length) return;

  webPush.setVapidDetails(config.subject, config.publicKey, config.privateKey);
  const now = nowIso();
  for (const subscription of subscriptions) {
    const sessionId = String(subscription.session_id || '');
    const activeSession = await selectOne<Record<string, unknown>>('user_sessions', {
      select: 'id', id: `eq.${sessionId}`, user_id: `eq.${recipientId}`, revoked_at: 'is.null',
      idle_expires_at: `gt.${now}`, absolute_expires_at: `gt.${now}`
    });
    if (!activeSession) {
      await dbRequest(`push_subscriptions?id=eq.${encodeURIComponent(String(subscription.id))}&user_id=eq.${encodeURIComponent(recipientId)}`, {
        method: 'DELETE', headers: { Prefer: 'return=minimal' }
      });
      continue;
    }

    const claim = await rpc<Record<string, unknown>>('claim_app_push_delivery', {
      p_notification_id: notification.id, p_subscription_id: subscription.id, p_now: nowIso()
    });
    if (claim.claimed !== true) continue;

    try {
      const result = await webPush.sendNotification({
        endpoint: String(subscription.endpoint),
        keys: { p256dh: String(subscription.p256dh), auth: String(subscription.auth) }
      }, JSON.stringify({
        title: 'Tienes una nueva carta',
        body: 'Abre Nuestro Rincón para leerla.',
        url: './#/notifications'
      }), { TTL: 60, urgency: 'high' });
      await patchRows('push_delivery_attempts', { id: `eq.${claim.attempt_id}` }, {
        status: 'sent', http_status: Number(result.statusCode || 201), attempted_at: nowIso()
      });
    } catch (error) {
      const statusCode = Number((error as { statusCode?: number })?.statusCode || 0);
      if (statusCode === 404 || statusCode === 410) {
        await dbRequest(`push_subscriptions?id=eq.${encodeURIComponent(String(subscription.id))}&user_id=eq.${encodeURIComponent(recipientId)}`, {
          method: 'DELETE', headers: { Prefer: 'return=minimal' }
        });
        await patchRows('push_delivery_attempts', { id: `eq.${claim.attempt_id}` }, {
          status: 'gone', http_status: statusCode, attempted_at: nowIso()
        });
      } else {
        await patchRows('push_delivery_attempts', { id: `eq.${claim.attempt_id}` }, {
          status: 'failed', http_status: statusCode >= 100 && statusCode <= 599 ? statusCode : null,
          attempted_at: nowIso()
        });
      }
      // Nunca se registran el endpoint, las claves de suscripción o datos de la carta.
      console.error('push delivery failed', statusCode || 'network_error');
    }
  }
}

// Contratos explícitos de los RPC: no se permite propagar `unknown` hasta el
// acceso a propiedades ni asumir silenciosamente la forma de una respuesta.
type CreateDraftRpcRecord = {
  id: string;
  [field: string]: unknown;
};
type CreateDraftRpcResult = {
  status: 'created' | 'not_found';
  draft?: CreateDraftRpcRecord;
};
type ListLetterRpcEntry = {
  letter: Record<string, unknown>;
  state: Record<string, unknown>;
  recipient_read_at: string | null;
};
type ListLettersRpcResult = {
  items: ListLetterRpcEntry[];
  total: number;
  unread: number;
  offset: number;
  limit: number;
  hasMore: boolean;
  nextOffset: number;
};
type LetterPageCursor = { sortAt: string; id: string };
type CursorLettersRpcResult = {
  items: ListLetterRpcEntry[];
  limit: number;
  hasMore: boolean;
  nextCursor: LetterPageCursor | null;
  loaded: number;
};
type RenameProfileRpcResult = {
  status: 'updated' | 'not_found' | 'invalid_input';
  user?: {
    id: string;
    username: string;
    email: string;
    displayName: string;
  };
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseCreateDraftRpcResult(value: unknown): CreateDraftRpcResult {
  if (!isRecord(value) || (value.status !== 'created' && value.status !== 'not_found')) {
    throw new Error('DRAFT_CREATE_RESPONSE_INVALID');
  }
  const rawDraft = value.draft;
  if (rawDraft === undefined || rawDraft === null) {
    if (value.status === 'created') throw new Error('DRAFT_CREATE_RESPONSE_INVALID');
    return { status: 'not_found' };
  }
  if (value.status !== 'created' || !isRecord(rawDraft) || typeof rawDraft.id !== 'string') {
    throw new Error('DRAFT_CREATE_RESPONSE_INVALID');
  }
  return { status: 'created', draft: rawDraft as CreateDraftRpcRecord };
}

function parseRenameProfileRpcResult(value: unknown): RenameProfileRpcResult {
  if (!isRecord(value) || !['updated', 'not_found', 'invalid_input'].includes(String(value.status))) {
    throw new Error('PROFILE_RENAME_RESPONSE_INVALID');
  }
  if (value.status !== 'updated') return { status: value.status as RenameProfileRpcResult['status'] };
  if (!isRecord(value.user)
    || typeof value.user.id !== 'string'
    || typeof value.user.username !== 'string'
    || typeof value.user.email !== 'string'
    || typeof value.user.displayName !== 'string') {
    throw new Error('PROFILE_RENAME_RESPONSE_INVALID');
  }
  return { status: 'updated', user: {
    id: value.user.id,
    username: value.user.username,
    email: value.user.email,
    displayName: value.user.displayName
  } };
}

function parseListLettersRpcResult(value: unknown): ListLettersRpcResult {
  if (!isRecord(value) || !Array.isArray(value.items)
    || !Number.isSafeInteger(value.total) || !Number.isSafeInteger(value.unread)
    || !Number.isSafeInteger(value.offset) || !Number.isSafeInteger(value.limit)
    || typeof value.hasMore !== 'boolean' || !Number.isSafeInteger(value.nextOffset)) {
    throw new Error('LETTER_LIST_RESPONSE_INVALID');
  }
  const items: ListLetterRpcEntry[] = value.items.filter((entry): entry is ListLetterRpcEntry =>
    isRecord(entry) && isRecord(entry.letter) && isRecord(entry.state)
      && (typeof entry.recipient_read_at === 'string' || entry.recipient_read_at === null)
  );
  if (items.length !== value.items.length) throw new Error('LETTER_LIST_RESPONSE_INVALID');
  return {
    items, total: Number(value.total), unread: Number(value.unread),
    offset: Number(value.offset), limit: Number(value.limit),
    hasMore: value.hasMore, nextOffset: Number(value.nextOffset)
  };
}

function safePageNumber(value: unknown, fallback: number, maximum: number): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? Math.min(parsed, maximum) : fallback;
}

async function getNames(ids: string[]) {
  const unique = [...new Set(ids.filter(Boolean))];
  if (!unique.length) return new Map<string, string>();
  const rows = await selectRows<Record<string, unknown>>('app_users', {
    select: 'id,display_name,username', id: `in.(${unique.join(',')})`
  });
  return new Map(rows.map(row => [String(row.id), String(row.display_name || row.username || 'Persona')]));
}

async function statesFor(userId: string, letterIds: string[]) {
  if (!letterIds.length) return new Map<string, Record<string, unknown>>();
  const rows = await selectRows<Record<string, unknown>>('letter_user_state', {
    select: 'letter_id,user_id,is_favorite,archived_at,trashed_at,read_at,purge_confirmed_at',
    user_id: `eq.${userId}`, letter_id: `in.(${letterIds.join(',')})`
  });
  return new Map(rows.map(row => [String(row.letter_id), row]));
}

// El estado de lectura pertenece al destinatario. Al consultar Enviadas,
// la fila de estado del remitente no contiene ese dato; se consulta aparte.
async function recipientStatesFor(rows: Record<string, unknown>[]) {
  if (!rows.length) return new Map<string, Record<string, unknown>>();
  const letterIds = [...new Set(rows.map(row => String(row.id)).filter(Boolean))];
  const recipientIds = [...new Set(rows.map(row => row.recipient_id ? String(row.recipient_id) : '').filter(Boolean))];
  if (!letterIds.length || !recipientIds.length) return new Map<string, Record<string, unknown>>();
  const states = await selectRows<Record<string, unknown>>('letter_user_state', {
    select: 'letter_id,user_id,read_at',
    user_id: `in.(${recipientIds.join(',')})`,
    letter_id: `in.(${letterIds.join(',')})`
  });
  return new Map(states.map(state => [String(state.letter_id), state]));
}

type DecoratedLetter = Record<string, unknown> & {
  id: unknown;
  title: unknown;
  body: string;
  sent_at: unknown;
  updated_at: unknown;
  isFavorite: boolean;
  isArchived: boolean;
  isInTrash: boolean;
  isUnread: boolean;
  readByRecipientAt: string | null;
  purgeConfirmedAt: string | null;
};

function decorate(row: Record<string, unknown>, state: Record<string, unknown> | undefined, names: Map<string,string>, recipientState?: Record<string, unknown>): DecoratedLetter {
  return {
    ...row,
    id: row.id,
    title: row.title,
    sent_at: row.sent_at,
    updated_at: row.updated_at,
    body: sanitizeRichHtml(row.body),
    senderName: names.get(String(row.sender_id)) || 'Remitente',
    recipientName: names.get(String(row.recipient_id)) || 'Destinatario',
    otherName: row.sender_id === state?.user_id ? (names.get(String(row.recipient_id)) || 'Destinatario') : (names.get(String(row.sender_id)) || 'Remitente'),
    isFavorite: Boolean(state?.is_favorite),
    isArchived: Boolean(state?.archived_at),
    isInTrash: Boolean(state?.trashed_at),
    purgeConfirmedAt: state?.purge_confirmed_at ? String(state.purge_confirmed_at) : null,
    read_at: state?.read_at || null,
    readByRecipientAt: recipientState?.read_at ? String(recipientState.read_at) : null,
    isUnread: row.status === 'sent' && row.recipient_id === state?.user_id && !state?.read_at
  };
}

async function fetchLetterList(userId: string, folder: string, search: string, offset = 0, limit = 40) {
  const raw = await rpc<unknown>('list_user_letters', {
    p_user_id: userId,
    p_folder: folder,
    p_search: search.trim().slice(0, 120),
    p_offset: offset,
    p_limit: limit
  });
  const page = parseListLettersRpcResult(raw);
  const rows = page.items.map(entry => entry.letter);
  if (!rows.length) {
    return {
      items: [], total: page.total, unread: page.unread, offset: page.offset,
      limit: page.limit, hasMore: page.hasMore, nextOffset: page.nextOffset
    };
  }
  const states = new Map(page.items.map(entry => [String(entry.letter.id), entry.state]));
  const recipientStates = new Map(page.items
    .filter(entry => typeof entry.recipient_read_at === 'string')
    .map(entry => [String(entry.letter.id), { read_at: entry.recipient_read_at }]));
  const names = await getNames(rows.flatMap(row => [
    String(row.sender_id), row.recipient_id ? String(row.recipient_id) : ''
  ]));
  const items = rows.map(row => decorate(
    row,
    states.get(String(row.id)),
    names,
    recipientStates.get(String(row.id))
  ));
  return {
    items, total: page.total, unread: page.unread, offset: page.offset,
    limit: page.limit, hasMore: page.hasMore, nextOffset: page.nextOffset
  };
}
async function fetchLetterListCursor(userId: string, folder: string, search: string, cursor: LetterPageCursor | null, limit = 40) {
  const raw = await rpc<unknown>('list_user_letters_cursor', {
    p_user_id: userId,
    p_folder: folder,
    p_search: search.trim().slice(0, 120),
    p_cursor_sort_at: cursor?.sortAt ?? null,
    p_cursor_id: cursor?.id ?? null,
    p_limit: limit
  });
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('LETTER_CURSOR_RESPONSE_INVALID');
  const page = raw as CursorLettersRpcResult;
  if (!Array.isArray(page.items) || typeof page.hasMore !== 'boolean'
    || !Number.isInteger(page.limit) || page.limit < 1 || page.limit > 100
    || (page.nextCursor !== null && (!page.nextCursor || typeof page.nextCursor.sortAt !== 'string'
      || !Number.isFinite(Date.parse(page.nextCursor.sortAt)) || !/^[0-9a-f-]{36}$/i.test(page.nextCursor.id)))) {
    throw new Error('LETTER_CURSOR_RESPONSE_INVALID');
  }
  const rows = page.items.map(entry => entry.letter);
  if (!rows.length) return { items: [], limit: page.limit, hasMore: false, nextCursor: null, loaded: 0 };
  const states = new Map(page.items.map(entry => [String(entry.letter.id), entry.state]));
  const recipientStates = new Map(page.items
    .filter(entry => typeof entry.recipient_read_at === 'string')
    .map(entry => [String(entry.letter.id), { read_at: entry.recipient_read_at }]));
  const names = await getNames(rows.flatMap(row => [
    String(row.sender_id), row.recipient_id ? String(row.recipient_id) : ''
  ]));
  return {
    items: rows.map(row => decorate(row, states.get(String(row.id)), names, recipientStates.get(String(row.id)))),
    limit: page.limit,
    hasMore: page.hasMore,
    nextCursor: page.hasMore ? page.nextCursor : null,
    loaded: rows.length
  };
}

function stripTags(html: string) { return html.replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' '); }

async function checkedLetter(letterId: string, userId: string) {
  if (!/^[0-9a-f-]{36}$/i.test(letterId)) throw new Error('LETTER_NOT_FOUND');
  const letter = await selectOne<Record<string,unknown>>('letters', { select: LETTER_FIELDS, id: `eq.${letterId}` });
  if (!letter || ![letter.sender_id, letter.recipient_id].includes(userId) || letter.content_purged_at) throw new Error('LETTER_NOT_FOUND');
  if (letter.status === 'draft' && letter.sender_id !== userId) throw new Error('LETTER_NOT_FOUND');
  return letter;
}

async function getLetterBundle(letterId: string, userId: string, threadCursor: LetterPageCursor | null = null, threadLimit = 40) {
  const current = await checkedLetter(letterId, userId);
  let threadRows: Record<string,unknown>[] = [];
  let threadHasMore = false;
  let threadNextCursor: LetterPageCursor | null = null;
  let threadLoadedOlderCount = 0;
  if (current.status === 'sent') {
    const page = await selectCursorPageRows<Record<string, unknown>>('letters', {
      select: LETTER_FIELDS,
      thread_id: `eq.${current.thread_id}`,
      status: 'eq.sent',
      content_purged_at: 'is.null'
    }, 'sent_at', threadCursor, threadLimit);
    threadRows = page.items;
    const selectedOutsideInitialPage = !threadRows.some(row => String(row.id) === String(current.id));
    if (selectedOutsideInitialPage) threadRows.push(current);
    if (!threadCursor && selectedOutsideInitialPage) threadLoadedOlderCount = 1;
    threadRows = [...new Map(threadRows.map(row => [String(row.id), row])).values()]
      .sort((a, b) => new Date(String(a.sent_at || a.created_at)).getTime()
        - new Date(String(b.sent_at || b.created_at)).getTime()
        || String(a.id).localeCompare(String(b.id)));
    threadHasMore = page.hasMore;
    threadNextCursor = page.nextCursor;
  } else {
    threadRows = [current];
  }
  const ids = threadRows.map(row => String(row.id));
  const [states, recipientStates, names] = await Promise.all([
    statesFor(userId, ids),
    recipientStatesFor(threadRows),
    getNames(threadRows.flatMap(row => [String(row.sender_id), row.recipient_id ? String(row.recipient_id) : '']))
  ]);
  const decorated = threadRows.map(row => decorate(row, states.get(String(row.id)), names, recipientStates.get(String(row.id))));
  const letter = decorated.find(row => row.id === current.id)
    || decorate(current, states.get(String(current.id)), names, recipientStates.get(String(current.id)));
  return { letter, thread: decorated, threadHasMore, threadNextCursor, threadLoadedOlderCount };
}

async function handleAction(action: string, body: Record<string, unknown>, session: Awaited<ReturnType<typeof requireSession>>) {
  const userId = session.userId;
  switch (action) {
    case 'dashboard': {
      const [inbox, sent, drafts] = await Promise.all([
        fetchLetterList(userId, 'inbox', '', 0, 5),
        fetchLetterList(userId, 'sent', '', 0, 5),
        fetchLetterList(userId, 'drafts', '', 0, 1)
      ]);
      const recent = [...new Map([...inbox.items, ...sent.items].map(item => [String(item.id), item])).values()]
        .sort((a,b) => new Date(String(b.sent_at || b.updated_at)).getTime() - new Date(String(a.sent_at || a.updated_at)).getTime()).slice(0, 5);
      return { received: inbox.total, unread: inbox.unread, sent: sent.total, drafts: drafts.total, recent };
    }
    case 'list': {
      const folder = String(body.folder || 'inbox');
      if (!['inbox','sent','drafts','favorites','archive','trash'].includes(folder)) throw new Error('INVALID_INPUT');
      const cursorValue = body.cursor;
      const cursor = cursorValue == null ? null : cursorValue as LetterPageCursor;
      if (cursor && (!Number.isFinite(Date.parse(String(cursor.sortAt || ''))) || !/^[0-9a-f-]{36}$/i.test(String(cursor.id || '')))) throw new Error('INVALID_INPUT');
      const limit = Math.min(100, Math.max(1, safePageNumber(body.limit, 40, 100)));
      return fetchLetterListCursor(userId, folder, String(body.search || '').slice(0, 120), cursor, limit);
    }
    case 'get': {
      const cursorValue = body.threadCursor;
      const cursor = cursorValue == null ? null : cursorValue as LetterPageCursor;
      if (cursor && (!Number.isFinite(Date.parse(String(cursor.sortAt || ''))) || !/^[0-9a-f-]{36}$/i.test(String(cursor.id || '')))) throw new Error('INVALID_INPUT');
      const limit = Math.min(100, Math.max(1, safePageNumber(body.threadLimit, 40, 100)));
      return getLetterBundle(String(body.letterId || ''), userId, cursor, limit);
    }
    case 'draft:create': {
      const title = String(body.title || '').slice(0, 180);
      const html = sanitizeRichHtml(body.body);
      // El acceso al editor no crea registros. El cuerpo debe contener texto
      // real antes de que el servidor acepte crear un borrador.
      if (!stripTags(html).replace(/&nbsp;/g, ' ').trim()) return { status: 'empty' };
      const raw = await rpc<unknown>('create_letter_draft', {
        p_sender_id: userId, p_creation_request_id: String(body.creationRequestId || crypto.randomUUID()), p_title: title, p_body: html
      });
      const data = parseCreateDraftRpcResult(raw);
      const draft = data.draft;
      const draftId = draft?.id ?? null;
      if (draftId) {
        const state = await selectOne<Record<string, unknown>>('letter_user_state', {
          select: 'trashed_at', letter_id: `eq.${draftId}`, user_id: `eq.${userId}`
        });
        if (state?.trashed_at) return { status: 'discarded', draft };
      }
      return data;
    }
    case 'draft:save': {
      const letter = await checkedLetter(String(body.letterId || ''), userId);
      if (letter.status !== 'draft' || letter.sender_id !== userId) throw new Error('LETTER_NOT_FOUND');
      const state = await selectOne<Record<string, unknown>>('letter_user_state', {
        select: 'trashed_at', letter_id: `eq.${letter.id}`, user_id: `eq.${userId}`
      });
      // Una sincronización automática pendiente nunca debe sacar una carta
      // de Papelera. La recuperación es una acción explícita del usuario.
      if (state?.trashed_at) return { status: 'discarded', letterId: letter.id };
      const html = sanitizeRichHtml(body.body);
      return rpc('save_letter_draft', { p_sender_id: userId, p_letter_id: letter.id, p_title: String(body.title || '').slice(0,180), p_body: html, p_expected_revision: Number(body.expectedRevision || 1) });
    }
    case 'draft:send': {
      const letter = await checkedLetter(String(body.letterId || ''), userId);
      if (letter.status !== 'draft' || letter.sender_id !== userId) throw new Error('LETTER_NOT_FOUND');
      const state = await selectOne<Record<string, unknown>>('letter_user_state', {
        select: 'trashed_at', letter_id: `eq.${letter.id}`, user_id: `eq.${userId}`
      });
      if (state?.trashed_at) return { status: 'discarded', letterId: letter.id };
      return rpc('send_letter_draft', { p_sender_id: userId, p_letter_id: letter.id, p_expected_revision: Number(body.expectedRevision || 1) });
    }
    case 'reply': {
      const parent = await checkedLetter(String(body.parentLetterId || ''), userId);
      if (parent.status !== 'sent' || parent.recipient_id !== userId) throw new Error('LETTER_NOT_FOUND');
      const html = sanitizeRichHtml(body.body);
      if (!stripTags(html).trim()) throw new Error('INVALID_INPUT');
      return rpc('create_letter_reply', { p_actor_id: userId, p_parent_letter_id: parent.id, p_creation_request_id: String(body.creationRequestId || crypto.randomUUID()), p_title: String(body.title || '').slice(0,180), p_body: html });
    }
    case 'read': {
      const threadId = String(body.threadId || '');
      if (!/^[0-9a-f-]{36}$/i.test(threadId)) throw new Error('INVALID_INPUT');
      const thread = await selectOne<Record<string,unknown>>('letter_threads', { select: 'id,participant_a_id,participant_b_id', id: `eq.${threadId}` });
      if (!thread || ![thread.participant_a_id, thread.participant_b_id].includes(userId)) throw new Error('LETTER_NOT_FOUND');
      return rpc('mark_thread_letters_read', { p_user_id: userId, p_thread_id: threadId });
    }
    case 'favorite': {
      const letter = await checkedLetter(String(body.letterId || ''), userId);
      return rpc('set_letter_favorite_state', { p_user_id: userId, p_letter_id: letter.id, p_favorite: Boolean(body.favorite) });
    }
    case 'archive': {
      const letter = await checkedLetter(String(body.letterId || ''), userId);
      return rpc('set_letter_archive_state', { p_user_id: userId, p_letter_id: letter.id, p_archived: Boolean(body.archived) });
    }
    case 'trash': {
      const letter = await checkedLetter(String(body.letterId || ''), userId);
      return rpc('move_letter_to_trash', { p_user_id: userId, p_letter_id: letter.id });
    }
    case 'restore': {
      const letter = await checkedLetter(String(body.letterId || ''), userId);
      return rpc('restore_letter_from_trash', { p_user_id: userId, p_letter_id: letter.id });
    }
    case 'purge': {
      const letter = await checkedLetter(String(body.letterId || ''), userId);
      return rpc('confirm_letter_permanent_deletion', { p_user_id: userId, p_letter_id: letter.id });
    }
    case 'notifications': {
      const cursorValue = body.cursor;
      const cursor = cursorValue == null ? null : cursorValue as LetterPageCursor;
      if (cursor && (!Number.isFinite(Date.parse(String(cursor.sortAt || ''))) || !/^[0-9a-f-]{36}$/i.test(String(cursor.id || '')))) throw new Error('INVALID_INPUT');
      const limit = Math.min(100, Math.max(1, safePageNumber(body.limit, 30, 100)));
      const page = await selectCursorPageRows<Record<string, unknown>>('notifications', {
        select: 'id,user_id,letter_id,actor_user_id,notification_type,created_at,read_at,metadata',
        user_id: `eq.${userId}`
      }, 'created_at', cursor, limit);
      const items = page.items;
      const [names, letters] = await Promise.all([
        getNames(items.map(item => String(item.actor_user_id || ''))),
        items.length ? selectRows<Record<string,unknown>>('letters', { select: 'id,title', id: `in.(${items.map(item => String(item.letter_id)).join(',')})` }) : Promise.resolve([])
      ]);
      const titleMap = new Map(letters.map(row => [String(row.id), String(row.title || 'una carta')]));
      return {
        items: items.map(item => {
          const actor = names.get(String(item.actor_user_id)) || 'Alguien';
          const verb = item.notification_type === 'letter_reply_received'
            ? 'respondió a tu carta'
            : item.notification_type === 'letter_read' ? 'leyó tu carta' : 'te escribió una carta';
          return { ...item, message: `${actor} ${verb}: “${titleMap.get(String(item.letter_id)) || 'una carta'}”` };
        }),
        limit: page.limit, hasMore: page.hasMore, nextCursor: page.nextCursor,
        loaded: items.length
      };
    }
    case 'notification:read': {
      const id = String(body.notificationId || '');
      if (!/^[0-9a-f-]{36}$/i.test(id)) throw new Error('INVALID_INPUT');
      await patchRows('notifications', { id: `eq.${id}`, user_id: `eq.${userId}`, read_at: 'is.null' }, { read_at: nowIso() });
      return { status: 'read' };
    }
    case 'push:config': {
      const config = vapidConfig();
      const current = await selectOne<Record<string, unknown>>('push_subscriptions', {
        select: 'id', user_id: `eq.${userId}`, session_id: `eq.${session.sessionId}`, limit: '1'
      });
      return { enabled: Boolean(config), publicKey: config?.publicKey || null, subscribed: Boolean(current) };
    }
    case 'push:subscribe': {
      const subscription = body.subscription;
      if (!isRecord(subscription) || !isRecord(subscription.keys)) throw new Error('PUSH_SUBSCRIPTION_INVALID');
      const endpoint = parsePushEndpoint(subscription.endpoint);
      const p256dh = String(subscription.keys.p256dh || '');
      const auth = String(subscription.keys.auth || '');
      if (!/^[A-Za-z0-9_-]{40,200}$/.test(p256dh) || !/^[A-Za-z0-9_-]{12,100}$/.test(auth)) {
        throw new Error('PUSH_SUBSCRIPTION_INVALID');
      }
      const result = await rpc<Record<string, unknown>>('upsert_app_push_subscription', {
        p_user_id: userId, p_session_id: session.sessionId,
        p_endpoint_hash: await sha256Hex(endpoint), p_endpoint: endpoint,
        p_p256dh: p256dh, p_auth: auth,
        p_user_agent: String(body.userAgent || '').slice(0, 500), p_now: nowIso()
      });
      if (result.status !== 'subscribed') throw new Error('PUSH_SUBSCRIPTION_FAILED');
      return { status: 'subscribed' };
    }
    case 'push:unsubscribe': {
      const endpoint = parsePushEndpoint(body.endpoint);
      await dbRequest(`push_subscriptions?endpoint_hash=eq.${encodeURIComponent(await sha256Hex(endpoint))}&user_id=eq.${encodeURIComponent(userId)}&session_id=eq.${encodeURIComponent(session.sessionId)}`, {
        method: 'DELETE', headers: { Prefer: 'return=minimal' }
      });
      return { status: 'unsubscribed' };
    }
    case 'settings:get': {
      let settings = await selectOne<Record<string,unknown>>('user_settings', { select: 'user_id,theme,locale,time_zone,in_app_notifications_enabled', user_id: `eq.${userId}` });
      if (!settings) {
        const rows = await dbRequest<Record<string,unknown>[]>('user_settings', { method: 'POST', headers: { Prefer: 'return=representation' }, body: JSON.stringify({ user_id: userId, theme: 'system', locale: 'es-CO', time_zone: 'America/Bogota', in_app_notifications_enabled: true }) });
        settings = rows[0] || { theme: 'system', locale: 'es-CO', time_zone: 'America/Bogota', in_app_notifications_enabled: true };
      }
      return { settings };
    }
    case 'settings:update': {
      const timeZone = String(body.timeZone || 'America/Bogota');
      const theme = String(body.theme || 'system');
      const allowedZones = new Set(['America/Bogota','UTC','America/Mexico_City','Europe/Madrid']);
      const allowedThemes = new Set(['light','dark','system']);
      if (!allowedZones.has(timeZone) || !allowedThemes.has(theme)) throw new Error('INVALID_INPUT');
      await patchRows('user_settings', { user_id: `eq.${userId}` }, {
        theme, time_zone: timeZone,
        in_app_notifications_enabled: Boolean(body.notificationsEnabled), updated_at: nowIso()
      });
      return { settings: await selectOne('user_settings', { select: 'user_id,theme,locale,time_zone,in_app_notifications_enabled', user_id: `eq.${userId}` }) };
    }
    case 'profile:rename': {
      const displayName = String(body.displayName || '').trim();
      if (!displayName || displayName.length > 80) throw new Error('INVALID_INPUT');
      const raw = await rpc<unknown>('rename_app_profile', {
        p_user_id: userId,
        p_display_name: displayName,
        p_now: nowIso()
      });
      const result = parseRenameProfileRpcResult(raw);
      if (result.status !== 'updated' || !result.user) throw new Error('PROFILE_UPDATE_FAILED');
      return { user: result.user };
    }
    case 'sessions': {
      const sessions = await selectRows<Record<string,unknown>>('user_sessions', { select: 'id,device_label,user_agent,created_at,last_seen_at,idle_expires_at,absolute_expires_at,revoked_at', user_id: `eq.${userId}`, order: 'last_seen_at.desc', limit: '30' });
      return { sessions: sessions.filter(row => !row.revoked_at && new Date(String(row.absolute_expires_at)).getTime() > Date.now()).map(row => ({ ...row, isCurrent: row.id === session.sessionId })) };
    }
    case 'session:revoke': {
      const id = String(body.sessionId || '');
      if (!/^[0-9a-f-]{36}$/i.test(id) || id === session.sessionId) throw new Error('INVALID_INPUT');
      const target = await selectOne('user_sessions', { select: 'id', id: `eq.${id}`, user_id: `eq.${userId}`, revoked_at: 'is.null' });
      if (!target) throw new Error('SESSION_NOT_FOUND');
      await patchRows('user_sessions', { id: `eq.${id}`, user_id: `eq.${userId}` }, { revoked_at: nowIso(), revocation_reason: 'user_revoked' });
      await patchRows('user_session_refresh_tokens', { session_id: `eq.${id}` }, { revoked_at: nowIso() });
      await dbRequest(`push_subscriptions?session_id=eq.${encodeURIComponent(id)}&user_id=eq.${encodeURIComponent(userId)}`, { method: 'DELETE', headers: { Prefer: 'return=minimal' } });
      return { status: 'revoked' };
    }
    default: throw new Error('UNKNOWN_ACTION');
  }
}

Deno.serve(async (req: Request) => {
  let headers: Headers;
  try { headers = corsHeaders(req); } catch (error) {
    const mapped = errorStatus(error);
    return jsonResponse(req, { ok: false, code: mapped.code, message: mapped.message }, mapped.status, new Headers());
  }
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers });
  if (req.method !== 'POST') return jsonResponse(req, { ok: false, code: 'METHOD_NOT_ALLOWED', message: 'Método no permitido.' }, 405, headers);
  try {
    const body = await readJson(req);
    const session = await requireSession(req);
    const action = String(body.action || '');
    const rate = await rpc<Record<string, unknown>>('consume_app_api_rate_limit', {
      p_user_id: session.userId, p_session_id: session.sessionId,
      p_action_group: actionRateGroup(action), p_now: nowIso()
    });
    if (rate.allowed !== true) {
      const retryAfter = Math.max(1, Number(rate.retry_after_seconds || 60));
      headers.set('Retry-After', String(retryAfter));
      return jsonResponse(req, { ok: false, code: 'RATE_LIMITED', retryAfterSeconds: retryAfter, message: 'Demasiadas solicitudes. Espera un momento y vuelve a intentarlo.' }, 429, headers);
    }
    const result = await handleAction(action, body, session);
    if ((action === 'draft:send' || action === 'reply') && isRecord(result) && isRecord(result.letter)) {
      const successfulSend = action === 'draft:send'
        ? ['sent', 'already_sent'].includes(String(result.status))
        : String(result.status) === 'created';
      if (successfulSend) {
        const letterId = typeof result.letter.id === 'string' ? result.letter.id : null;
        const recipientId = typeof result.letter.recipient_id === 'string' ? result.letter.recipient_id : null;
        const pushTask = dispatchPushForLetter(letterId, recipientId).catch(error => {
          console.error('push dispatch failed', errorStatus(error).code);
        });
        const edgeRuntime = (globalThis as typeof globalThis & {
          EdgeRuntime?: { waitUntil: (promise: Promise<unknown>) => void };
        }).EdgeRuntime;
        if (typeof edgeRuntime?.waitUntil === 'function') edgeRuntime.waitUntil(pushTask);
        else await pushTask;
      }
    }
    return jsonResponse(req, { ok: true, ...((result && typeof result === 'object' && !Array.isArray(result)) ? result as Record<string,unknown> : { result }) }, 200, headers);
  } catch (error) {
    const message = error instanceof Error ? error.message : '';
    let mapped = errorStatus(error);
    if (message === 'LETTER_NOT_FOUND' || message === 'SESSION_NOT_FOUND') mapped = { status: 404, code: 'NOT_FOUND', message: 'El recurso solicitado no existe o no está disponible para esta cuenta.' };
    else if (message === 'INVALID_INPUT') mapped = { status: 400, code: 'INVALID_INPUT', message: 'Revisa los datos de la operación y vuelve a intentarlo.' };
    else if (message === 'UNKNOWN_ACTION') mapped = { status: 404, code: 'UNKNOWN_ACTION', message: 'Acción no reconocida.' };
    console.error('letters-api error', mapped.code);
    return jsonResponse(req, { ok: false, code: mapped.code, message: mapped.message }, mapped.status, headers);
  }
});
