import { getLocalDraft, putLocalDraft, deleteLocalDraft } from './local-drafts.js';
import { ApiError } from './api-client.js';

/** Sincronización remota serializada de borradores. El controlador se entrega
 * explícitamente como adaptador para reutilizar estado y operaciones de UI sin
 * volver a concentrar persistencia en DraftController. */
export async function syncDraftSnapshot(controller, initialSnapshot, initialStorageKey, options = {}) {
  if (!initialSnapshot || !navigator.onLine) return { status: 'local' };
  if (controller.discardedLocalDraftKeys?.has(initialStorageKey)) return { status: 'discarded' };
  if (!initialSnapshot.letterId && !controller.hasDraftBody(initialSnapshot.body)) {
    await controller.clearEmptyNewDraft(initialStorageKey);
    return { status: 'empty' };
  }
  if (initialSnapshot.parentLetterId) return controller.hasDraftBody(initialSnapshot.body) ? { status: 'local' } : { status: 'empty' };
  let storageKey = controller.draftIdentity.get(initialStorageKey) || initialStorageKey;
  let snapshot = { ...initialSnapshot };
  if (snapshot.letterId && controller.discardedDraftIds.has(snapshot.letterId)) {
    await controller.clearLocalDraftForLetter(snapshot.letterId, storageKey);
    return { status: 'discarded' };
  }
  const local = await getLocalDraft(storageKey);
  if (local && (new Date(local.savedAt || 0).getTime() >= new Date(snapshot.savedAt || 0).getTime())) snapshot = { ...snapshot, ...local };
  // También se valida después de fusionar IndexedDB: un snapshot local viejo
  // y vacío no puede crear un nuevo registro en el servidor.
  if (!snapshot.letterId && !controller.hasDraftBody(snapshot.body)) {
    await controller.clearEmptyNewDraft(storageKey);
    return { status: 'empty' };
  }
  const requestOptions = options.keepalive ? { keepalive: true, timeoutMs: 7000 } : {};
  const title = snapshot.title?.trim() || 'Sin título';
  
  const storeSynced = async (draft, latestSnapshot, currentStorageKey) => {
    if (controller.discardedLocalDraftKeys?.has(initialStorageKey) || controller.discardedLocalDraftKeys?.has(currentStorageKey)) {
      controller.discardedDraftIds.add(draft.id);
      try {
        const moved = await controller.repository.moveToTrash(draft.id);
        if (!['trashed', 'already_trashed'].includes(moved?.status)) throw new Error('DRAFT_DISCARD_SYNC_RACE');
      } catch (error) {
        // No se elimina la copia local si no se confirma el retiro remoto.
        throw error;
      }
      await controller.clearLocalDraftForLetter(draft.id, currentStorageKey);
      return { status: 'discarded' };
    }
    if (controller.discardedDraftIds.has(draft.id)) {
      await controller.clearLocalDraftForLetter(draft.id, currentStorageKey);
      return { status: 'discarded' };
    }
    const targetKey = controller.localDraftKeyFor(`letter:${draft.id}`);
    const localLatest = await getLocalDraft(currentStorageKey);
    const emergencyLatest = controller.readEmergencyDraft(currentStorageKey);
    const freshest = [latestSnapshot, localLatest, emergencyLatest].filter(Boolean)
      .sort((a,b) => new Date(b.savedAt || 0).getTime() - new Date(a.savedAt || 0).getTime())[0] || latestSnapshot;
    const currentMatches = controller.state.editor && (
      controller.state.editor.creationRequestId === latestSnapshot.creationRequestId ||
      controller.state.editor.letterId === latestSnapshot.letterId ||
      controller.state.editor.letterId === draft.id
    );
    const liveEditor = currentMatches && controller.state.route === 'write'
      ? { ...controller.state.editor, ...controller.readEditorFromDom() }
      : null;
    const liveIsNewer = Boolean(liveEditor && (
      liveEditor.title !== freshest.title || liveEditor.body !== freshest.body ||
      controller.editorInputVersion > Number(freshest.inputVersion || 0)
    ));
    const source = liveIsNewer ? { ...freshest, ...liveEditor, inputVersion: controller.editorInputVersion } : freshest;
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
      controller.draftIdentity.set(currentStorageKey, targetKey);
      await deleteLocalDraft(currentStorageKey);
    }
    if (currentMatches) {
      controller.localDraftKey = targetKey;
      controller.state.editor = persisted;
      if (controller.state.route === 'write') controller.updateSaveStatus(liveIsNewer ? 'Sincronizando los últimos cambios…' : 'Guardado en la nube');
    } else if (controller.localDraftKey === currentStorageKey) {
      controller.localDraftKey = null;
    }
    if (liveIsNewer) {
      controller.persistEmergencyDraft(persisted);
      controller.enqueueDraftSync(persisted, targetKey).catch(() => {});
    } else if (emergencyLatest && !(controller.state.editor && controller.state.route === 'write' && !currentMatches)) {
      // No borres la emergencia de una carta diferente que se esté editando.
      try { localStorage.removeItem(controller.emergencyDraftStorageKey()); } catch {}
    }
    controller.invalidateRouteCache();
    const preview = controller.state.localDraftPreview;
    if (preview && (preview.creationRequestId === persisted.creationRequestId || preview.localDraftKey === currentStorageKey)) {
      // Mantén la tarjeta optimista hasta que la consulta remota la devuelva;
      // así no desaparece entre el ACK de guardado y la actualización de lista.
      controller.state.localDraftPreview = {
        ...preview, id: draft.id, letterId: draft.id, localDraftKey: targetKey,
        localOnly: false, pendingSync: false, saved: true,
        updated_at: draft.updated_at || new Date().toISOString()
      };
      if (controller.state.route === 'drafts') {
        const refreshId = ++controller.routeRequestId;
        controller.refreshRouteData('drafts', controller.routeCacheKey('drafts'), refreshId, true).catch(() => {});
      }
    }
    return { status: 'saved', draft };
  };
  
  if (!snapshot.letterId) {
    let creationRequestId = snapshot.creationRequestId || crypto.randomUUID();
    let created = await controller.repository.createDraft({ creationRequestId, title, body: snapshot.body || '' }, requestOptions);
    if (created?.status === 'discarded' && created?.draft?.id) {
      controller.discardedDraftIds.add(created.draft.id);
      await controller.clearLocalDraftForLetter(created.draft.id, storageKey);
      return { status: 'discarded' };
    }
    if (created?.draft?.status === 'purged') {
      creationRequestId = crypto.randomUUID();
      const recoveredLocal = { ...snapshot, creationRequestId, pendingSync: true, localOnly: true, savedAt: new Date().toISOString() };
      await putLocalDraft({ key: storageKey, ...recoveredLocal });
      controller.persistEmergencyDraft(recoveredLocal);
      created = await controller.repository.createDraft({ creationRequestId, title, body: snapshot.body || '' }, requestOptions);
    }
    if (created.status !== 'created' || !created.draft?.id || created.draft.status !== 'draft') throw new ApiError('El servidor no confirmó la creación de un borrador nuevo.', 502, 'DRAFT_CREATE_UNCONFIRMED');
    let latest = await getLocalDraft(storageKey) || snapshot;
    const emergencyLatest = controller.readEmergencyDraft(storageKey);
    if (emergencyLatest && new Date(emergencyLatest.savedAt || 0) > new Date(latest.savedAt || 0)) latest = { ...latest, ...emergencyLatest };
    latest = { ...snapshot, ...latest, letterId: created.draft.id, creationRequestId, revision: created.draft.revision || 1 };
    if (latest.title !== title || latest.body !== (snapshot.body || '')) {
      const saved = await controller.repository.saveDraft({ letterId: created.draft.id, title: latest.title?.trim() || 'Sin título', body: latest.body || '', expectedRevision: created.draft.revision || 1 }, requestOptions);
      if (saved.status === 'not_found') throw new ApiError('El servidor creó el borrador pero no lo encontró al guardar los últimos cambios.', 404, 'DRAFT_NOT_FOUND');
      if (saved.status !== 'saved') throw new ApiError('No se pudieron guardar los últimos cambios del borrador.', 502, 'DRAFT_SAVE_UNCONFIRMED');
      return storeSynced(saved.draft || created.draft, latest, storageKey);
    }
    return storeSynced(created.draft, latest, storageKey);
  }
  
  try {
    const result = await controller.repository.saveDraft({
      letterId: snapshot.letterId,
      title,
      body: snapshot.body || '',
      expectedRevision: snapshot.revision || 1
    }, requestOptions);
    if (result.status === 'discarded') {
      controller.discardedDraftIds.add(snapshot.letterId);
      await controller.clearLocalDraftForLetter(snapshot.letterId, storageKey);
      return { status: 'discarded' };
    }
    if (result.status === 'conflict') {
      const remote = result.draft;
      if (remote?.id === snapshot.letterId && remote.status === 'draft' && remote.title === title && remote.body === (snapshot.body || '')) {
        return storeSynced(remote, snapshot, storageKey);
      }
      const conflicted = { ...snapshot, conflict: true, localOnly: true, pendingSync: true, saved: true, saving: false };
      await putLocalDraft({ key: storageKey, ...conflicted });
      if (controller.state.editor?.letterId === snapshot.letterId) controller.state.editor = conflicted;
      return { status: 'conflict' };
    }
    if (result.status === 'not_found') throw new ApiError('El borrador ya no existe en el servidor.', 404, 'DRAFT_NOT_FOUND');
    if (result.status !== 'saved' || !result.draft) throw new ApiError('El servidor no confirmó el guardado del borrador.', 502, 'DRAFT_SAVE_UNCONFIRMED');
    let latest = await getLocalDraft(storageKey) || snapshot;
    latest = { ...snapshot, ...latest };
    if (latest.title !== snapshot.title || latest.body !== snapshot.body) {
      const second = await controller.repository.saveDraft({
        letterId: snapshot.letterId,
        title: latest.title?.trim() || 'Sin título',
        body: latest.body || '',
        expectedRevision: result.draft.revision || snapshot.revision || 1
      }, requestOptions);
      if (second.status === 'not_found') throw new ApiError('El borrador ya no existe en el servidor.', 404, 'DRAFT_NOT_FOUND');
      if (second.status === 'discarded') {
        controller.discardedDraftIds.add(snapshot.letterId);
        await controller.clearLocalDraftForLetter(snapshot.letterId, storageKey);
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
    const replacement = await controller.repository.createDraft({
      creationRequestId: replacementRequestId,
      title: snapshot.title?.trim() || 'Sin título',
      body: snapshot.body || ''
    }, requestOptions);
    if (replacement.status !== 'created' || !replacement.draft?.id) throw new ApiError('No se pudo recuperar la copia local como un nuevo borrador.', 502, 'DRAFT_RECOVERY_FAILED');
    let latest = await getLocalDraft(storageKey) || snapshot;
    latest = { ...snapshot, ...latest, creationRequestId: replacementRequestId, letterId: replacement.draft.id };
    let finalDraft = replacement.draft;
    if (latest.title !== (replacement.draft.title || '') || latest.body !== (replacement.draft.body || '')) {
      const saved = await controller.repository.saveDraft({
        letterId: replacement.draft.id,
        title: latest.title?.trim() || 'Sin título',
        body: latest.body || '',
        expectedRevision: replacement.draft.revision || 1
      }, requestOptions);
      if (saved.status !== 'saved' || !saved.draft) throw new ApiError('Se recuperó el borrador, pero falta confirmar la última edición.', 502, 'DRAFT_RECOVERY_SAVE_FAILED');
      finalDraft = saved.draft;
    }
    const oldStorageKey = storageKey;
    const targetKey = controller.localDraftKeyFor(`letter:${finalDraft.id}`);
    const persisted = { ...latest, letterId: finalDraft.id, revision: finalDraft.revision || 1, saving: false, saved: true, localOnly: false, pendingSync: false, conflict: false };
    await putLocalDraft({ key: targetKey, ...persisted });
    if (oldStorageKey !== targetKey) {
      controller.draftIdentity.set(oldStorageKey, targetKey);
      await deleteLocalDraft(oldStorageKey);
    }
    const currentMatches = controller.state.editor && (controller.state.editor.letterId === snapshot.letterId || controller.state.editor.creationRequestId === snapshot.creationRequestId);
    if (currentMatches) {
      controller.localDraftKey = targetKey;
      controller.state.editor = persisted;
      if (controller.state.route === 'write') controller.updateSaveStatus('Borrador recuperado y guardado');
    }
    try { localStorage.removeItem(controller.emergencyDraftStorageKey()); } catch {}
    controller.invalidateRouteCache();
    return { status: 'saved', draft: finalDraft, recovered: true };
  }

}
