import { getLocalDraft, putLocalDraft, deleteLocalDraft } from '../services/local-drafts.js';
import { plainTextFromHtml, sanitizeRichHtml, showToast, escapeHtml, beginActionToast } from '../utils/dom.js';
import { renderLetterBodyHtml, bindLetterImageLoading } from '../utils/letter-images.js';
import { formatDate } from '../utils/format.js';

export class LetterController {
    cacheLetterThread(data) {
      const thread = Array.isArray(data?.thread) ? data.thread : [];
      const threadId = data?.letter?.thread_id;
      if (!threadId || !thread.length) return;
      const key = `${this.session?.user?.id || 'guest'}:${threadId}`;
      this.letterThreadCache.set(key, thread);
      if (this.letterThreadCache.size > 20) this.letterThreadCache.delete(this.letterThreadCache.keys().next().value);
    }

    markThreadReadInBackground(data) {
      const letter = data?.letter;
      const userId = this.session?.user?.id;
      if (!letter || letter.status !== 'sent' || letter.recipient_id !== userId || letter.read_at || letter.readByRecipientAt) return;
  
      const readAt = new Date().toISOString();
      letter.read_at = readAt;
      letter.readByRecipientAt = readAt;
      letter.isUnread = false;
      for (const item of data.thread || []) {
        if (item.recipient_id === userId && !item.read_at) {
          item.read_at = readAt;
          item.readByRecipientAt = readAt;
          item.isUnread = false;
        }
      }
      if (this.state.route === 'letter' && this.state.selectedLetter?.letter?.id === letter.id) {
        this.renderCurrentRoute();
      }
  
      // La lectura se confirma fuera del camino de navegación: no bloquea el
      // cambio entre cartas ni reconstruye el contenedor principal.
      this.repository.markRead(letter.thread_id).then(async () => {
        this.invalidateRouteCache();
        try {
          this.state.dashboard = await this.repository.dashboard();
          if (this.state.route !== 'letter') this.render();
        } catch { /* El contador se actualizará en la próxima sincronización. */ }
      }).catch(() => {
        // La próxima lectura remota reflejará el estado real si falla esta escritura.
      });
    }

    snapshotLetterState() {
      const selected = this.state.selectedLetter;
      return {
        letters: (this.state.letters || []).map(item => ({ ...item })),
        selectedLetter: selected ? {
          ...selected,
          letter: selected.letter ? { ...selected.letter } : null,
          thread: (selected.thread || []).map(item => ({ ...item }))
        } : null,
        dashboard: this.state.dashboard ? { ...this.state.dashboard, recent: (this.state.dashboard.recent || []).map(item => ({ ...item })) } : this.state.dashboard,
        route: this.state.route
      };
    }

    restoreLetterState(snapshot) {
      this.state.letters = snapshot.letters;
      this.state.selectedLetter = snapshot.selectedLetter;
      this.state.dashboard = snapshot.dashboard;
      this.state.route = snapshot.route;
      history.replaceState(null, '', `#/${snapshot.route}`);
      this.renderCurrentRoute();
    }

    patchLetterState(letterId, patch, { removeFromList = false } = {}) {
      this.state.letters = (this.state.letters || []).map(item => String(item.id) === String(letterId) ? { ...item, ...patch } : item);
      if (removeFromList) this.state.letters = this.state.letters.filter(item => String(item.id) !== String(letterId));
      const selected = this.state.selectedLetter;
      if (selected?.letter?.id === letterId) {
        this.state.selectedLetter = {
          ...selected,
          letter: { ...selected.letter, ...patch },
          thread: (selected.thread || []).map(item => item.id === letterId ? { ...item, ...patch } : item)
        };
      } else if (selected?.thread?.some(item => item.id === letterId)) {
        this.state.selectedLetter = { ...selected, thread: selected.thread.map(item => item.id === letterId ? { ...item, ...patch } : item) };
      }
    }

