import { putLocalDraft, getLocalDraft, deleteLocalDraft, getLocalDraftsForUser } from '../services/local-drafts.js';
import { ApiError } from '../services/api-client.js';
import { plainTextFromHtml, sanitizeRichHtml, showToast } from '../utils/dom.js';
import { readPendingRecovery } from '../services/recovery-handoff.js';

export class DraftController {
    hasDraftBody(body) {
      return plainTextFromHtml(String(body || '')).trim().length > 0;
    }

    async clearEmptyNewDraft(storageKey) {
      if (!storageKey) return;
      await deleteLocalDraft(storageKey).catch(() => {});
      try {
        const emergency = JSON.parse(localStorage.getItem(this.emergencyDraftStorageKey()) || 'null');
        if (emergency && emergency.key === storageKey && !emergency.letterId) {
          localStorage.removeItem(this.emergencyDraftStorageKey());
        }
      } catch { /* No se conserva una instantánea vacía si el almacenamiento está dañado. */ }
    }

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

    emergencyDraftStorageKey() {
      return `nuestro-rincon:draft-emergency:${this.session?.user?.id || 'guest'}`;
    }

    persistEmergencyDraft(snapshot = null) {
      const editor = snapshot || (this.state.editor ? { ...this.state.editor, ...this.readEditorFromDom() } : null);
      if (!editor || editor.parentLetterId) return;
      if (!editor.letterId && !this.hasDraftBody(editor.body)) return;
      const userId = this.session?.user?.id;
      if (!userId) return;
      try {
        localStorage.setItem(this.emergencyDraftStorageKey(), JSON.stringify({
          ...editor,
          key: this.localDraftKey || this.localDraftKeyFor(editor.letterId ? `letter:${editor.letterId}` : 'new'),
          userId,
          pendingSync: true,
          savedAt: editor.savedAt || new Date().toISOString()
        }));
      } catch { /* IndexedDB conserva la copia principal. */ }
    }

    readEmergencyDraft(expectedKey = null) {
      const userId = this.session?.user?.id;
      if (!userId) return null;
      try {
        const raw = localStorage.getItem(this.emergencyDraftStorageKey());
        if (!raw) return null;
        const draft = JSON.parse(raw);
        if (draft.userId !== userId || !draft.key || draft.parentLetterId) return null;
        if (!draft.letterId && !this.hasDraftBody(draft.body)) {
          localStorage.removeItem(this.emergencyDraftStorageKey());
          return null;
        }
        if (expectedKey && draft.key !== expectedKey) return null;
        return { ...draft, pendingSync: true, localOnly: true };
      } catch { return null; }
    }

    async restoreEmergencyDraft() {
      const userId = this.session?.user?.id;
      if (!userId) return;
      const draft = this.readEmergencyDraft();
      if (!draft) return;
      if (!draft.letterId && !this.hasDraftBody(draft.body)) {
        await this.clearEmptyNewDraft(draft.key);
        return;
      }
      if (draft.key.startsWith(`${userId}:`)) this.localDraftKey = draft.key;
      await putLocalDraft(draft);
    }

    async hydrateEditorFromLocal(storageKey, identity) {
      const local = await getLocalDraft(storageKey);
      if (!local || this.state.route !== 'write' || this.state.editor?.creationRequestId !== identity) return;
      const emergency = this.readEmergencyDraft(storageKey);
      const newest = [local, emergency].filter(Boolean)
        .sort((a,b) => new Date(b.savedAt || 0).getTime() - new Date(a.savedAt || 0).getTime())[0];
      if (!newest) return;
      const current = this.state.editor;
      if (new Date(newest.savedAt || 0).getTime() < new Date(current.savedAt || 0).getTime()) return;
      this.state.editor = { ...current, ...newest, creationRequestId: newest.creationRequestId || identity };
      this.render();
      if (this.state.editor.pendingSync || this.state.editor.localOnly) this.saveDraft(true).catch(() => {});
    }

    flushDraftOnExit() {
      if (!this.state.editor) return;
      const snapshot = { ...this.state.editor, ...this.readEditorFromDom(), saving: true, saved: false, pendingSync: true, localOnly: true };
      if (!snapshot.letterId && !this.hasDraftBody(snapshot.body)) return;
      if (snapshot.parentLetterId && !this.hasDraftBody(snapshot.body)) return;
      this.persistEmergencyDraft(snapshot);
      const storageKey = this.localDraftKey || this.localDraftKeyFor(snapshot.letterId ? `letter:${snapshot.letterId}` : 'new');
      putLocalDraft({ key: storageKey, ...snapshot }).then(() => {
        if (navigator.onLine) this.enqueueDraftSync(snapshot, storageKey, { keepalive: true }).catch(() => {});
      }).catch(() => {});
    }

