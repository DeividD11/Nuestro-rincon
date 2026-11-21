import { putLocalDraft, deleteLocalDraft, getLocalDraftsForUser } from '../services/local-drafts.js';
import { plainTextFromHtml, sanitizeRichHtml, showToast } from '../utils/dom.js';
import { readPendingRecovery } from '../services/recovery-handoff.js';
import { syncDraftSnapshot } from '../services/draft-sync-service.js';
import { hasDraftBody, clearEmptyNewDraft, emergencyDraftStorageKey, persistEmergencyDraft, readEmergencyDraft, restoreEmergencyDraft, hydrateEditorFromLocal, flushDraftOnExit, persistLocalDraft } from '../services/draft-persistence-service.js';

export class DraftController {
    hasDraftBody(body) { return hasDraftBody(this, body); }

    async clearEmptyNewDraft(storageKey) { return clearEmptyNewDraft(this, storageKey); }

    onInput(event) {
      if (event.target.id === 'letter-search') {
        this.state.search = event.target.value;
        window.clearTimeout(this.searchTimer);
        this.searchTimer = window.setTimeout(() => this.openRoute(this.state.route, false), 350);
        return;
      }
      if (event.target.id === 'editor-title' || event.target.id === 'letter-editor') {
        this.editorInputVersion++;
        const editor = this.readEditorFromDom();
        this.state.editor = { ...this.state.editor, ...editor, inputVersion: this.editorInputVersion, savedAt: new Date().toISOString(), saving: true, saved: false };
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
      const snapshot = { ...editor, inputVersion: this.editorInputVersion, savedAt: new Date().toISOString(), saving: true, saved: false, pendingSync: true, localOnly: true };
      this.state.editor = snapshot;
      this.persistEmergencyDraft(snapshot);
      await putLocalDraft({ key: storageKey, ...snapshot });
  
      const title = editor.title.trim() || 'Sin título';
      if (editor.parentLetterId) {
        this.state.editor = { ...editor, title, saving: false, saved: true, localOnly: true, pendingSync: false };
        await putLocalDraft({ key: storageKey, ...this.state.editor });
        this.updateSaveStatus('Respuesta guardada en este dispositivo');
        if (!silent) showToast('La respuesta se guardó en este dispositivo; se enviará al confirmar.', 'success');
        return { status: 'local' };
      }
      if (!navigator.onLine) {
        this.state.editor = { ...editor, saving: false, saved: true, localOnly: true, pendingSync: true };
        this.updateSaveStatus('Sin conexión · copia local conservada');
        if (!silent) showToast('Sin conexión. La copia local está guardada.', 'error');
        return { status: 'local' };
      }
  
      try {
        const result = await this.enqueueDraftSync({ ...snapshot, title }, storageKey, options);
        if (result?.status === 'discarded') {
          this.updateSaveStatus('Este borrador está en la papelera. Recupéralo antes de seguir editándolo.');
        } else if (result?.status === 'saved' || result?.status === 'created') {
          this.updateSaveStatus('Guardado en la nube');
          if (!silent) showToast('Borrador guardado.', 'success');
        } else if (result?.status === 'conflict') {
          this.updateSaveStatus('Hay cambios nuevos en el servidor; conserva esta copia local antes de continuar.');
          if (!silent) showToast('Conflicto de edición. Tu copia local permanece intacta.', 'error');
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
      const letterId = snapshot?.letterId;
      if (letterId && this.discardedDraftIds.has(letterId)) {
        return this.clearLocalDraftForLetter(letterId, storageKey).then(() => ({ status: 'discarded' }));
      }
      const queueKey = this.draftSyncQueueKey();
      return this.draftSyncQueue.enqueue(queueKey, () => this.syncDraftSnapshot(snapshot, storageKey, options));
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
      if (this.state.editor?.letterId === letterId) {
        this.state.editor = null;
        if (this.state.route === 'write') {
          this.state.route = 'drafts';
          history.replaceState(null, '', '#/drafts');
          this.render();
        }
      }
    }

    async discardLetter(letterId, isDraft) {
      if (!letterId) throw new Error('No se identificó la carta que quieres descartar.');
      const currentItem = this.state.letters.find(item => item.id === letterId);
      const selectedItem = this.state.selectedLetter?.letter?.id === letterId ? this.state.selectedLetter.letter : null;
      const source = currentItem || selectedItem;
      const wasAlreadyInTrash = Boolean(source?.isInTrash);
      const targetRoute = this.state.route === 'letter' ? (this.previousListRoute || 'inbox') : this.state.route;
  
      const before = this.snapshotLetterState();
      if (isDraft) {
        this.discardedDraftIds.add(letterId);
        window.clearTimeout(this.autosaveTimer);
      }
  
      // Respuesta visual inmediata: el registro desaparece de la carpeta sin
      // esperar a la red. Si el servidor rechaza el cambio, restauramos el estado.
      this.state.letters = (this.state.letters || []).filter(item => item.id !== letterId);
      if (this.state.selectedLetter?.letter?.id === letterId) this.state.selectedLetter = null;
      if (isDraft && !wasAlreadyInTrash) {
        this.state.dashboard = { ...this.state.dashboard, drafts: Math.max(0, Number(this.state.dashboard?.drafts || 0) - 1) };
      }
      if (this.state.route === 'letter') {
        this.state.route = targetRoute;
        history.replaceState(null, '', `#/${targetRoute}`);
      }
      this.state.routeLoading = false;
      this.render();
  
      try {
        const result = await this.repository.moveToTrash(letterId);
        if (!['trashed', 'already_trashed'].includes(result?.status)) {
          throw new Error('La carta no se movió a la papelera. Actualiza la lista e inténtalo de nuevo.');
        }
        if (isDraft) await this.clearLocalDraftForLetter(letterId, this.localDraftKeyFor(`letter:${letterId}`));
  
        for (const [cacheKey, entry] of this.routeCache.entries()) {
          const folder = cacheKey.split(':', 1)[0];
          let data = entry.data;
          if (Array.isArray(data?.letters?.items)) {
            let items = data.letters.items.filter(item => item.id !== letterId);
            if (folder === 'trash' && source && !items.some(item => item.id === letterId)) {
              items = [{ ...source, isInTrash: true }, ...items];
            }
            data = { ...data, letters: { ...data.letters, items } };
          }
          if (folder === 'home' && data?.dashboard && isDraft && !wasAlreadyInTrash) {
            data = { ...data, dashboard: { ...data.dashboard, drafts: Math.max(0, Number(data.dashboard.drafts || 0) - 1) } };
          }
          this.routeCache.set(cacheKey, { ...entry, data, at: 0 });
        }
  
        this.invalidateRouteCache();
        this.state.routeLoading = false;
        showToast(result.status === 'already_trashed' ? 'La carta ya estaba en la papelera.' : 'La carta se movió a la papelera.', 'success');
  
        const requestId = ++this.routeRequestId;
        const cacheKey = this.routeCacheKey(this.state.route);
        this.refreshRouteData(this.state.route, cacheKey, requestId, true).catch(() => {});
      } catch (error) {
        if (isDraft) this.discardedDraftIds.delete(letterId);
        this.restoreLetterState(before);
        throw error;
      }
    }

    queueDraftSync(snapshot, storageKey) {
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