    async openLetter(letterId, updateHash = true, initialLetter = null, options = {}) {
      const targetId = String(letterId || '');
      if (!targetId) return;
  
      const wasAlreadyInLetter = this.state.route === 'letter';
      const currentBundle = this.state.selectedLetter;
      const currentThread = Array.isArray(currentBundle?.thread) ? currentBundle.thread : [];
      const cachedItem = wasAlreadyInLetter
        ? currentThread.find(item => String(item?.id) === targetId)
        : null;
      const sameThread = Boolean(cachedItem && currentBundle?.letter?.thread_id
        && String(cachedItem.thread_id) === String(currentBundle.letter.thread_id));
      if (!sameThread && !options.skipHistory) this.rememberCurrentPage?.();
  
      const requestId = ++this.routeRequestId;
      this.previousListRoute = ['inbox','sent','drafts','favorites','archive','trash'].includes(this.state.route) ? this.state.route : this.previousListRoute;
      this.state.route = 'letter';
      this.state.mobileNavOpen = false;
      this.state.routeError = null;
      this.state.routeNotice = null;
      if (updateHash && location.hash !== '#/letter') history.replaceState(null, '', '#/letter');
  
      // Al navegar entre cartas que ya forman parte de la conversación, el
      // contenido completo está en memoria: cambia el papel activo y conserva
      // la lista, el scroll y el resto de la aplicación sin volver a consultar.
      if (sameThread) {
        this.state.selectedLetter = { ...currentBundle, letter: cachedItem, thread: currentThread };
        this.state.routeLoading = false;
        if (!this.view.renderLetterDetail(this.state)) this.render();
        this.markThreadReadInBackground(this.state.selectedLetter);
        this.focusPageHeading?.();
        return;
      }
  
      const userId = this.session?.user?.id || 'guest';
      const cachedThreadKey = initialLetter?.thread_id ? `${userId}:${initialLetter.thread_id}` : null;
      const rememberedThread = cachedThreadKey ? this.letterThreadCache.get(cachedThreadKey) : null;
  
      if (initialLetter && String(initialLetter.id) === targetId) {
        this.state.selectedLetter = {
          letter: initialLetter,
          thread: rememberedThread || (wasAlreadyInLetter ? currentThread : [initialLetter])
        };
        this.state.routeLoading = false;
        if (wasAlreadyInLetter && this.view.renderLetterDetail(this.state)) {
          // Mantiene el shell si la navegación procede de otra carta.
        } else {
          this.render();
        }
      } else {
        this.state.selectedLetter = null;
        this.state.routeLoading = true;
        this.render();
      }
  
      try {
        const data = await this.repository.get(targetId);
        if (requestId !== this.routeRequestId || this.state.route !== 'letter') return;
        this.state.selectedLetter = data;
        this.cacheLetterThread(data);
        this.state.routeLoading = false;
        if (wasAlreadyInLetter && this.view.renderLetterDetail(this.state)) {
          // Solo se actualiza el detalle; el encabezado, la navegación y la
          // posición del documento permanecen intactos.
        } else {
          this.render();
        }
        this.markThreadReadInBackground(data);
        this.focusPageHeading?.();
      } catch (error) {
        if (requestId !== this.routeRequestId || this.state.route !== 'letter') return;
        if (this.state.selectedLetter) {
          this.state.routeNotice = 'No pudimos actualizar la conversación completa. Puedes seguir leyendo la carta y volver a intentarlo.';
          this.state.routeLoading = false;
          this.renderCurrentRoute();
        } else {
          this.state.routeLoading = false;
          this.state.routeError = error.message || 'No se pudo abrir esta carta.';
          this.render();
        }
        if (error.status === 401) this.forceLogout();
        else this.focusPageHeading?.();
      }
    }

    async openLetterForSend(letterId) {
      const data = await this.repository.get(letterId);
      if (data.letter.status !== 'draft') throw new Error('Esta carta ya no es un borrador.');
      this.rememberCurrentPage?.();
      this.localDraftKey = this.localDraftKeyFor(`letter:${letterId}`);
      const local = await getLocalDraft(this.localDraftKey);
      const localIsNewer = Boolean(local?.savedAt
        && new Date(local.savedAt).getTime() > new Date(data.letter.updated_at || data.letter.created_at).getTime());
      this.state.editor = {
        letterId,
        creationRequestId: local?.creationRequestId || null,
        title: localIsNewer ? (local.title || '') : (data.letter.title || ''),
        body: localIsNewer ? (local.body || '') : (data.letter.body || ''),
        revision: data.letter.revision,
        parentLetterId: null,
        saving: false,
        saved: !localIsNewer,
        localOnly: localIsNewer,
        pendingSync: localIsNewer
      };
      // No se navega a Escribir carta: el botón de revisión abre directamente
      // el modal sobre Borradores. Al cerrar, el foco regresa a la tarjeta.
      this.routeRequestId++;
      this.state.routeLoading = false;
      await this.previewSend();
    }

