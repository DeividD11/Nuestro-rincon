import { putLocalDraft, deleteLocalDraft, deleteLocalDraftStrict, getLocalDraftsForUser } from '../services/local-drafts.js';
import { plainTextFromHtml, sanitizeRichHtml, showToast, beginActionToast } from '../utils/dom.js';
import { readPendingRecovery } from '../services/recovery-handoff.js';
import { uploadPrivateMedia } from '../services/private-media-upload.js';
import { syncDraftSnapshot } from '../services/draft-sync-service.js';
import { hasDraftBody, clearEmptyNewDraft, emergencyDraftStorageKey, persistEmergencyDraft, readEmergencyDraft, restoreEmergencyDraft, hydrateEditorFromLocal, flushDraftOnExit, persistLocalDraft } from '../services/draft-persistence-service.js';

export class DraftController {
    hasDraftBody(body) { return hasDraftBody(this, body); }

    async loadLocalReplyDrafts() {
      const userId = this.session?.user?.id;
      if (!userId) { this.state.localReplyDrafts = []; return []; }
      const drafts = await getLocalDraftsForUser(userId);
      const replies = drafts.filter(item => item?.parentLetterId && item.editingSent !== true && this.hasDraftBody(item.body))
        .map(item => ({
          ...item,
          id: `local:reply:${item.creationRequestId || item.key}`,
          localDraftKey: item.key,
          status: 'draft',
          isReplyDraft: true,
          localOnly: true,
          pendingSync: false,
          title: item.title || 'Respuesta sin título',
          updated_at: item.savedAt || item.updated_at || item.created_at || new Date().toISOString(),
          created_at: item.created_at || item.savedAt || new Date().toISOString()
        }));
      this.state.localReplyDrafts = replies;
      return replies;
    }

    async clearEmptyNewDraft(storageKey) { return clearEmptyNewDraft(this, storageKey); }

    onInput(event) {
      if (event.target.id === 'letter-search') {
        this.state.search = String(event.target.value || '').slice(0, 120);
        window.clearTimeout(this.searchTimer);
        const requestId = this.searchRequestId = (this.searchRequestId || 0) + 1;
        const route = this.state.route;
        const results = this.root.querySelector('#letter-list-results');
        const status = this.root.querySelector('#letter-search-status');
        if (results) {
          results.classList.add('is-searching');
          results.setAttribute('aria-busy', 'true');
        }
        if (status) status.textContent = this.state.search.trim() ? 'Buscando…' : '';
        const query = this.state.search;
        this.searchTimer = window.setTimeout(() => {
          this.runLetterSearch(route, query, requestId).catch(error => {
            if (requestId !== this.searchRequestId || this.state.route !== route) return;
            const currentResults = this.root.querySelector('#letter-list-results');
            currentResults?.classList.remove('is-searching');
            currentResults?.setAttribute('aria-busy', 'false');
            const currentStatus = this.root.querySelector('#letter-search-status');
            if (currentStatus) currentStatus.textContent = error.message || 'No se pudo completar la búsqueda.';
          });
        }, 170);
        return;
      }
      if (event.target.id === 'editor-title' || event.target.id === 'letter-editor') {
        this.editorInputVersion++;
        const editor = this.readEditorFromDom();
        this.state.editor = { ...this.state.editor, ...editor, inputVersion: this.editorInputVersion, savedAt: new Date().toISOString(), saving: true, saved: false };
        if (this.state.editor.editingSent) {
          const editKey = this.localDraftKey || this.localDraftKeyFor(`edit-sent:${this.state.editor.letterId}`);
          this.updateSaveStatus('Cambios sin guardar');
          window.clearTimeout(this.autosaveTimer);
          putLocalDraft({ key: editKey, ...this.state.editor, editingSent: true, localOnly: true, pendingSync: false })
            .catch(() => this.updateSaveStatus('No se pudo guardar la copia local temporal.'));
          return;
        }
        const hasBody = this.hasDraftBody(editor.body);
        const canPersist = Boolean(this.state.editor.letterId || hasBody);
        const status = this.root.querySelector('#save-status');
        if (status) status.textContent = canPersist ? 'Guardando…' : 'Escribe el contenido de la carta para crear un borrador.';
        window.clearTimeout(this.autosaveTimer);
        if (!canPersist) {
          const emptyKey = this.localDraftKey || this.localDraftKeyFor('new');
          this.clearEmptyNewDraft(emptyKey).catch(() => {});
          return;
        }
        this.persistEmergencyDraft(this.state.editor);
        // IndexedDB conserva una instantánea por pulsación; la escritura remota
        // sí se agrupa para no abrir una petición por cada tecla.
        this.persistLocalDraft().catch(() => {});
        this.autosaveTimer = window.setTimeout(() => this.saveDraft(true).catch(() => {}), 1000);
      }
    }

