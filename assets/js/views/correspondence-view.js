import { escapeHtml, sanitizeRichHtml } from '../utils/dom.js';
import { formatDate, greeting, relativeDate } from '../utils/format.js';

export function renderHome(view, state) {
    const stats = state.dashboard || {};
    const recent = [...new Map((stats.recent || []).filter(item => item?.id).map(item => [String(item.id), item])).values()].slice(0, 4);
    const recentMarkup = recent.length ? `<div class="letter-list">${recent.map(item => view.letterCard(item, true, state)).join('')}</div>` : view.emptyState('✉', 'Aún no hay cartas', 'La primera carta puede comenzar cuando quieras.', '<button class="btn btn-primary" data-route="write">Escribir la primera carta</button>');
    return `<section class="greeting-card"><div class="greeting-copy"><span class="eyebrow">Un pequeño espacio para dos</span><h2>${greeting()}, ${escapeHtml(state.user?.displayName || 'qué alegría verte')}.</h2><p>Las palabras bonitas no tienen prisa. Aquí siempre hay un lugar para ellas.</p></div><div class="greeting-art" aria-hidden="true"><span class="greeting-art-glow"></span><span class="greeting-art-paper"></span><span class="greeting-art-envelope"></span><span class="greeting-art-seal">N</span><span class="greeting-art-spark greeting-art-spark-one">✦</span><span class="greeting-art-spark greeting-art-spark-two">✧</span></div></section>
      <div class="stat-grid"><div class="stat-card"><span>Cartas recibidas</span><strong>${Number(stats.received || 0)}</strong></div><div class="stat-card"><span>Por leer</span><strong>${Number(stats.unread || 0)}</strong></div><div class="stat-card"><span>Cartas enviadas</span><strong>${Number(stats.sent || 0)}</strong></div><div class="stat-card"><span>Borradores</span><strong>${Number(stats.drafts || 0)}</strong></div></div>
      <div class="two-col"><section><div class="section-head"><h3>Las últimas palabras</h3><a href="#/inbox" data-route="inbox">Ver buzón →</a></div>${recentMarkup}</section><aside class="panel"><h3>Un gesto sencillo</h3><p class="muted" style="font-size:12px;line-height:1.8">No hace falta esperar una fecha especial para decir algo importante. A veces, una carta pequeña se convierte en un recuerdo enorme.</p><button class="btn btn-soft btn-block" data-route="write">✎ Escribir con calma</button><div class="section-head"><h3>Tu espacio</h3></div><div style="font:italic 16px/1.8 var(--serif);color:#8b6f63">“Hay cosas que solo se entienden bien cuando se leen despacio.”</div></aside></div>`;
}