    async editLocalDraft(storageKey = '') {
      const key = storageKey || this.state.localDraftPreview?.localDraftKey || this.localDraftKeyFor('new');
      const local = await getLocalDraft(key);
      const fallback = this.state.localDraftPreview?.localDraftKey === key ? this.state.localDraftPreview : null;
      const draft = local || fallback;
      if (!draft) throw new Error('No encontramos la copia local del borrador. Actualiza la lista e inténtalo de nuevo.');
      this.rememberCurrentPage?.();
      this.localDraftKey = key;
      this.state.editor = {
        ...draft,
        letterId: draft.letterId || null,
        creationRequestId: draft.creationRequestId || crypto.randomUUID(),
        parentLetterId: draft.parentLetterId || null,
        saving: false, saved: Boolean(draft.saved),
        localOnly: !draft.letterId || Boolean(draft.localOnly),
        pendingSync: !draft.letterId || Boolean(draft.pendingSync)
      };
      this.routeRequestId++;
      this.state.routeLoading = false;
      this.state.route = 'write';
      history.replaceState(null, '', '#/write');
      this.render();
      if (this.state.editor.pendingSync || this.state.editor.localOnly) this.saveDraft(true).catch(() => {});
    }

    async editDraft(letterId) {
      const data = await this.repository.get(letterId);
      if (data.letter.status !== 'draft') throw new Error('Esta carta ya no es un borrador.');
      this.localDraftKey = this.localDraftKeyFor(`letter:${letterId}`);
      const local = await getLocalDraft(this.localDraftKey);
      const localIsNewer = Boolean(local?.savedAt && new Date(local.savedAt).getTime() > new Date(data.letter.updated_at || data.letter.created_at).getTime());
      this.state.editor = { letterId, creationRequestId: local?.creationRequestId || null, title: localIsNewer ? (local.title || '') : (data.letter.title || ''), body: localIsNewer ? (local.body || '') : (data.letter.body || ''), revision: data.letter.revision, parentLetterId: null, saving: false, saved: !localIsNewer, localOnly: localIsNewer, pendingSync: localIsNewer };
      this.routeRequestId++;
      this.state.routeLoading = false;
      this.state.route = 'write';
      history.replaceState(null, '', '#/write');
      this.render();
      if (localIsNewer) this.saveDraft(true).catch(() => {});
    }

    async startReply(letterId) {
      const data = await this.repository.get(letterId);
      this.rememberCurrentPage?.();
      this.localDraftKey = this.localDraftKeyFor(`reply:${letterId}:${crypto.randomUUID()}`);
      this.state.editor = { letterId: null, creationRequestId: crypto.randomUUID(), title: `Re: ${data.letter.title || 'Tu carta'}`.slice(0,180), body: '', revision: 1, parentLetterId: letterId, saving: false, saved: false };
      // Cada nueva acción «Responder» abre una respuesta vacía. Los borradores
      // anteriores solo se reanudan desde la sección Borradores.
      this.routeRequestId++;
      this.state.routeLoading = false;
      this.state.route = 'write';
      history.replaceState(null, '', '#/write');
      this.render();
    }

    execFormat(command) {
      const editor = this.root.querySelector('#letter-editor');
      if (!editor) return;
      editor.focus();
      document.execCommand(command, false, null);
      this.onInput({ target: editor });
    }