    async runLetterSearch(route, query, requestId) {
      const listRoutes = new Set(['inbox', 'sent', 'drafts', 'favorites', 'archive', 'trash']);
      if (!listRoutes.has(route) || this.state.route !== route || requestId !== this.searchRequestId) return;
      const result = await this.repository.list(route, query, null, 40);
      if (requestId !== this.searchRequestId || this.state.route !== route || this.state.search !== query) return;
      this.state.letters = this.uniqueLetters(result?.items || []);
      if (route === 'drafts' && this.state.localDraftPreview?.letterId
        && this.state.letters.some(item => String(item.id) === String(this.state.localDraftPreview.letterId))) {
        this.state.localDraftPreview = null;
      }
      this.state.pagination = {
        cursor: result?.nextCursor || null,
        loadedCount: Number(result?.loaded ?? result?.items?.length ?? 0),
        limit: result?.limit || 40,
        hasMore: Boolean(result?.hasMore), loading: false
      };
      this.renderListResultsOnly();
      const status = this.root.querySelector('#letter-search-status');
      if (status) status.textContent = query.trim() ? 'Resultados actualizados' : '';
    }

    readEditorFromDom() {
      const title = this.root.querySelector('#editor-title')?.value ?? this.state.editor?.title ?? '';
      const body = sanitizeRichHtml(this.root.querySelector('#letter-editor')?.innerHTML ?? this.state.editor?.body ?? '');
      return { title, body };
    }

    emergencyDraftStorageKey() { return emergencyDraftStorageKey(this); }

    persistEmergencyDraft(snapshot = null) { return persistEmergencyDraft(this, snapshot); }

    readEmergencyDraft(expectedKey = null) { return readEmergencyDraft(this, expectedKey); }

    async restoreEmergencyDraft() { return restoreEmergencyDraft(this); }

    async hydrateEditorFromLocal(storageKey, identity) { return hydrateEditorFromLocal(this, storageKey, identity); }

    flushDraftOnExit() { return flushDraftOnExit(this); }

    async persistLocalDraft() { return persistLocalDraft(this); }

