import {
  corsHeaders, dbRequest, errorStatus, jsonResponse, nowIso, patchRows,
  readJson, requireSession, rpc, sanitizeRichHtml, selectOne, selectRows
} from '../_shared/core.ts';

const LETTER_FIELDS = 'id,thread_id,sender_id,recipient_id,reply_to_letter_id,title,body,status,revision,created_at,updated_at,sent_at,content_purged_at,creation_request_id';

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
    read_at: state?.read_at || null,
    readByRecipientAt: recipientState?.read_at ? String(recipientState.read_at) : null,
    isUnread: row.status === 'sent' && row.recipient_id === state?.user_id && !state?.read_at
  };
}

async function fetchLetterList(userId: string, folder: string, search: string) {
  let rows: Record<string, unknown>[] = [];
  if (folder === 'drafts') {
    rows = await selectRows('letters', { select: LETTER_FIELDS, status: 'eq.draft', sender_id: `eq.${userId}`, order: 'updated_at.desc', limit: '100' });
  } else if (folder === 'inbox') {
    rows = await selectRows('letters', { select: LETTER_FIELDS, status: 'eq.sent', recipient_id: `eq.${userId}`, content_purged_at: 'is.null', order: 'sent_at.desc', limit: '100' });
  } else if (folder === 'sent') {
    rows = await selectRows('letters', { select: LETTER_FIELDS, status: 'eq.sent', sender_id: `eq.${userId}`, content_purged_at: 'is.null', order: 'sent_at.desc', limit: '100' });
  } else {
    const filters: Record<string,string> = { select: 'letter_id', user_id: `eq.${userId}`, order: 'updated_at.desc', limit: '100' };
    if (folder === 'favorites') filters.is_favorite = 'eq.true';
    if (folder === 'archive') filters.archived_at = 'not.is.null';
    if (folder === 'trash') filters.trashed_at = 'not.is.null';
    const stateRows = await selectRows<Record<string,unknown>>('letter_user_state', filters);
    const ids = stateRows.map(row => String(row.letter_id));
    if (!ids.length) return [];
    rows = await selectRows('letters', { select: LETTER_FIELDS, id: `in.(${ids.join(',')})`, content_purged_at: 'is.null', order: 'updated_at.desc', limit: '100' });
  }
  if (!rows.length) return [];
  const [states, recipientStates, names] = await Promise.all([
    statesFor(userId, rows.map(row => String(row.id))),
    recipientStatesFor(rows),
    getNames(rows.flatMap(row => [String(row.sender_id), row.recipient_id ? String(row.recipient_id) : '']))
  ]);
  let result = rows.map(row => decorate(row, states.get(String(row.id)), names, recipientStates.get(String(row.id))));
  if (folder !== 'trash') result = result.filter(row => !row.isInTrash);
  // Archivar es una acción privada por usuario: oculta la carta de las listas
  // principales, pero la mantiene accesible desde Archivo y Favoritos.
  if (folder === 'inbox' || folder === 'sent') result = result.filter(row => !row.isArchived);
  if (search.trim()) {
    const needle = search.trim().toLocaleLowerCase('es-CO');
    result = result.filter(row => `${row.title || ''} ${stripTags(String(row.body || ''))}`.toLocaleLowerCase('es-CO').includes(needle));
  }
  if (folder === 'inbox') result.sort((a,b) => Number(Boolean(b.isUnread)) - Number(Boolean(a.isUnread)) || new Date(String(b.sent_at || 0)).getTime() - new Date(String(a.sent_at || 0)).getTime());
  return result;
}

function stripTags(html: string) { return html.replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' '); }

async function checkedLetter(letterId: string, userId: string) {
  if (!/^[0-9a-f-]{36}$/i.test(letterId)) throw new Error('LETTER_NOT_FOUND');
  const letter = await selectOne<Record<string,unknown>>('letters', { select: LETTER_FIELDS, id: `eq.${letterId}` });
  if (!letter || ![letter.sender_id, letter.recipient_id].includes(userId) || letter.content_purged_at) throw new Error('LETTER_NOT_FOUND');
  if (letter.status === 'draft' && letter.sender_id !== userId) throw new Error('LETTER_NOT_FOUND');
  return letter;
}