export function letterCard(view, item, compact = false, state = {}) {
    const unread = Boolean(item.isUnread);
    const pending = state.pendingLetterActions?.has?.(item.id) === true;
    const title = escapeHtml(item.title || 'Sin título');
    const other = escapeHtml(item.otherName || (item.status === 'draft' ? 'Borrador personal' : 'Correspondencia'));
    const date = item.sent_at || item.updated_at || item.created_at;
    const badge = item.isInTrash ? 'En papelera' : item.status === 'draft' ? 'Borrador' : item.isArchived ? 'Archivada' : item.isFavorite ? 'Favorita' : 'Carta';
    const icon = item.isInTrash ? '⌫' : item.status === 'draft' ? '✎' : item.isArchived ? '⌑' : '✉';
    const main = `<button type="button" class="letter-card-main" data-action="open-letter" data-letter-id="${escapeHtml(item.id)}" aria-label="Abrir ${title}"><span class="letter-info"><strong>${title}</strong><small>${item.status === 'draft' ? 'Borrador personal' : other} · ${escapeHtml(relativeDate(date))}</small></span><span class="letter-meta"><time>${escapeHtml(formatDate(date, {time:false}))}</time>${unread ? '<span class="status-pill unread">Sin leer</span>' : compact ? '' : `<span class="status-pill">${badge}</span>`}</span></button>`;
    if (compact) return `<article class="letter-card compact"><div class="letter-stamp" aria-hidden="true">${icon}</div>${main}</article>`;
    let actions = '';
    if (item.isInTrash) {
      const purgePending = Boolean(item.purgeConfirmedAt);
      actions = `${purgePending ? '<span class="purge-awaiting" role="status">✓ Tu confirmación está guardada; falta la otra persona</span>' : ''}<button type="button" class="btn btn-soft btn-small" data-action="restore-letter" data-letter-id="${escapeHtml(item.id)}" ${pending ? 'disabled aria-busy="true"' : ''}>↶ Recuperar</button><button type="button" class="btn ${purgePending ? 'btn-soft' : 'btn-danger'} btn-small" data-action="purge-letter" data-letter-id="${escapeHtml(item.id)}" ${purgePending || pending ? 'disabled aria-disabled="true"' : ''}>${purgePending ? 'Esperando confirmación' : pending ? 'Procesando…' : 'Eliminar definitivamente'}</button>`;
    } else if (item.status === 'draft') {
      actions = `<button type="button" class="btn btn-soft btn-small" data-action="edit-draft" data-letter-id="${escapeHtml(item.id)}" ${pending ? 'disabled aria-busy="true"' : ''}>Seguir escribiendo</button><button type="button" class="btn btn-danger btn-small" data-action="trash-letter" data-letter-id="${escapeHtml(item.id)}" data-letter-status="${escapeHtml(item.status)}" ${pending ? 'disabled aria-busy="true"' : ''}>Descartar</button>`;
    } else {
      actions = `<button type="button" class="btn btn-soft btn-small" data-action="toggle-favorite" data-favorite="${Boolean(item.isFavorite)}" data-letter-id="${escapeHtml(item.id)}" ${pending ? 'disabled aria-busy="true"' : ''}>${item.isFavorite ? '♥ Favorita' : '♡ Favorito'}</button><button type="button" class="btn btn-soft btn-small" data-action="toggle-archive" data-archived="${Boolean(item.isArchived)}" data-letter-id="${escapeHtml(item.id)}" ${pending ? 'disabled aria-busy="true"' : ''}>${item.isArchived ? '↶ Desarchivar' : '⌑ Archivar'}</button><button type="button" class="btn btn-danger btn-small" data-action="trash-letter" data-letter-id="${escapeHtml(item.id)}" data-letter-status="${escapeHtml(item.status)}" ${pending ? 'disabled aria-busy="true"' : ''}>Descartar</button>`;
    }
    return `<article class="letter-card ${item.isInTrash ? 'in-trash' : ''}"><div class="letter-stamp" aria-hidden="true">${icon}</div>${main}<div class="letter-card-actions">${actions}</div></article>`;
}

export function emptyState(view, icon, title, description, action = '') {
    return `<div class="empty-state"><div class="empty-icon" aria-hidden="true">${icon}</div><strong>${title}</strong><p>${description}</p>${action}</div>`;
}

export function renderPagination(view, pagination, action, noun) {
    if (!pagination || (!pagination.hasMore && !pagination.loading)) return '';
    const loaded = Number(pagination.loadedCount || 0);
    const label = pagination.loading ? 'Cargando…' : `Cargar más ${noun}`;
    return `<div class="pagination-footer" data-pagination-sentinel><span class="pagination-status">${loaded} cargadas</span><button class="btn btn-ghost btn-small" type="button" data-action="${action}" ${pagination.loading ? 'disabled aria-busy="true"' : ''}>${label}</button></div>`;
}

export function renderList(view, state) {
    const names = {
      inbox: ['Mi buzón', 'Las cartas que te han escrito'],
      sent: ['Cartas enviadas', 'Las palabras que ya compartiste'],
      drafts: ['Borradores', 'Cartas que aún están tomando forma'],
      favorites: ['Favoritos', 'Tus cartas más especiales'],
      archive: ['Archivo', 'Correspondencia que decidiste conservar'],
      trash: ['Papelera', 'Cartas descartadas; puedes recuperarlas o eliminarlas']
    };
    const [title, subtitle] = names[state.route] || names.inbox;
    const items = [...new Map((state.letters || []).filter(item => item?.id).map(item => [String(item.id), item])).values()];
    const folderCopy = {
      drafts: ['✎', 'Todavía en preparación', 'Las cartas de aquí no se han enviado. Puedes continuar editándolas.'],
      archive: ['⌑', 'Guardadas aparte', 'Archivar oculta una carta de las bandejas principales, pero no la elimina.'],
      trash: ['⌫', 'Elementos descartados', 'Recupera una carta para devolverla a su sección o elimínala definitivamente.']
    }[state.route];
    const context = folderCopy ? `<aside class="folder-context folder-${state.route}"><span class="folder-context-icon">${folderCopy[0]}</span><div><strong>${folderCopy[1]}</strong><p>${folderCopy[2]}</p></div></aside>` : '';
    const empty = state.route === 'trash'
      ? view.emptyState('⌫', 'La papelera está vacía', 'Las cartas que descartes aparecerán aquí antes de su eliminación definitiva.')
      : state.route === 'archive'
        ? view.emptyState('⌑', 'Todavía no has archivado cartas', 'Usa la opción “Archivar” en una carta enviada o recibida para guardarla aquí.')
        : state.route === 'drafts'
          ? view.emptyState('✎', 'Todavía no hay borradores', 'Al guardar una carta como borrador, aparecerá aquí para que puedas continuar escribiéndola.', '<button class="btn btn-primary" data-route="write">Escribir carta</button>')
          : view.emptyState('✉', 'Todavía no hay cartas aquí', 'Cuando haya correspondencia en esta sección, la encontrarás aquí.');
    const cards = items.length ? `<div class="letter-list">${items.map(item => view.letterCard(item, false, state)).join('')}</div>` : empty;
    const pagination = view.renderPagination(state.pagination, 'load-more-letters', 'cartas');
    return `<div class="page-heading"><div><span class="eyebrow">Correspondencia</span><h2>${title}</h2><p>${subtitle}</p></div>${state.route === 'trash' ? '' : '<button class="btn btn-primary" data-route="write">＋ Escribir carta</button>'}</div>${context}<div class="search-row"><input id="letter-search" type="search" value="${escapeHtml(state.search)}" placeholder="Buscar por título o contenido…" aria-label="Buscar cartas"></div>${cards}${pagination}`;
}