    async addLetterImage(file) {
      if (!file || !this.state.editor) return;
      const editor = this.state.editor;
      if (!navigator.onLine) throw new Error('Conéctate a internet para adjuntar una imagen. Tu texto seguirá guardado localmente.');
      const editorNode = this.root.querySelector('#letter-editor');
      if (!editorNode) return;
      const current = this.readEditorFromDom();
      if (!plainTextFromHtml(current.body).trim()) throw new Error('Escribe primero algo en la carta antes de adjuntar una imagen.');
      const existingCount = editorNode.querySelectorAll('img[data-image-path]').length;
      if (existingCount >= 6) throw new Error('Cada carta admite hasta seis imágenes.');

      const feedback = beginActionToast('Preparando y subiendo la imagen…');
      let insertedImage = null;
      const selectionAtStart = window.getSelection();
      const savedRange = this._letterImageInsertionRange || (selectionAtStart?.rangeCount && editorNode.contains(selectionAtStart.getRangeAt(0).commonAncestorContainer)
        ? selectionAtStart.getRangeAt(0).cloneRange() : null);
      let insertionRange = savedRange && editorNode.contains(savedRange.commonAncestorContainer) ? savedRange.cloneRange() : null;
      if (!insertionRange) {
        insertionRange = document.createRange();
        insertionRange.selectNodeContents(editorNode);
        insertionRange.collapse(false);
      } else {
        // Si había texto seleccionado, insertar al final de la selección sin
        // borrarlo; un fallo de red no debe destruir contenido del usuario.
        insertionRange.collapse(false);
      }

      // El placeholder aparece inmediatamente, antes de comprimir o subir el
      // archivo. Es transitorio y sanitizeRichHtml lo excluye de los borradores.
      const placeholder = document.createElement('div');
      placeholder.className = 'letter-image-frame letter-image-upload-placeholder is-loading';
      placeholder.setAttribute('data-letter-image-uploading', 'true');
      placeholder.setAttribute('contenteditable', 'false');
      placeholder.setAttribute('role', 'status');
      const placeholderContent = document.createElement('span');
      placeholderContent.className = 'letter-image-placeholder';
      placeholderContent.setAttribute('aria-hidden', 'true');
      placeholderContent.innerHTML = '<span class="letter-image-placeholder-icon">▧</span><span class="letter-image-placeholder-label">Cargando imagen…</span>';
      placeholder.append(placeholderContent);
      insertionRange.insertNode(placeholder);

      const caretParagraph = document.createElement('p');
      caretParagraph.append(document.createElement('br'));
      placeholder.after(caretParagraph);
      const caretRange = document.createRange();
      caretRange.setStart(caretParagraph, 0);
      caretRange.collapse(true);
      this._letterImageInsertionRange = caretRange.cloneRange();
      selectionAtStart?.removeAllRanges();
      selectionAtStart?.addRange(caretRange);

      try {
        if (!editor.parentLetterId && !editor.letterId) {
          await this.saveDraft(true);
          if (!this.state.editor?.letterId) throw new Error('No se pudo preparar el borrador en el servidor. Conservamos la copia local; vuelve a intentarlo.');
        }
        const { prepareImageFile } = await import('../services/image-processing.js');
        const processed = await prepareImageFile(file, { maxDimension: 1600, maxBytes: 3 * 1024 * 1024 });
        const target = this.state.editor || editor;
        const media = await this.repository.prepareMediaUpload({
          kind: 'letter-image', letterId: target.letterId || null,
          parentLetterId: target.parentLetterId || null,
          mimeType: processed.type, fileSize: processed.size
        });
        await uploadPrivateMedia(media.uploadUrl, processed);
        const signed = await this.repository.signLetterImage({
          letterId: target.letterId || null, parentLetterId: target.parentLetterId || null, path: media.path
        });
        if (!editorNode.isConnected || !placeholder.isConnected) {
          feedback.dismiss();
          return;
        }

        const image = document.createElement('img');
        insertedImage = image;
        image.alt = 'Imagen adjunta';
        image.dataset.imagePath = media.path;
        image.className = 'letter-editor-image is-loading';
        image.loading = 'eager';
        image.decoding = 'async';
        placeholder.replaceWith(image);
        editorNode.focus({ preventScroll: true });
        if (caretParagraph.isConnected && editorNode.contains(caretParagraph)) {
          const nextRange = document.createRange();
          nextRange.setStart(caretParagraph, 0);
          nextRange.collapse(true);
          const currentSelection = window.getSelection();
          currentSelection?.removeAllRanges();
          currentSelection?.addRange(nextRange);
          this._letterImageInsertionRange = nextRange.cloneRange();
        } else {
          this._letterImageInsertionRange = null;
        }
        // Asignar src después de insertar el nodo permite que los listeners
        // delegados reciban load/error y retiren el estado de carga correctamente.
        image.src = signed.signedUrl;
        try {
          if (typeof image.decode === 'function') await image.decode();
          else if (!image.complete) await new Promise((resolve, reject) => {
            image.addEventListener('load', resolve, { once: true });
            image.addEventListener('error', () => reject(new Error('No se pudo cargar la vista previa de la imagen.')), { once: true });
          });
          if (image.naturalWidth === 0) throw new Error('No se pudo cargar la vista previa de la imagen.');
          image.classList.remove('is-loading', 'is-error');
          this.onInput({ target: editorNode });
          feedback.success('La imagen se subió y ya está visible en la carta.');
        } catch {
          image.classList.remove('is-loading');
          image.classList.add('is-error');
          this.onInput({ target: editorNode });
          feedback.error('La imagen se subió, pero no se pudo mostrar su vista previa. Puedes volver a abrir la carta para reintentar la carga.');
        }
      } catch (error) {
        placeholder.remove();
        if (caretParagraph.isConnected && editorNode.contains(caretParagraph)) {
          const nextRange = document.createRange();
          nextRange.setStart(caretParagraph, 0);
          nextRange.collapse(true);
          this._letterImageInsertionRange = nextRange;
        } else {
          this._letterImageInsertionRange = null;
        }
        if (insertedImage && !insertedImage.isConnected) this.onInput({ target: editorNode });
        feedback.error(error.message || 'No se pudo insertar la imagen en la carta.');
        error.actionFeedbackShown = true;
        throw error;
      }
    }

