import { getLocalDraft, deleteLocalDraft } from '../services/local-drafts.js';
import { plainTextFromHtml, sanitizeRichHtml, showToast, escapeHtml } from '../utils/dom.js';

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

    async openLetter(letterId, updateHash = true, initialLetter = null) {
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
      await this.editDraft(letterId);
      await this.previewSend();
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
      this.localDraftKey = this.localDraftKeyFor(`reply:${letterId}`);
      this.state.editor = { letterId: null, creationRequestId: crypto.randomUUID(), title: `Re: ${data.letter.title || 'Tu carta'}`.slice(0,180), body: '', revision: 1, parentLetterId: letterId, saving: false, saved: false };
      const local = await getLocalDraft(this.localDraftKey);
      if (local) this.state.editor = { ...this.state.editor, ...local };
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
      const preview = sanitizeRichHtml(editor.body);
      const modal = document.createElement('div');
      modal.className = 'modal-backdrop';
      modal.id = 'confirm-modal';
      modal.innerHTML = `<section class="modal-card" role="dialog" aria-modal="true" aria-labelledby="send-confirm-title" aria-describedby="send-confirm-description" tabindex="-1"><span class="eyebrow">Un último vistazo</span><h2 id="send-confirm-title">¿Enviar esta carta?</h2><p id="send-confirm-description">Después de enviarla quedará registrada como correspondencia y ya no se editará silenciosamente.</p><article class="letter-paper" style="padding:20px;margin-top:14px"><h2 style="font-size:23px">${escapeHtml(editor.title || 'Sin título')}</h2><div class="letter-body">${preview}</div></article><div class="modal-actions"><button type="button" class="btn btn-ghost" data-action="dismiss-modal">Seguir revisando</button><button type="button" class="btn btn-primary" data-action="confirm-send">Enviar carta ↗</button></div></section>`;
      this._modalPreviousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      this._modalPreviousOverflow = document.body.style.overflow;
      this._modalPreviousAriaHidden = this.root.getAttribute('aria-hidden');
      this._modalPreviousInert = this.root.hasAttribute('inert');
      document.body.style.overflow = 'hidden';
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
      let result;
      if (editor.parentLetterId) {
        result = await this.repository.reply({ parentLetterId: editor.parentLetterId, creationRequestId: editor.creationRequestId || crypto.randomUUID(), title, body: editor.body });
        if (result.status !== 'created') throw new Error('No se pudo enviar la respuesta.');
        await deleteLocalDraft(this.localDraftKey);
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
      showToast('Tu carta fue enviada.', 'success');
      await this.openRoute('sent', true, { focus: true });
    }

    closeModal() {
      const modal = document.querySelector('#confirm-modal');
      if (!modal) return;
      if (this._sendPreviewKeydown) document.removeEventListener('keydown', this._sendPreviewKeydown, true);
      this._sendPreviewKeydown = null;
      modal.remove();
      document.body.style.overflow = this._modalPreviousOverflow || '';
      if (this._modalPreviousAriaHidden === null || this._modalPreviousAriaHidden === undefined) this.root.removeAttribute('aria-hidden');
      else this.root.setAttribute('aria-hidden', this._modalPreviousAriaHidden);
      if (this._modalPreviousInert) this.root.setAttribute('inert', '');
      else this.root.removeAttribute('inert');
      const previousFocus = this._modalPreviousFocus;
      this._modalPreviousFocus = null;
      if (previousFocus?.isConnected) previousFocus.focus?.({ preventScroll: true });
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