export function renderEditor(view, state) {
    const editor = state.editor || {};
    const title = escapeHtml(editor.title || '');
    const body = sanitizeRichHtml(editor.body || '');
    const status = editor.saving ? 'Guardando…' : editor.saved ? 'Guardado' : 'Se guardará automáticamente';
    return `<div class="page-heading"><div><span class="eyebrow">Una página en blanco</span><h2>${editor.letterId ? 'Continuar borrador' : 'Escribe algo bonito'}</h2><p>Escribe sin prisa. Tu borrador se guarda automáticamente.</p></div><button class="btn btn-ghost" data-action="cancel-editor">← Volver</button></div>
      <section class="editor-shell"><div class="editor-top"><span class="editor-overline">PARA TU PERSONA FAVORITA</span><strong id="save-status" class="editor-save-status">${status}</strong></div><div class="editor-title-field"><label for="editor-title">Asunto de tu carta</label><input id="editor-title" class="editor-input" maxlength="180" placeholder="Ponle un título especial…" value="${title}" aria-label="Título de la carta"></div><div class="editor-toolbar" role="toolbar" aria-label="Formato del texto"><div class="editor-toolbar-group"><button type="button" class="tool-btn" data-action="format-bold" title="Negrita" aria-label="Negrita"><b>B</b></button><button type="button" class="tool-btn" data-action="format-italic" title="Cursiva" aria-label="Cursiva"><i>I</i></button><button type="button" class="tool-btn" data-action="format-underline" title="Subrayado" aria-label="Subrayado"><u>U</u></button></div><span class="editor-toolbar-divider" aria-hidden="true"></span><div class="editor-toolbar-group"><button type="button" class="tool-btn" data-action="format-left" title="Alinear a la izquierda" aria-label="Alinear a la izquierda">☰</button><button type="button" class="tool-btn" data-action="format-center" title="Centrar" aria-label="Centrar">≡</button><button type="button" class="tool-btn" data-action="format-right" title="Alinear a la derecha" aria-label="Alinear a la derecha">☷</button></div><span class="editor-toolbar-hint">Formato sencillo</span></div><div class="editor-writing-surface"><div class="editor-writing-heading"><span id="letter-body-label">Tu carta</span><small>Escribe con calma</small></div><div id="letter-editor" class="letter-editor" contenteditable="true" role="textbox" aria-labelledby="letter-body-label" aria-describedby="letter-body-help" aria-multiline="true" data-placeholder="Querida…

Hoy quería escribirte porque…">${body}</div><span id="letter-body-help" class="sr-only">Área de edición de texto. Puedes utilizar los botones de formato y escribir o pegar el contenido de tu carta.</span></div><div class="editor-footer"><small>Se sincroniza automáticamente y mantiene una copia local de respaldo.</small><div class="btn-group"><button class="btn btn-soft" type="button" data-action="save-draft">Guardar borrador</button><button class="btn btn-primary" type="button" data-action="preview-send">Revisar y enviar →</button></div></div></section>`;
}

export function renderLetter(view, state) {
    return `<div id="letter-detail-content" class="letter-route-content">${view.renderLetterContent(state)}</div>`;
}