    async saveDraft(silent = false, options = {}) {
      if (!this.state.editor) return null;
      const current = this.readEditorFromDom();
      const editor = { ...this.state.editor, ...current };
      if (plainTextFromHtml(editor.body).length > 100000) throw new Error('La carta supera el límite de 100.000 caracteres.');
      const storageKey = this.localDraftKey || this.localDraftKeyFor(editor.letterId ? `letter:${editor.letterId}` : 'new');
      if (!editor.letterId && !this.hasDraftBody(editor.body)) {
        await this.clearEmptyNewDraft(storageKey);
        this.state.editor = { ...editor, saving: false, saved: false, pendingSync: false, localOnly: false };
        this.updateSaveStatus('Escribe al menos una letra en el cuerpo para guardar el borrador.');
        if (!silent) showToast('Escribe algo en la carta antes de guardar el borrador.', 'info');
        return { status: 'empty' };
      }
      if (editor.parentLetterId && !this.hasDraftBody(editor.body)) {
        await this.clearEmptyNewDraft(storageKey);
        this.state.editor = { ...editor, saving: false, saved: false, pendingSync: false, localOnly: false };
        this.updateSaveStatus('Escribe el contenido de tu respuesta antes de guardarla.');
        if (!silent) showToast('Escribe algo en tu respuesta antes de guardarla.', 'info');
        return { status: 'empty' };
      }
      if (editor.letterId && this.discardedDraftIds.has(editor.letterId)) {
        await this.clearLocalDraftForLetter(editor.letterId, this.localDraftKey);
        return { status: 'discarded' };
      }
      const feedback = silent ? null : beginActionToast('Guardando el borrador…');
      const snapshot = { ...editor, inputVersion: this.editorInputVersion, savedAt: new Date().toISOString(), saving: true, saved: false, pendingSync: true, localOnly: true };
      this.state.editor = snapshot;
      this.persistEmergencyDraft(snapshot);
      try {
        await putLocalDraft({ key: storageKey, ...snapshot });
      } catch (error) {
        feedback?.error('No se pudo guardar la copia local del borrador.');
        if (feedback) error.actionFeedbackShown = true;
        throw error;
      }
  
      const title = editor.title.trim() || 'Sin título';
      if (editor.parentLetterId) {
        this.state.editor = { ...editor, title, saving: false, saved: true, localOnly: true, pendingSync: false };
        try { await putLocalDraft({ key: storageKey, ...this.state.editor }); }
        catch (error) { feedback?.error('No se pudo guardar la respuesta en este dispositivo.'); if (feedback) error.actionFeedbackShown = true; throw error; }
        this.updateSaveStatus('Respuesta guardada en este dispositivo');
        feedback?.success('La respuesta quedó guardada en este dispositivo. Se enviará al confirmar.');
        return { status: 'local' };
      }
      if (!navigator.onLine) {
        this.state.editor = { ...editor, saving: false, saved: true, localOnly: true, pendingSync: true };
        this.updateSaveStatus('Sin conexión · copia local conservada');
        feedback?.info('La copia quedó guardada en este dispositivo y se sincronizará cuando vuelva la conexión.');
        return { status: 'local' };
      }
  
      try {
        const result = await this.enqueueDraftSync({ ...snapshot, title }, storageKey, options);
        if (result?.status === 'discarded') {
          this.updateSaveStatus('Este borrador está en la papelera. Recupéralo antes de seguir editándolo.');
          feedback?.info('El borrador está en la papelera y no se pudo guardar.');
        } else if (result?.status === 'saved' || result?.status === 'created') {
          this.updateSaveStatus('Guardado en la nube');
          feedback?.success('El borrador se guardó y sincronizó correctamente.');
        } else if (result?.status === 'conflict') {
          this.updateSaveStatus('Hay cambios nuevos en el servidor; conserva esta copia local antes de continuar.');
          feedback?.error('Hay un conflicto de edición. Tu copia local permanece intacta.');
        }
        return result;
      } catch (error) {
        if (editor.letterId && this.discardedDraftIds.has(editor.letterId)) {
          await this.clearLocalDraftForLetter(editor.letterId, storageKey);
          return { status: 'discarded' };
        }
        const latest = this.state.editor?.creationRequestId === editor.creationRequestId || this.state.editor?.letterId === editor.letterId
          ? { ...this.state.editor, ...this.readEditorFromDom() }
          : editor;
        this.state.editor = { ...latest, saving: false, saved: true, localOnly: true, pendingSync: true };
        await putLocalDraft({ key: storageKey, ...this.state.editor });
        this.persistEmergencyDraft(this.state.editor);
        this.updateSaveStatus('No se pudo sincronizar · copia local conservada');
        feedback?.error('No se pudo sincronizar el borrador. La copia local permanece guardada.');
        if (feedback) error.actionFeedbackShown = true;
        if (error.status === 401) this.forceLogout();
        throw error;
      }
    }