    async previewSend() {
      if (!navigator.onLine) throw new Error('Necesitas conexión para enviar. El borrador permanece guardado en este dispositivo.');
      await this.saveDraft(true);
      const editor = this.state.editor;
      if (!editor?.parentLetterId && (!editor?.letterId || editor.localOnly || editor.conflict)) throw new Error('No se pudo sincronizar el borrador con el servidor. Se conserva la copia local; vuelve a intentarlo antes de enviar.');
      if (!plainTextFromHtml(editor?.body || '').trim()) throw new Error('Escribe el contenido de la carta antes de enviarla.');
      const preview = renderLetterBodyHtml(editor.body);
      const modal = document.createElement('div');
      modal.className = 'modal-backdrop';
      modal.id = 'confirm-modal';
      modal.innerHTML = `<section class="modal-card" role="dialog" aria-modal="true" aria-labelledby="send-confirm-title" aria-describedby="send-confirm-description" tabindex="-1"><span class="eyebrow">Un último vistazo</span><h2 id="send-confirm-title">¿Enviar esta carta?</h2><p id="send-confirm-description">Después de enviarla quedará registrada como correspondencia y ya no se editará silenciosamente.</p><article class="letter-paper" style="padding:20px;margin-top:14px"><h2 style="font-size:23px">${escapeHtml(editor.title || 'Sin título')}</h2><div class="letter-body">${preview}</div></article><div class="modal-actions"><button type="button" class="btn btn-ghost" data-action="dismiss-modal">Seguir revisando</button><button type="button" class="btn btn-primary" data-action="confirm-send">Enviar carta ↗</button></div></section>`;
      this._modalPreviousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      this._modalScrollY = window.scrollY || window.pageYOffset || 0;
      this._modalPreviousOverflow = document.body.style.overflow;
      this._modalPreviousPosition = document.body.style.position;
      this._modalPreviousTop = document.body.style.top;
      this._modalPreviousWidth = document.body.style.width;
      this._modalPreviousLeft = document.body.style.left;
      this._modalPreviousRight = document.body.style.right;
      this._modalPreviousHtmlOverflow = document.documentElement.style.overflow;
      this._modalPreviousAriaHidden = this.root.getAttribute('aria-hidden');
      this._modalPreviousInert = this.root.hasAttribute('inert');
      document.documentElement.style.overflow = 'hidden';
      document.documentElement.classList.add('modal-open');
      document.body.style.position = 'fixed';
      document.body.style.top = `-${this._modalScrollY}px`;
      document.body.style.left = '0';
      document.body.style.right = '0';
      document.body.style.width = '100%';
      document.body.style.overflow = 'hidden';
      this._modalPreventBackdropScroll = event => {
        if (!event.target?.closest?.('.modal-card')) event.preventDefault();
      };
      modal.addEventListener('touchmove', this._modalPreventBackdropScroll, { passive: false });
      modal.addEventListener('wheel', this._modalPreventBackdropScroll, { passive: false });
      this._modalImageLoadingCleanup?.();
      this._modalImageLoadingCleanup = bindLetterImageLoading(modal);
      this._sendPreviewKeydown = event => {
        const dialog = modal.querySelector('[role="dialog"]');
        if (!dialog) return;
        if (event.key === 'Escape') {
          event.preventDefault();
          this.closeModal();
          return;
        }
        if (event.key !== 'Tab') return;
        const focusable = [...dialog.querySelectorAll('button:not([disabled]),a[href],input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])')];
        const first = focusable[0];
        const last = focusable.at(-1);
        if (!first || !last) { event.preventDefault(); dialog.focus(); return; }
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
      };
      document.addEventListener('keydown', this._sendPreviewKeydown, true);
      document.body.append(modal);
      modal.querySelector('[data-action="dismiss-modal"]')?.focus?.({ preventScroll: true });
      // Ocultar la app solo después de mover el foco al diálogo evita dejar
      // un elemento enfocado dentro de un subárbol aria-hidden.
      this.root.setAttribute('aria-hidden', 'true');
      this.root.setAttribute('inert', '');
    }

    async confirmSend() {
      const editor = { ...this.state.editor, ...this.readEditorFromDom() };
      const title = editor.title.trim() || 'Sin título';
      const feedback = beginActionToast('Enviando tu carta…');
      let result;
      try {
      if (editor.parentLetterId) {
        result = await this.repository.reply({ parentLetterId: editor.parentLetterId, creationRequestId: editor.creationRequestId || crypto.randomUUID(), title, body: editor.body });
        if (result.status !== 'created') throw new Error('No se pudo enviar la respuesta.');
        await deleteLocalDraft(this.localDraftKey);
        this.localDraftKey = this.localDraftKeyFor(`new:${crypto.randomUUID()}`);
      } else {
        if (!editor.letterId) await this.saveDraft(true);
        const current = this.state.editor;
        if (!current?.letterId || current.localOnly || current.conflict) throw new Error('El borrador no está sincronizado. No se envió la versión del servidor.');
        result = await this.repository.sendDraft({ letterId: current.letterId, expectedRevision: current.revision || 1 });
        if (result.status === 'recipient_unavailable') throw new Error('Tu borrador está guardado, pero la segunda cuenta todavía no está creada. Cuando tu esposa se registre podrás enviarlo.');
        if (result.status !== 'sent' && result.status !== 'already_sent') throw new Error('No se pudo enviar la carta.');
        await deleteLocalDraft(this.localDraftKeyFor(`letter:${current.letterId}`));
        try { localStorage.removeItem(this.emergencyDraftStorageKey()); } catch {}
        this.localDraftKey = null;
      }
      this.closeModal();
      this.state.editor = null;
      this.invalidateRouteCache();
      feedback.success('Tu carta se envió correctamente.');
      await this.openRoute('sent', true, { focus: true, skipHistory: true });
      } catch (error) {
        feedback.error(error.message || 'No se pudo enviar tu carta.');
        error.actionFeedbackShown = true;
        throw error;
      }
    }