export function renderLetterDetail(view, state) {
    const container = view.root.querySelector('#letter-detail-content');
    if (!container) return false;
    container.innerHTML = view.renderLetterContent(state);
    return true;
}

export function renderLetterContent(view, state) {
    const data = state.selectedLetter;
    if (!data) return view.emptyState('✉', 'No encontramos esta carta', 'Puede que ya no esté disponible.');
    const letter = data.letter;
    const isDraft = letter.status === 'draft';
    const senderName = escapeHtml(letter.senderName || 'Remitente');
    const recipientName = escapeHtml(letter.recipientName || 'Destinatario');
    const deliveryStatus = isDraft ? 'Borrador privado'
      : letter.readByRecipientAt ? `Leída el ${formatDate(letter.readByRecipientAt)}`
      : letter.sender_id === state.user?.id ? 'Entregada · pendiente de lectura'
      : 'Recibida · pendiente de lectura';
    const purgePending = Boolean(letter.purgeConfirmedAt);
    const purgeNotice = letter.isInTrash && purgePending
      ? '<p class="purge-awaiting" role="status">✓ Tu confirmación ya está registrada. La carta permanecerá en Papelera hasta que la otra persona confirme.</p>'
      : letter.isInTrash
        ? '<p class="purge-guidance">La eliminación de una carta compartida se completa cuando ambas personas la confirman. Hasta entonces puedes recuperarla desde aquí.</p>'
        : '';
    const pending = state.pendingLetterActions?.has?.(letter.id) === true;
    const actions = letter.isInTrash
      ? `<button class="btn btn-primary" data-action="restore-letter" data-letter-id="${escapeHtml(letter.id)}" ${pending ? 'disabled aria-busy="true"' : ''}>↶ Recuperar carta</button><button class="btn ${purgePending ? 'btn-soft' : 'btn-danger'}" data-action="purge-letter" data-letter-id="${escapeHtml(letter.id)}" ${purgePending || pending ? 'disabled aria-disabled="true"' : ''}>${purgePending ? 'Esperando a la otra persona' : pending ? 'Procesando…' : 'Confirmar eliminación definitiva'}</button>`
      : isDraft
        ? `<button class="btn btn-soft" data-action="edit-draft" data-letter-id="${escapeHtml(letter.id)}" ${pending ? 'disabled aria-busy="true"' : ''}>Seguir escribiendo</button><button class="btn btn-primary" data-action="preview-send-draft" data-letter-id="${escapeHtml(letter.id)}" ${pending ? 'disabled aria-busy="true"' : ''}>Revisar y enviar</button><button class="btn btn-danger" data-action="trash-letter" data-letter-id="${escapeHtml(letter.id)}" data-letter-status="${escapeHtml(letter.status)}" ${pending ? 'disabled aria-busy="true"' : ''}>Descartar</button>`
        : `<button class="btn btn-soft" data-action="toggle-favorite" data-favorite="${Boolean(letter.isFavorite)}" data-letter-id="${escapeHtml(letter.id)}" ${pending ? 'disabled aria-busy="true"' : ''}>${letter.isFavorite ? '♥ Quitar favorito' : '♡ Guardar favorito'}</button><button class="btn btn-soft" data-action="toggle-archive" data-archived="${Boolean(letter.isArchived)}" data-letter-id="${escapeHtml(letter.id)}" ${pending ? 'disabled aria-busy="true"' : ''}>${letter.isArchived ? '↶ Quitar del archivo' : '⌑ Archivar'}</button><button class="btn btn-soft" data-action="download-txt" data-letter-id="${escapeHtml(letter.id)}">↓ Descargar TXT</button><button class="btn btn-soft" data-action="download-html" data-letter-id="${escapeHtml(letter.id)}">↓ Descargar HTML</button><button class="btn btn-soft" data-action="print-letter">▤ Guardar como PDF</button><button class="btn btn-danger" data-action="trash-letter" data-letter-id="${escapeHtml(letter.id)}" data-letter-status="${escapeHtml(letter.status)}" ${pending ? 'disabled aria-busy="true"' : ''}>Descartar</button>`;
    const threadItems = [...new Map((data.thread || []).filter(item => item?.id).map(item => [String(item.id), item])).values()];
    const renderThreadItem = item => {
      const active = String(item.id) === String(letter.id);
      return `<article class="conversation-item ${active ? 'is-active' : ''}" data-thread-letter="${escapeHtml(item.id)}"><div class="conversation-head"><span>${escapeHtml(item.senderName || 'Remitente')} → ${escapeHtml(item.recipientName || 'Destinatario')}</span><time>${escapeHtml(formatDate(item.sent_at || item.created_at))}</time></div><h3>${escapeHtml(item.title || 'Sin título')}</h3><div class="letter-body">${fmtBody(item.body)}</div><div class="letter-actions no-print"><button class="btn btn-ghost btn-small conversation-open-button" data-action="open-letter" data-letter-id="${escapeHtml(item.id)}" ${active ? 'disabled aria-current="page"' : ''}>${active ? 'Carta abierta' : 'Abrir carta'}</button></div></article>`;
    };
    const threadBoundary = Math.min(threadItems.length, Math.max(0, Number(data.threadLoadedOlderCount || 0)));
    const olderTimeline = threadItems.slice(0, threadBoundary).map(renderThreadItem).join('');
    const newerTimeline = threadItems.slice(threadBoundary).map(renderThreadItem).join('');
    const paper = `<article class="letter-paper" id="printable-letter"><div class="letter-paper-inner"><span class="eyebrow">${isDraft ? 'Borrador privado' : 'Correspondencia personal'}</span><h2>${escapeHtml(letter.title || 'Sin título')}</h2><div class="letter-byline"><span>De: ${senderName}</span><span>Para: ${recipientName}</span><span>${escapeHtml(formatDate(letter.sent_at || letter.created_at))}</span>${!isDraft ? `<span class="delivery-status">${escapeHtml(deliveryStatus)}</span>` : ''}</div><div class="letter-body">${fmtBody(letter.body)}</div><p class="letter-signature">Con cariño, ${senderName}</p></div></article>`;
    const threadCount = threadItems.length;
    const threadPager = data.threadHasMore
      ? `<div class="thread-pagination" data-pagination-sentinel><button class="btn btn-ghost btn-small" type="button" data-action="load-older-thread" ${data.threadLoading ? 'disabled aria-busy="true"' : ''}>${data.threadLoading ? 'Cargando cartas anteriores…' : '↑ Cargar cartas anteriores'}</button><span>${threadCount} cargadas</span></div>`
      : '';
    return `<div class="page-heading"><div><span class="eyebrow">${isDraft ? 'En preparación' : 'Una carta recibida o enviada'}</span><h2>${escapeHtml(letter.title || 'Sin título')}</h2><p>${isDraft ? 'Este borrador solo tú puedes verlo.' : `${senderName} · ${escapeHtml(formatDate(letter.sent_at))} · ${escapeHtml(deliveryStatus)}`}</p></div><button class="btn btn-ghost" data-action="back-to-list">← Volver</button></div>${paper}${purgeNotice}<div class="letter-actions">${actions}${!isDraft && !letter.isInTrash ? `<button class="btn btn-primary" data-action="reply-letter" data-letter-id="${escapeHtml(letter.id)}">↩ Responder</button>` : ''}</div>${threadItems.length > 1 || data.threadHasMore ? `<section class="panel conversation-panel"><div class="section-head conversation-section-head"><div><span class="eyebrow">Hilo completo</span><h3>Esta correspondencia</h3></div><span class="conversation-count">${threadCount} ${threadCount === 1 ? 'carta' : 'cartas'}</span></div><div class="conversation-list">${olderTimeline}${threadPager}${newerTimeline}</div></section>` : ''}`;
}

export function renderNotifications(view, state) {
    const items = state.notifications || [];
    const markup = items.length ? `<div class="notification-list">${items.map(item => `<article class="notification-item ${item.read_at ? '' : 'unread'}"><div class="letter-stamp">${item.notification_type?.includes('reply') ? '↩' : '✉'}</div><div style="flex:1;min-width:0"><p>${escapeHtml(item.message || 'Tienes una novedad en tu correspondencia.')}</p><small>${escapeHtml(formatDate(item.created_at))}</small></div>${item.read_at ? '' : `<button class="btn btn-ghost" data-action="read-notification" data-notification-id="${escapeHtml(item.id)}">Marcar leída</button>`}</article>`).join('')}</div>` : view.emptyState('♧', 'Todo está en calma', 'Cuando llegue una carta o una respuesta, aparecerá aquí.');
    const pagination = view.renderPagination(state.notificationPagination, 'load-more-notifications', 'notificaciones');
    return `<div class="page-heading"><div><span class="eyebrow">Avisos del buzón</span><h2>Notificaciones</h2><p>Solo las novedades de tu correspondencia.</p></div></div>${markup}${pagination}`;
}