    draftSyncQueueKey() {
      // La identidad del borrador cambia de `new` a `letter:<id>` al crearse.
      // Un único carril por cuenta evita que ambas claves guarden a la vez con
      // la misma revisión y provoquen conflictos artificiales.
      return this.localDraftKeyFor('__draft-sync__');
    }

    enqueueDraftSync(snapshot, storageKey, options = {}) {
      if (this.discardedLocalDraftKeys?.has(storageKey)) return Promise.resolve({ status: 'discarded' });
      const letterId = snapshot?.letterId;
      if (letterId && this.discardedDraftIds.has(letterId)) {
        return this.clearLocalDraftForLetter(letterId, storageKey).then(() => ({ status: 'discarded' }));
      }
      const queueKey = this.draftSyncQueueKey();
      return this.draftSyncQueue.enqueue(queueKey, () => this.discardedLocalDraftKeys?.has(storageKey)
        ? Promise.resolve({ status: 'discarded' })
        : this.syncDraftSnapshot(snapshot, storageKey, options));
    }

    async clearLocalDraftForLetter(letterId, storageKey = null) {
      const canonicalKey = this.localDraftKeyFor(`letter:${letterId}`);
      const keys = new Set([canonicalKey, storageKey].filter(Boolean));
      for (const [source, target] of this.draftIdentity.entries()) {
        if (source === canonicalKey || target === canonicalKey || source === storageKey || target === storageKey) keys.add(source);
      }
      await Promise.all([...keys].map(key => deleteLocalDraft(key)));
      for (const [source, target] of this.draftIdentity.entries()) {
        if (keys.has(source) || keys.has(target)) this.draftIdentity.delete(source);
      }
      const emergency = this.readEmergencyDraft();
      if (emergency && (emergency.letterId === letterId || keys.has(emergency.key))) {
        try { localStorage.removeItem(this.emergencyDraftStorageKey()); } catch {}
      }
      if (this.localDraftKey && keys.has(this.localDraftKey)) this.localDraftKey = this.localDraftKeyFor('new');
      if (String(this.state.localDraftPreview?.letterId || '') === String(letterId)) this.state.localDraftPreview = null;
      this.state.localReplyDrafts = (this.state.localReplyDrafts || []).filter(item => String(item.letterId || '') !== String(letterId));
      if (this.state.editor?.letterId === letterId) {
        this.state.editor = null;
        if (this.state.route === 'write') {
          this.state.route = 'drafts';
          history.replaceState(null, '', '#/drafts');
          this.render();
        }
      }
    }