async function getLetterBundle(letterId: string, userId: string) {
  const current = await checkedLetter(letterId, userId);
  let threadRows: Record<string,unknown>[] = [];
  if (current.status === 'sent') {
    threadRows = await selectRows('letters', { select: LETTER_FIELDS, thread_id: `eq.${current.thread_id}`, status: 'eq.sent', content_purged_at: 'is.null', order: 'sent_at.asc', limit: '100' });
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
  const letter = decorated.find(row => row.id === current.id) || decorate(current, states.get(String(current.id)), names, recipientStates.get(String(current.id)));
  return { letter, thread: decorated };
}

async function handleAction(action: string, body: Record<string, unknown>, session: Awaited<ReturnType<typeof requireSession>>) {
  const userId = session.userId;
  switch (action) {
    case 'dashboard': {
      const [inbox, sent, drafts] = await Promise.all([
        fetchLetterList(userId, 'inbox', ''), fetchLetterList(userId, 'sent', ''), fetchLetterList(userId, 'drafts', '')
      ]);
      const recent = [...inbox, ...sent].sort((a,b) => new Date(String(b.sent_at || b.updated_at)).getTime() - new Date(String(a.sent_at || a.updated_at)).getTime()).slice(0, 5);
      return { received: inbox.length, unread: inbox.filter(item => item.isUnread).length, sent: sent.length, drafts: drafts.length, recent };
    }
    case 'list': {
      const folder = String(body.folder || 'inbox');
      if (!['inbox','sent','drafts','favorites','archive','trash'].includes(folder)) throw new Error('INVALID_INPUT');
      return { items: await fetchLetterList(userId, folder, String(body.search || '').slice(0, 120)) };
    }
    case 'get': return getLetterBundle(String(body.letterId || ''), userId);
    case 'draft:create': {
      const title = String(body.title || '').slice(0, 180);
      const html = sanitizeRichHtml(body.body);
      // Un borrador puede estar vacío mientras la persona empieza a escribir;
      // el envío sí exige contenido no vacío en send_letter_draft.
      const data = await rpc<Record<string,unknown>>('create_letter_draft', {
        p_sender_id: userId, p_creation_request_id: String(body.creationRequestId || crypto.randomUUID()), p_title: title, p_body: html
      });
      if (data?.draft?.id) {
        const state = await selectOne<Record<string, unknown>>('letter_user_state', {
          select: 'trashed_at', letter_id: `eq.${data.draft.id}`, user_id: `eq.${userId}`
        });
        if (state?.trashed_at) return { status: 'discarded', draft: data.draft };
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
      const items = await selectRows<Record<string,unknown>>('notifications', { select: 'id,user_id,letter_id,actor_user_id,notification_type,created_at,read_at,metadata', user_id: `eq.${userId}`, order: 'created_at.desc', limit: '50' });
      const [names, letters] = await Promise.all([
        getNames(items.map(item => String(item.actor_user_id || ''))),
        items.length ? selectRows<Record<string,unknown>>('letters', { select: 'id,title', id: `in.(${items.map(item => String(item.letter_id)).join(',')})` }) : Promise.resolve([])
      ]);
      const titleMap = new Map(letters.map(row => [String(row.id), String(row.title || 'una carta')]));
      return { items: items.map(item => {
        const actor = names.get(String(item.actor_user_id)) || 'Alguien';
        const verb = item.notification_type === 'letter_reply_received'
          ? 'respondió a tu carta'
          : item.notification_type === 'letter_read' ? 'leyó tu carta' : 'te escribió una carta';
        return { ...item, message: `${actor} ${verb}: “${titleMap.get(String(item.letter_id)) || 'una carta'}”` };
      }) };
    }
    case 'notification:read': {
      const id = String(body.notificationId || '');
      if (!/^[0-9a-f-]{36}$/i.test(id)) throw new Error('INVALID_INPUT');
      await patchRows('notifications', { id: `eq.${id}`, user_id: `eq.${userId}`, read_at: 'is.null' }, { read_at: nowIso() });
      return { status: 'read' };
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
      const updatedAt = nowIso();
      await Promise.all([
        patchRows('app_users', { id: `eq.${userId}` }, { display_name: displayName, updated_at: updatedAt }),
        patchRows('user_profiles', { user_id: `eq.${userId}` }, { display_name: displayName, updated_at: updatedAt })
      ]);
      const user = await selectOne<Record<string,unknown>>('app_users', { select: 'id,username,email,display_name,status', id: `eq.${userId}` });
      return { user: { id: user?.id, username: user?.username, email: user?.email, displayName: user?.display_name } };
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
    const result = await handleAction(String(body.action || ''), body, session);
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