    closeModal() {
      const modal = document.querySelector('#confirm-modal');
      if (!modal) return;
      this._modalImageLoadingCleanup?.();
      this._modalImageLoadingCleanup = null;
      if (this._sendPreviewKeydown) document.removeEventListener('keydown', this._sendPreviewKeydown, true);
      this._sendPreviewKeydown = null;
      if (this._modalPreventBackdropScroll) {
        modal.removeEventListener('touchmove', this._modalPreventBackdropScroll);
        modal.removeEventListener('wheel', this._modalPreventBackdropScroll);
      }
      this._modalPreventBackdropScroll = null;
      modal.remove();
      document.documentElement.classList.remove('modal-open');
      document.documentElement.style.overflow = this._modalPreviousHtmlOverflow || '';
      document.body.style.overflow = this._modalPreviousOverflow || '';
      document.body.style.position = this._modalPreviousPosition || '';
      document.body.style.top = this._modalPreviousTop || '';
      document.body.style.width = this._modalPreviousWidth || '';
      document.body.style.left = this._modalPreviousLeft || '';
      document.body.style.right = this._modalPreviousRight || '';
      window.scrollTo(0, this._modalScrollY || 0);
      if (this._modalPreviousAriaHidden === null || this._modalPreviousAriaHidden === undefined) this.root.removeAttribute('aria-hidden');
      else this.root.setAttribute('aria-hidden', this._modalPreviousAriaHidden);
      if (this._modalPreviousInert) this.root.setAttribute('inert', '');
      else this.root.removeAttribute('inert');
      const previousFocus = this._modalPreviousFocus;
      this._modalPreviousFocus = null;
      if (previousFocus?.isConnected) previousFocus.focus?.({ preventScroll: true });
    }

    async startEditSentLetter(letterId) {
      const targetId = String(letterId || '');
      if (!targetId) throw new Error('No se identificó la carta que quieres editar.');
      const data = await this.repository.get(targetId);
      const letter = data?.letter;
      if (!letter || letter.status !== 'sent' || String(letter.sender_id) !== String(this.session?.user?.id)) {
        throw new Error('Solo puedes editar las cartas y respuestas que tú has enviado.');
      }
      this.rememberCurrentPage?.();
      this.localDraftKey = this.localDraftKeyFor(`edit-sent:${targetId}`);
      const local = await getLocalDraft(this.localDraftKey);
      const localIsNewer = Boolean(local?.savedAt
        && new Date(local.savedAt).getTime() > new Date(letter.updated_at || letter.sent_at || letter.created_at).getTime());
      this.previousListRoute = ['inbox','sent','drafts','favorites','archive','trash'].includes(this.state.route)
        ? this.state.route : (this.previousListRoute || 'sent');
      this.state.editor = {
        letterId: targetId,
        creationRequestId: null,
        title: localIsNewer ? (local.title || '') : (letter.title || ''),
        body: localIsNewer ? (local.body || '') : (letter.body || ''),
        revision: letter.revision,
        parentLetterId: letter.reply_to_letter_id || null,
        editingSent: true,
        saved: false,
        saving: false,
        localOnly: true,
        pendingSync: false,
        serverUpdatedAt: letter.updated_at || letter.sent_at || letter.created_at
      };
      this.routeRequestId++;
      this.state.route = 'write';
      this.state.routeLoading = false;
      this.state.routeError = null;
      history.replaceState(null, '', '#/write');
      this.render();
      this.root.querySelector('#editor-title')?.focus?.({ preventScroll: true });
    }

    async saveSentLetterEdits() {
      const current = this.readEditorFromDom();
      const editor = { ...this.state.editor, ...current };
      if (!editor?.editingSent || !editor.letterId) throw new Error('No hay una carta enviada en edición.');
      if (!plainTextFromHtml(editor.body || '').trim()) throw new Error('El contenido de la carta no puede quedar vacío.');
      if (plainTextFromHtml(editor.body || '').length > 100000) throw new Error('La carta supera el límite de 100.000 caracteres.');
      const feedback = beginActionToast('Guardando los cambios de la carta enviada…');
      this.state.editor = { ...editor, saving: true };
      const storageKey = this.localDraftKey || this.localDraftKeyFor(`edit-sent:${editor.letterId}`);
      try {
        await putLocalDraft({ key: storageKey, ...editor, editingSent: true, localOnly: true, pendingSync: false, savedAt: new Date().toISOString() });
        const result = await this.repository.editSent({
          letterId: editor.letterId,
          title: String(editor.title || '').trim() || 'Sin título',
          body: editor.body,
          expectedRevision: Number(editor.revision || 1)
        });
        if (result?.status === 'conflict') {
          throw new Error('Esta carta cambió en otra sesión. Tus cambios permanecen guardados en este dispositivo; vuelve a abrirla y compara la versión actual antes de guardar de nuevo.');
        }
        if (result?.status !== 'saved') throw new Error('El servidor no confirmó los cambios de la carta.');
        await deleteLocalDraft(storageKey);
        this.state.editor = null;
        this.invalidateRouteCache();
        feedback.success('Los cambios de tu carta se guardaron correctamente.');
        const previous = this.navigationHistory?.at?.(-1);
        if (previous?.route === 'letter' && String(previous.letterId) === String(editor.letterId)) this.navigationHistory.pop();
        await this.openLetter(editor.letterId, true, null, { skipHistory: true });
        return result;
      } catch (error) {
        this.state.editor = { ...editor, saving: false, saved: false, localOnly: true };
        feedback.error(error.message || 'No se pudieron guardar los cambios.');
        error.actionFeedbackShown = true;
        throw error;
      }
    }