    async discardLocalDraft(storageKey = '', letterId = '') {
      const userId = String(this.session?.user?.id || '');
      const key = String(storageKey || '');
      if (!userId || !key.startsWith(`${userId}:`)) throw new Error('No se pudo verificar la identidad del borrador local.');
      const localDrafts = await getLocalDraftsForUser(userId);
      const local = localDrafts.find(item => item.key === key) || null;
      const preview = this.state.localDraftPreview?.localDraftKey === key ? this.state.localDraftPreview : null;
      const localReply = (this.state.localReplyDrafts || []).find(item => item.localDraftKey === key) || null;
      const draft = local || preview || localReply;
      if (!draft || draft.editingSent === true) throw new Error('No encontramos un borrador descartable. Actualiza la lista e inténtalo de nuevo.');

      const remoteId = String(letterId || draft.letterId || '');
      if (/^[0-9a-f-]{36}$/i.test(remoteId)) {
        // Pausa nuevas sincronizaciones antes de retirar el registro remoto.
        // El servidor confirma el descarte antes de eliminar su copia local.
        this.discardedLocalDraftKeys ||= new Set();
        this.discardedLocalDraftKeys.add(key);
        let remoteDiscardConfirmed = false;
        try {
          await this.draftSyncQueue.enqueue(this.draftSyncQueueKey(), () => Promise.resolve());
          const result = await this.discardLetter(remoteId, true);
          remoteDiscardConfirmed = true;
          await deleteLocalDraftStrict(key);
          const emergency = this.readEmergencyDraft();
          if (emergency?.key === key) {
            try { localStorage.removeItem(this.emergencyDraftStorageKey()); } catch { /* La copia principal ya se retiró. */ }
          }
          this.state.localDraftPreview = this.state.localDraftPreview?.localDraftKey === key ? null : this.state.localDraftPreview;
          this.state.localReplyDrafts = (this.state.localReplyDrafts || []).filter(item => item.localDraftKey !== key);
          this.invalidateRouteCache();
          this.renderListResultsOnly();
          return result;
        } catch (error) {
          // Si la API no confirmó el retiro, el borrador sigue sincronizable.
          // Si el backend sí lo confirmó pero IndexedDB falló, conservar la marca
          // evita que el contenido vuelva a crearse mientras el usuario reintenta.
          if (!remoteDiscardConfirmed) this.discardedLocalDraftKeys.delete(key);
          throw error;
        }
      }

      // Marca la clave antes de borrar IndexedDB para impedir que una tarea de
      // sincronización que ya estaba en cola vuelva a crear el borrador remoto.
      this.discardedLocalDraftKeys ||= new Set();
      this.discardedLocalDraftKeys.add(key);
      const feedback = beginActionToast('Descartando el borrador guardado en este dispositivo…');
      try {
        await this.draftSyncQueue.enqueue(this.draftSyncQueueKey(), () => Promise.resolve());
        await deleteLocalDraftStrict(key);
        const emergency = this.readEmergencyDraft();
        if (emergency?.key === key) {
          try { localStorage.removeItem(this.emergencyDraftStorageKey()); } catch { /* La copia principal ya se retiró. */ }
        }
        const wasActiveEditorDraft = this.localDraftKey === key;
        if (wasActiveEditorDraft) this.localDraftKey = this.localDraftKeyFor(`new:${crypto.randomUUID()}`);
        if (this.state.localDraftPreview?.localDraftKey === key) this.state.localDraftPreview = null;
        this.state.localReplyDrafts = (this.state.localReplyDrafts || []).filter(item => item.localDraftKey !== key);
        if (wasActiveEditorDraft && this.state.editor) this.state.editor = null;
        this.invalidateRouteCache();
        this.renderListResultsOnly();
        feedback.success('El borrador local se descartó correctamente.');
        return { status: 'discarded_local' };
      } catch (error) {
        this.discardedLocalDraftKeys.delete(key);
        feedback.error(error.message || 'No se pudo descartar el borrador local.');
        error.actionFeedbackShown = true;
        throw error;
      }
    }