    async persistLocalDraft() {
      if (!this.state.editor) return;
      const current = this.readEditorFromDom();
      this.state.editor = { ...this.state.editor, ...current, savedAt: this.state.editor.savedAt || new Date().toISOString(), pendingSync: true, saved: false };
      const storageKey = this.localDraftKey || this.localDraftKeyFor(this.state.editor.letterId ? `letter:${this.state.editor.letterId}` : 'new');
      if (!this.state.editor.letterId && !this.hasDraftBody(this.state.editor.body)) {
        await this.clearEmptyNewDraft(storageKey);
        return;
      }
      this.persistEmergencyDraft(this.state.editor);
      await putLocalDraft({ key: storageKey, ...this.state.editor, pendingSync: true });
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
      if (!initialSnapshot || !navigator.onLine) return { status: 'local' };
      if (!initialSnapshot.letterId && !this.hasDraftBody(initialSnapshot.body)) {
        await this.clearEmptyNewDraft(initialStorageKey);
        return { status: 'empty' };
      }
      if (initialSnapshot.parentLetterId) return this.hasDraftBody(initialSnapshot.body) ? { status: 'local' } : { status: 'empty' };
      let storageKey = this.draftIdentity.get(initialStorageKey) || initialStorageKey;
      let snapshot = { ...initialSnapshot };
      if (snapshot.letterId && this.discardedDraftIds.has(snapshot.letterId)) {
        await this.clearLocalDraftForLetter(snapshot.letterId, storageKey);
        return { status: 'discarded' };
      }
      const local = await getLocalDraft(storageKey);
      if (local && (new Date(local.savedAt || 0).getTime() >= new Date(snapshot.savedAt || 0).getTime())) snapshot = { ...snapshot, ...local };
      // También se valida después de fusionar IndexedDB: un snapshot local viejo
      // y vacío no puede crear un nuevo registro en el servidor.
      if (!snapshot.letterId && !this.hasDraftBody(snapshot.body)) {
        await this.clearEmptyNewDraft(storageKey);
        return { status: 'empty' };
      }
      const requestOptions = options.keepalive ? { keepalive: true, timeoutMs: 7000 } : {};
      const title = snapshot.title?.trim() || 'Sin título';
  
      const storeSynced = async (draft, latestSnapshot, currentStorageKey) => {
        if (this.discardedDraftIds.has(draft.id)) {
          await this.clearLocalDraftForLetter(draft.id, currentStorageKey);
          return { status: 'discarded' };
        }
        const targetKey = this.localDraftKeyFor(`letter:${draft.id}`);
        const localLatest = await getLocalDraft(currentStorageKey);
        const emergencyLatest = this.readEmergencyDraft(currentStorageKey);
        const freshest = [latestSnapshot, localLatest, emergencyLatest].filter(Boolean)
          .sort((a,b) => new Date(b.savedAt || 0).getTime() - new Date(a.savedAt || 0).getTime())[0] || latestSnapshot;
        const currentMatches = this.state.editor && (
          this.state.editor.creationRequestId === latestSnapshot.creationRequestId ||
          this.state.editor.letterId === latestSnapshot.letterId ||
          this.state.editor.letterId === draft.id
        );
        const liveEditor = currentMatches && this.state.route === 'write'
          ? { ...this.state.editor, ...this.readEditorFromDom() }
          : null;
        const liveIsNewer = Boolean(liveEditor && (
          liveEditor.title !== freshest.title || liveEditor.body !== freshest.body ||
          this.editorInputVersion > Number(freshest.inputVersion || 0)
        ));
        const source = liveIsNewer ? { ...freshest, ...liveEditor, inputVersion: this.editorInputVersion } : freshest;
        const persisted = {
          ...source,
          letterId: draft.id,
          creationRequestId: source.creationRequestId || draft.creationRequestId || crypto.randomUUID(),
          revision: draft.revision || 1,
          title: source.title ?? draft.title ?? title,
          body: source.body ?? draft.body ?? '',
          saving: false,
          saved: !liveIsNewer,
          localOnly: liveIsNewer,
          pendingSync: liveIsNewer,
          conflict: false
        };
        await putLocalDraft({ key: targetKey, ...persisted });
        if (currentStorageKey !== targetKey) {
          this.draftIdentity.set(currentStorageKey, targetKey);
          await deleteLocalDraft(currentStorageKey);
        }
        if (currentMatches) {
          this.localDraftKey = targetKey;
          this.state.editor = persisted;
          if (this.state.route === 'write') this.updateSaveStatus(liveIsNewer ? 'Sincronizando los últimos cambios…' : 'Guardado en la nube');
        } else if (this.localDraftKey === currentStorageKey) {
          this.localDraftKey = null;
        }
        if (liveIsNewer) {
          this.persistEmergencyDraft(persisted);
          this.enqueueDraftSync(persisted, targetKey).catch(() => {});
        } else if (emergencyLatest && !(this.state.editor && this.state.route === 'write' && !currentMatches)) {
          // No borres la emergencia de una carta diferente que se esté editando.
          try { localStorage.removeItem(this.emergencyDraftStorageKey()); } catch {}
        }
        this.invalidateRouteCache();
        return { status: 'saved', draft };
      };
  
      if (!snapshot.letterId) {
        let creationRequestId = snapshot.creationRequestId || crypto.randomUUID();
        let created = await this.repository.createDraft({ creationRequestId, title, body: snapshot.body || '' }, requestOptions);
        if (created?.status === 'discarded' && created?.draft?.id) {
          this.discardedDraftIds.add(created.draft.id);
          await this.clearLocalDraftForLetter(created.draft.id, storageKey);
          return { status: 'discarded' };
        }
        if (created?.draft?.status === 'purged') {
          creationRequestId = crypto.randomUUID();
          const recoveredLocal = { ...snapshot, creationRequestId, pendingSync: true, localOnly: true, savedAt: new Date().toISOString() };
          await putLocalDraft({ key: storageKey, ...recoveredLocal });
          this.persistEmergencyDraft(recoveredLocal);
          created = await this.repository.createDraft({ creationRequestId, title, body: snapshot.body || '' }, requestOptions);
        }
        if (created.status !== 'created' || !created.draft?.id || created.draft.status !== 'draft') throw new ApiError('El servidor no confirmó la creación de un borrador nuevo.', 502, 'DRAFT_CREATE_UNCONFIRMED');
        let latest = await getLocalDraft(storageKey) || snapshot;
        const emergencyLatest = this.readEmergencyDraft(storageKey);
        if (emergencyLatest && new Date(emergencyLatest.savedAt || 0) > new Date(latest.savedAt || 0)) latest = { ...latest, ...emergencyLatest };
        latest = { ...snapshot, ...latest, letterId: created.draft.id, creationRequestId, revision: created.draft.revision || 1 };
        if (latest.title !== title || latest.body !== (snapshot.body || '')) {
          const saved = await this.repository.saveDraft({ letterId: created.draft.id, title: latest.title?.trim() || 'Sin título', body: latest.body || '', expectedRevision: created.draft.revision || 1 }, requestOptions);
          if (saved.status === 'not_found') throw new ApiError('El servidor creó el borrador pero no lo encontró al guardar los últimos cambios.', 404, 'DRAFT_NOT_FOUND');
          if (saved.status !== 'saved') throw new ApiError('No se pudieron guardar los últimos cambios del borrador.', 502, 'DRAFT_SAVE_UNCONFIRMED');
          return storeSynced(saved.draft || created.draft, latest, storageKey);
        }
        return storeSynced(created.draft, latest, storageKey);
      }
  
      try {
        const result = await this.repository.saveDraft({
          letterId: snapshot.letterId,
          title,
          body: snapshot.body || '',
          expectedRevision: snapshot.revision || 1
        }, requestOptions);
        if (result.status === 'discarded') {
          this.discardedDraftIds.add(snapshot.letterId);
          await this.clearLocalDraftForLetter(snapshot.letterId, storageKey);
          return { status: 'discarded' };
        }
        if (result.status === 'conflict') {
          const remote = result.draft;
          if (remote?.id === snapshot.letterId && remote.status === 'draft' && remote.title === title && remote.body === (snapshot.body || '')) {
            return storeSynced(remote, snapshot, storageKey);
          }
          const conflicted = { ...snapshot, conflict: true, localOnly: true, pendingSync: true, saved: true, saving: false };
          await putLocalDraft({ key: storageKey, ...conflicted });
          if (this.state.editor?.letterId === snapshot.letterId) this.state.editor = conflicted;
          return { status: 'conflict' };
        }
        if (result.status === 'not_found') throw new ApiError('El borrador ya no existe en el servidor.', 404, 'DRAFT_NOT_FOUND');
        if (result.status !== 'saved' || !result.draft) throw new ApiError('El servidor no confirmó el guardado del borrador.', 502, 'DRAFT_SAVE_UNCONFIRMED');
        let latest = await getLocalDraft(storageKey) || snapshot;
        latest = { ...snapshot, ...latest };
        if (latest.title !== snapshot.title || latest.body !== snapshot.body) {
          const second = await this.repository.saveDraft({
            letterId: snapshot.letterId,
            title: latest.title?.trim() || 'Sin título',
            body: latest.body || '',
            expectedRevision: result.draft.revision || snapshot.revision || 1
          }, requestOptions);
          if (second.status === 'not_found') throw new ApiError('El borrador ya no existe en el servidor.', 404, 'DRAFT_NOT_FOUND');
          if (second.status === 'discarded') {
            this.discardedDraftIds.add(snapshot.letterId);
            await this.clearLocalDraftForLetter(snapshot.letterId, storageKey);
            return { status: 'discarded' };
          }
          if (second.status === 'conflict') {
            if (second.draft?.id === snapshot.letterId && second.draft.status === 'draft' && second.draft.title === (latest.title?.trim() || 'Sin título') && second.draft.body === (latest.body || '')) {
              return storeSynced(second.draft, latest, storageKey);
            }
            await putLocalDraft({ key: storageKey, ...latest, conflict: true, localOnly: true, pendingSync: true, saving: false });
            return { status: 'conflict' };
          }
          if (second.status !== 'saved' || !second.draft) throw new ApiError('El servidor no confirmó los últimos cambios.', 502, 'DRAFT_SAVE_UNCONFIRMED');
          return storeSynced(second.draft, latest, storageKey);
        }
        return storeSynced(result.draft, latest, storageKey);
      } catch (error) {
        // Un ID purgado, perdido o inaccesible se reemplaza con un borrador nuevo;
        // jamás se elimina la copia local hasta confirmar la creación y guardado.
        if (error.status !== 404 && error.code !== 'DRAFT_NOT_FOUND') throw error;
        const replacementRequestId = crypto.randomUUID();
        const replacement = await this.repository.createDraft({
          creationRequestId: replacementRequestId,
          title: snapshot.title?.trim() || 'Sin título',
          body: snapshot.body || ''
        }, requestOptions);
        if (replacement.status !== 'created' || !replacement.draft?.id) throw new ApiError('No se pudo recuperar la copia local como un nuevo borrador.', 502, 'DRAFT_RECOVERY_FAILED');
        let latest = await getLocalDraft(storageKey) || snapshot;
        latest = { ...snapshot, ...latest, creationRequestId: replacementRequestId, letterId: replacement.draft.id };
        let finalDraft = replacement.draft;
        if (latest.title !== (replacement.draft.title || '') || latest.body !== (replacement.draft.body || '')) {
          const saved = await this.repository.saveDraft({
            letterId: replacement.draft.id,
            title: latest.title?.trim() || 'Sin título',
            body: latest.body || '',
            expectedRevision: replacement.draft.revision || 1
          }, requestOptions);
          if (saved.status !== 'saved' || !saved.draft) throw new ApiError('Se recuperó el borrador, pero falta confirmar la última edición.', 502, 'DRAFT_RECOVERY_SAVE_FAILED');
          finalDraft = saved.draft;
        }
        const oldStorageKey = storageKey;
        const targetKey = this.localDraftKeyFor(`letter:${finalDraft.id}`);
        const persisted = { ...latest, letterId: finalDraft.id, revision: finalDraft.revision || 1, saving: false, saved: true, localOnly: false, pendingSync: false, conflict: false };
        await putLocalDraft({ key: targetKey, ...persisted });
        if (oldStorageKey !== targetKey) {
          this.draftIdentity.set(oldStorageKey, targetKey);
          await deleteLocalDraft(oldStorageKey);
        }
        const currentMatches = this.state.editor && (this.state.editor.letterId === snapshot.letterId || this.state.editor.creationRequestId === snapshot.creationRequestId);
        if (currentMatches) {
          this.localDraftKey = targetKey;
          this.state.editor = persisted;
          if (this.state.route === 'write') this.updateSaveStatus('Borrador recuperado y guardado');
        }
        try { localStorage.removeItem(this.emergencyDraftStorageKey()); } catch {}
        this.invalidateRouteCache();
        return { status: 'saved', draft: finalDraft, recovered: true };
      }
    }

    updateSaveStatus(text) {
      const status = this.root.querySelector('#save-status');
      if (status) status.textContent = text;
    }
}