    async saveLetterAsPdf() {
      const selected = this.state.selectedLetter;
      const letterId = String(selected?.letter?.id || '');
      if (!letterId) throw new Error('Abre una carta antes de preparar el PDF.');
      const feedback = beginActionToast('Actualizando imágenes y preparando la correspondencia completa…');
      let root = null;
      let unbindImages = null;
      let restoreTitle = null;
      let cleanup = null;
      try {
        // Recupera toda la conversación desde el servidor antes de imprimir.
        // Las URL de Storage son firmadas y pueden haber caducado en la vista
        // que permanece abierta durante mucho tiempo.
        const bundle = await this.repository.get(letterId, null, 100);
        if (!bundle?.letter?.id) throw new Error('No se pudo actualizar la carta antes de preparar el PDF.');
        const messages = new Map((bundle.thread || []).filter(item => item?.id).map(item => [String(item.id), item]));
        messages.set(String(bundle.letter.id), bundle.letter);
        let cursor = bundle.threadNextCursor || null;
        let hasMore = bundle.threadHasMore === true;
        let pages = 0;
        while (hasMore) {
          if (!cursor || pages++ >= 100) throw new Error('No se pudo completar la carga de todas las respuestas. Vuelve a intentarlo antes de guardar el PDF.');
          const page = await this.repository.get(letterId, cursor, 100);
          for (const item of page.thread || []) if (item?.id) messages.set(String(item.id), item);
          hasMore = page.threadHasMore === true;
          cursor = page.threadNextCursor || null;
        }
        const ordered = [...messages.values()].sort((a, b) =>
          new Date(a.sent_at || a.created_at || 0).getTime() - new Date(b.sent_at || b.created_at || 0).getTime()
          || String(a.id).localeCompare(String(b.id))
        );
        if (!ordered.length) throw new Error('No encontramos contenido para generar el PDF.');
        const original = ordered.find(item => String(item.id) === letterId) || bundle.letter;
        const title = original.title || 'Correspondencia';
        const messageMarkup = ordered.map((item, index) => {
          const sender = escapeHtml(item.senderName || 'Remitente');
          const recipient = escapeHtml(item.recipientName || 'Destinatario');
          const itemTitle = escapeHtml(item.title || (index === 0 ? 'Carta original' : 'Respuesta'));
          const label = item.reply_to_letter_id ? `Respuesta ${index}` : 'Carta original';
          const date = escapeHtml(formatDate(item.sent_at || item.created_at));
          const body = renderLetterBodyHtml(item.body || '', { eagerImages: true, showPlaceholder: false });
          return `<article class="pdf-letter"><h2>${itemTitle}</h2><div class="pdf-meta"><span>${escapeHtml(label)}</span><span>De: ${sender}</span><span>Para: ${recipient}</span><span>${date}</span></div><div class="pdf-body">${body}</div><footer class="pdf-closing"><p class="pdf-signature">Con cariño, ${sender}</p><p class="pdf-index">Mensaje ${index + 1} de ${ordered.length}</p></footer></article>`;
        }).join('');

        root = document.createElement('main');
        root.id = 'letter-pdf-print-root';
        root.setAttribute('aria-hidden', 'true');
        root.innerHTML = `<style>
          @page{size:A4;margin:0}
          #letter-pdf-print-root{display:block;position:fixed;left:-400mm;top:0;box-sizing:border-box;width:210mm;max-width:210mm;padding:16mm;background:#fff;color:#25211f;font:11.5pt/1.62 Georgia,'Times New Roman',serif;visibility:hidden;pointer-events:none;z-index:-1}
          #letter-pdf-print-root *{box-sizing:border-box}
          #letter-pdf-print-root .pdf-document-heading{margin:0 0 8mm;padding:0 0 5mm;border-bottom:1px solid #ded7d0;font:9pt/1.45 Arial,sans-serif;color:#655950;break-after:avoid-page;page-break-after:avoid}
          #letter-pdf-print-root .pdf-document-heading h1{margin:0 0 2mm;color:#302923;font:22pt/1.2 Georgia,serif}
          #letter-pdf-print-root .pdf-document-heading p{margin:0}
          #letter-pdf-print-root .pdf-letter{margin:0;padding:0 0 5mm;border:0;break-inside:auto;page-break-inside:auto}
          #letter-pdf-print-root .pdf-letter + .pdf-letter{break-before:page;page-break-before:always}
          #letter-pdf-print-root .pdf-letter h2{margin:0 0 4mm;font:18pt/1.22 Georgia,serif;color:#302923;break-after:avoid-page;page-break-after:avoid}
          #letter-pdf-print-root .pdf-meta{display:flex;flex-wrap:wrap;gap:2mm 5mm;margin:0 0 6mm;padding:0 0 3mm;border-bottom:1px solid #e8e2dc;color:#756960;font:8pt/1.35 Arial,sans-serif;break-after:avoid-page;page-break-after:avoid}
          #letter-pdf-print-root .pdf-body{color:#25211f;overflow-wrap:anywhere;word-break:normal;break-after:avoid-page;page-break-after:avoid}
          #letter-pdf-print-root .pdf-body p{margin:2.2mm 0;color:#25211f!important;orphans:3;widows:3}
          #letter-pdf-print-root .pdf-body h1,#letter-pdf-print-root .pdf-body h2,#letter-pdf-print-root .pdf-body h3{color:#302923!important;break-after:avoid-page;page-break-after:avoid}
          #letter-pdf-print-root .pdf-body blockquote{margin:4mm 0;padding-left:4mm;border-left:2px solid #bd9788;color:#54443d}
          #letter-pdf-print-root .pdf-body ul,#letter-pdf-print-root .pdf-body ol{padding-left:6mm}
          #letter-pdf-print-root .letter-image-frame{display:block;width:100%;max-width:84%;max-height:108mm;margin:5mm auto;text-align:center;break-inside:avoid-page;page-break-inside:avoid;break-after:avoid-page;page-break-after:avoid}
          #letter-pdf-print-root .letter-image-frame img{display:block;width:auto!important;height:auto!important;max-width:100%!important;max-height:100mm!important;object-fit:contain;margin:0 auto;opacity:1!important;filter:none!important;transform:none!important;animation:none!important}
          #letter-pdf-print-root .letter-image-placeholder{display:none!important}
          #letter-pdf-print-root .letter-image-frame::before,#letter-pdf-print-root .letter-image-frame::after{display:none!important;content:none!important;animation:none!important}
          #letter-pdf-print-root .pdf-closing{display:block;margin:6mm 0 0;break-inside:avoid-page;page-break-inside:avoid;break-before:avoid-page;page-break-before:avoid}
          #letter-pdf-print-root .pdf-signature{margin:0;color:#54443d;font-style:italic;orphans:2;widows:2}
          #letter-pdf-print-root .pdf-index{margin:1.5mm 0 0;color:#80736a;font:8pt/1.35 Arial,sans-serif}
          @media print{
            html,body{width:100%!important;min-height:0!important;margin:0!important;padding:0!important;background:#fff!important;color:#25211f!important}
            body>*:not(#letter-pdf-print-root){display:none!important}
            #letter-pdf-print-root{display:block!important;position:static!important;left:auto!important;top:auto!important;width:auto!important;max-width:none!important;min-height:0!important;margin:0!important;padding:16mm!important;visibility:visible!important;overflow:visible!important;z-index:auto!important}
            #letter-pdf-print-root .pdf-letter{color:#25211f!important}
          }
        </style><header class="pdf-document-heading"><h1>${escapeHtml(title)}</h1><p>Correspondencia completa · ${ordered.length} ${ordered.length === 1 ? 'mensaje' : 'mensajes'}</p></header>${messageMarkup}`;
        root.style.display = 'block';
        document.body.append(root);
        unbindImages = bindLetterImageLoading(root);
        restoreTitle = document.title;
        document.title = `${this.fileName(title)}-correspondencia`;
        cleanup = () => {
          unbindImages?.();
          root?.remove();
          if (restoreTitle !== null) document.title = restoreTitle;
          window.removeEventListener('afterprint', cleanup);
          if (this._pdfCleanup === cleanup) this._pdfCleanup = null;
        };
        this._pdfCleanup?.();
        this._pdfCleanup = cleanup;
        window.addEventListener('afterprint', cleanup, { once: true });

        const images = [...root.querySelectorAll('.pdf-body img')];
        const waitForImage = async image => {
          image.loading = 'eager';
          image.decoding = 'sync';
          image.fetchPriority = 'high';
          if (!image.getAttribute('src')) throw new Error('Una imagen no tiene una dirección privada disponible. Actualiza la carta y vuelve a generar el PDF.');
          if (!image.complete) {
            await new Promise((resolve, reject) => {
              let settled = false;
              const finish = (error = null) => {
                if (settled) return;
                settled = true;
                window.clearTimeout(timer);
                image.removeEventListener('load', onLoad);
                image.removeEventListener('error', onError);
                if (error) reject(error); else resolve();
              };
              const onLoad = () => finish();
              const onError = () => finish(new Error('No se pudo cargar una imagen adjunta. Comprueba tu conexión y vuelve a intentarlo.'));
              const timer = window.setTimeout(() => finish(new Error('Una imagen tardó demasiado en cargar. No se imprimió un PDF incompleto.')), 20000);
              image.addEventListener('load', onLoad, { once: true });
              image.addEventListener('error', onError, { once: true });
              if (image.complete) finish(image.naturalWidth > 0 ? null : new Error('No se pudo cargar una imagen adjunta. Comprueba tu conexión y vuelve a intentarlo.'));
            });
          }
          if (image.naturalWidth <= 0) throw new Error('No se pudo cargar una imagen adjunta. Comprueba tu conexión y vuelve a intentarlo.');
          if (typeof image.decode === 'function') {
            try { await image.decode(); }
            catch { if (image.naturalWidth <= 0) throw new Error('Una imagen no pudo decodificarse. No se imprimió un PDF incompleto.'); }
          }
          if (image.closest('.letter-image-frame')) image.closest('.letter-image-frame').classList.remove('is-loading', 'is-pending-source', 'is-error');
        };
        await Promise.all(images.map(waitForImage));
        await document.fonts?.ready?.catch?.(() => {});
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        feedback.success('Documento completo listo. En la ventana de impresión elige «Guardar como PDF».');
        window.print();
        return { status: 'ready', messageCount: ordered.length, imageCount: images.length };
      } catch (error) {
        cleanup?.();
        this._pdfCleanup?.();
        feedback.error(error.message || 'No se pudo preparar el PDF.');
        error.actionFeedbackShown = true;
        throw error;
      }
    }