    async deleteAllTrash() {
      if (this._bulkPurgingTrash) return { status: 'already_running' };
      if (!navigator.onLine) throw new Error('Conéctate a internet para vaciar la Papelera de forma segura. No se ha eliminado nada.');
      const userId = String(this.session?.user?.id || '');
      if (!userId) throw new Error('No hay una sesión activa para vaciar la Papelera.');
      if (this.pendingLetterActions?.size) throw new Error('Hay otra operación de correspondencia en curso. Espera a que termine y vuelve a intentarlo.');

      this._bulkPurgingTrash = true;
      this.state.trashBulkActionPending = true;
      this.renderCurrentRoute();
      const feedback = beginActionToast('Preparando la eliminación de los elementos de la Papelera…');
      const completedIds = new Set();
      const pendingIds = new Set();
      const failedIds = new Set();
      const pendingActionIds = new Set();
      let cursor = null;
      let pages = 0;
      let hasMore = true;
      try {
        // Se toma una instantánea paginada de la Papelera del usuario. No se
        // consulta Borradores y nunca se mueven cartas de otras carpetas aquí.
        const trashById = new Map();
        while (hasMore) {
          if (pages++ >= 100) throw new Error('La Papelera contiene demasiados elementos para procesarlos en una sola operación. No se ha iniciado la eliminación.');
          const page = await this.repository.list('trash', '', cursor, 100);
          if (!page || !Array.isArray(page.items)) throw new Error('No se pudo leer la Papelera completa. No se ha eliminado ningún elemento.');
          for (const item of page.items) {
            const id = String(item?.id || '');
            if (!id || item.isInTrash !== true) continue;
            // El ID es la clave idempotente: las tarjetas duplicadas o los
            // límites de páginas no provocarán una segunda purga.
            if (!trashById.has(id)) trashById.set(id, item);
          }
          hasMore = page.hasMore === true;
          cursor = page.nextCursor || null;
          if (hasMore && !cursor) throw new Error('La paginación de la Papelera no devolvió un cursor válido. No se ha iniciado la eliminación.');
        }

        const items = [...trashById.values()];
        if (!items.length) {
          feedback.info('La Papelera ya está vacía.');
          await this.openRoute('trash', false, { focus: false, skipHistory: true, preserveSearch: true });
          return { status: 'empty' };
        }

        // Si alguien ya había confirmado la eliminación de un mensaje
        // compartido, permanece pendiente sin volver a contabilizarlo.
        const toProcess = items.filter(item => !item.purgeConfirmedAt);
        for (const item of items) {
          if (item.purgeConfirmedAt) pendingIds.add(String(item.id));
        }
        for (const item of toProcess) {
          const id = String(item.id);
          this.pendingLetterActions?.add(id);
          pendingActionIds.add(id);
        }
        if (toProcess.length) this.renderCurrentRoute();

        for (let index = 0; index < toProcess.length; index++) {
          const item = toProcess[index];
          const id = String(item.id);
          feedback.update(`Procesando elemento ${index + 1} de ${toProcess.length}…`);
          try {
            const result = await this.repository.purge(id);
            if (['purged', 'already_purged'].includes(String(result?.status))) {
              completedIds.add(id);
              this.state.letters = (this.state.letters || []).filter(row => String(row.id) !== id);
            } else if (['pending_other_participant', 'already_confirmed_waiting'].includes(String(result?.status))) {
              pendingIds.add(id);
              this.patchLetterState?.(id, { purgeConfirmedAt: new Date().toISOString() });
            } else {
              failedIds.add(id);
            }
          } catch (error) {
            failedIds.add(id);
            console.error('No se pudo confirmar la purga de un elemento de Papelera', error?.code || error?.message || 'unknown');
          }
        }

        this.invalidateRouteCache();
        const pendingCount = pendingIds.size;
        const failedCount = failedIds.size;
        const successCount = completedIds.size;
        await this.openRoute('trash', false, { focus: false, skipHistory: true, preserveSearch: true });

        if (failedCount) {
          feedback.error(`Se eliminaron ${successCount} elementos. ${pendingCount} cartas compartidas esperan la confirmación de la otra persona y ${failedCount} no se pudieron procesar; siguen en la Papelera.`);
          return { status: 'partial', deleted: successCount, pending: pendingCount, failed: failedCount };
        }
        if (pendingCount) {
          feedback.info(`Se eliminaron ${successCount} creaciones tuyas. ${pendingCount} cartas o respuestas compartidas esperan la confirmación de la otra persona para borrar también su contenido.` , { duration: 7000 });
          return { status: 'confirmation_pending', deleted: successCount, pending: pendingCount, failed: 0 };
        }
        feedback.success(`La Papelera se vació correctamente. Se eliminaron ${successCount} cartas y respuestas.`);
        return { status: 'deleted', deleted: successCount, pending: 0, failed: 0 };
      } catch (error) {
        feedback.error(error.message || 'No se pudo vaciar la Papelera.');
        error.actionFeedbackShown = true;
        throw error;
      } finally {
        for (const id of pendingActionIds) this.pendingLetterActions?.delete(id);
        this._bulkPurgingTrash = false;
        this.state.trashBulkActionPending = false;
        if (this.state.route === 'trash') this.renderCurrentRoute();
      }
    }