    async downloadTxt(letterId) {
      const data = await this.repository.get(letterId);
      const letter = data.letter;
      const text = `${letter.title || 'Sin título'}\nDe: ${letter.senderName}\nPara: ${letter.recipientName}\nFecha: ${letter.sent_at || letter.created_at}\n\n${plainTextFromHtml(letter.body)}`;
      const blob = new Blob([`\ufeff${text}`], { type: 'text/plain;charset=utf-8' });
      this.downloadBlob(blob, `${this.fileName(letter.title)}.txt`);
    }

    async downloadHtml(letterId) {
      const data = await this.repository.get(letterId);
      const letter = data.letter;
      const title = escapeHtml(letter.title || 'Sin título');
      const sender = escapeHtml(letter.senderName || 'Remitente');
      const recipient = escapeHtml(letter.recipientName || 'Destinatario');
      const date = escapeHtml(new Date(letter.sent_at || letter.created_at).toLocaleString('es-CO', { dateStyle: 'long', timeStyle: 'short' }));
      const body = sanitizeRichHtml(letter.body || '');
      const documentHtml = `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><style>body{margin:0;padding:32px;background:#f4eee5;color:#403630;font:16px/1.8 Georgia,serif}.letter{max-width:760px;margin:24px auto;padding:clamp(28px,7vw,64px);background:#fffdf8;border:1px solid #eadfd2}.meta{display:flex;flex-wrap:wrap;gap:12px;color:#88776e;font:12px/1.5 Arial,sans-serif;border-bottom:1px solid #eadfd2;padding-bottom:18px;margin-bottom:26px}.body{overflow-wrap:anywhere}.body p{margin:.5em 0}.body blockquote{border-left:2px solid #c89f91;padding-left:15px;color:#765d52}</style></head><body><main class="letter"><h1>${title}</h1><div class="meta"><span>De: ${sender}</span><span>Para: ${recipient}</span><span>${date}</span></div><div class="body">${body}</div><p><em>Con cariño, ${sender}</em></p></main></body></html>`;
      const blob = new Blob([`\ufeff${documentHtml}`], { type: 'text/html;charset=utf-8' });
      this.downloadBlob(blob, `${this.fileName(letter.title)}.html`);
    }

    downloadBlob(blob, filename) {
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url; anchor.download = filename; anchor.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    }

    fileName(title) { return (title || 'carta').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9-_]+/gi, '-').replace(/^-|-$/g, '').toLowerCase() || 'carta'; }
}