    async discardLetter(letterId, isDraft) {
      if (!letterId) throw new Error('No se identificó la carta que quieres descartar.');
      const currentItem = this.state.letters.find(item => String(item.id) === String(letterId));
      const selectedItem = this.state.selectedLetter?.letter?.id === letterId ? this.state.selectedLetter.letter : null;
      const source = currentItem || selectedItem || this.state.selectedLetter?.thread?.find(item => String(item.id) === String(letterId)) || null;
      const wasAlreadyInTrash = Boolean(source?.isInTrash);
      const withdrawToDraft = !isDraft && source?.status === 'sent'
        && String(source.sender_id) === String(this.session?.user?.id) && !wasAlreadyInTrash;
      const targetRoute = withdrawToDraft ? 'drafts'
        : this.state.route === 'letter' ? (this.previousListRoute || 'inbox') : this.state.route;

      const before = this.snapshotLetterState();
      if (isDraft) {
        this.discardedDraftIds.add(letterId);
        window.clearTimeout(this.autosaveTimer);
      }

      this.state.letters = (this.state.letters || []).filter(item => String(item.id) !== String(letterId));
      if (this.state.selectedLetter?.letter?.id === letterId) this.state.selectedLetter = null;
      if (isDraft && !wasAlreadyInTrash) {
        this.state.dashboard = { ...this.state.dashboard, drafts: Math.max(0, Number(this.state.dashboard?.drafts || 0) - 1) };
      }
      if (withdrawToDraft) {
        this.state.dashboard = { ...this.state.dashboard, drafts: Math.max(0, Number(this.state.dashboard?.drafts || 0) + 1) };
      }
      if (this.state.route === 'letter') {
        this.state.route = targetRoute;
        history.replaceState(null, '', `#/${targetRoute}`);
      }
      this.state.routeLoading = false;
      this.render();
      const feedback = beginActionToast(withdrawToDraft ? 'Retirando la carta a Borradores…' : 'Moviendo la carta a la Papelera…');

      try {
        const result = await this.repository.moveToTrash(letterId);
        const accepted = withdrawToDraft
          ? ['withdrawn', 'already_draft']
          : ['trashed', 'already_trashed'];
        if (!accepted.includes(result?.status)) {
          throw new Error(withdrawToDraft
            ? 'No se pudo retirar la carta. Actualiza la conversación e inténtalo de nuevo.'
            : 'La carta no se movió a la papelera. Actualiza la lista e inténtalo de nuevo.');
        }
        if (isDraft) {
          await this.clearLocalDraftForLetter(letterId, this.localDraftKeyFor(`letter:${letterId}`));
          this.state.localDraftPreview = this.state.localDraftPreview?.letterId === letterId ? null : this.state.localDraftPreview;
          this.state.localReplyDrafts = (this.state.localReplyDrafts || []).filter(item => String(item.letterId || '') !== String(letterId));
        }

        this.invalidateRouteCache();
        this.state.routeLoading = false;
        if (withdrawToDraft) {
          feedback.success('La carta o respuesta volvió a Borradores. Ya no aparece en la conversación de la otra persona.');
          await this.openRoute('drafts', true, { focus: true, skipHistory: true });
          return result;
        }
        feedback.success(result.status === 'already_trashed' ? 'La carta ya estaba en la Papelera.' : 'La carta se movió a la Papelera.');
        const requestId = ++this.routeRequestId;
        const cacheKey = this.routeCacheKey(this.state.route);
        this.refreshRouteData(this.state.route, cacheKey, requestId, true).catch(() => {});
        return result;
      } catch (error) {
        if (isDraft) this.discardedDraftIds.delete(letterId);
        this.restoreLetterState(before);
        feedback.error(error.message || 'No se pudo mover la carta a la Papelera.');
        error.actionFeedbackShown = true;
        throw error;
      }
    }

    queueDraftSync(snapshot, storageKey) {
      if (this.discardedLocalDraftKeys?.has(storageKey)) return;
      if (!snapshot?.letterId && !this.hasDraftBody(snapshot?.body)) {
        this.clearEmptyNewDraft(storageKey).catch(() => {});
        return;
      }
      if (snapshot?.parentLetterId && !this.hasDraftBody(snapshot?.body)) {
        this.clearEmptyNewDraft(storageKey).catch(() => {});
        return;
      }
      if (snapshot?.letterId && this.discardedDraftIds.has(snapshot.letterId)) {
        this.clearLocalDraftForLetter(snapshot.letterId, storageKey).catch(() => {});
        return;
      }
      this.persistEmergencyDraft(snapshot);
      putLocalDraft({ key: storageKey, ...snapshot, pendingSync: true, localOnly: true }).then(() => {
        if (snapshot?.letterId && this.discardedDraftIds.has(snapshot.letterId)) {
          return this.clearLocalDraftForLetter(snapshot.letterId, storageKey);
        }
        return this.enqueueDraftSync({ ...snapshot, pendingSync: true }, storageKey);
      }).catch(() => {});
    }

    async syncPendingLocalDrafts() {
      if (readPendingRecovery() || !this.session?.user?.id || !navigator.onLine) return;
      const drafts = await getLocalDraftsForUser(this.session.user.id);
      for (const draft of drafts) {
        if (!draft) continue;
        if (!draft.letterId && !this.hasDraftBody(draft.body)) {
          await this.clearEmptyNewDraft(draft.key);
          continue;
        }
        if (draft.parentLetterId) continue;
        if (draft.pendingSync || draft.localOnly || draft.saved === false || !draft.letterId) {
          await this.enqueueDraftSync(draft, draft.key).catch(() => {});
        }
      }
    }

    async syncDraftSnapshot(initialSnapshot, initialStorageKey, options = {}) {
      return syncDraftSnapshot(this, initialSnapshot, initialStorageKey, options);
    }

    updateSaveStatus(text) {
      const status = this.root.querySelector('#save-status');
      if (status) status.textContent = text;
    }
}
