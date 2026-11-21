import { putLocalDraft, getLocalDraft, deleteLocalDraft } from './local-drafts.js';
import { plainTextFromHtml } from '../utils/dom.js';

/** Persistencia local y recuperación de borradores; recibe el contexto compartido de la aplicación. */
export function hasDraftBody(controller, body) {
      return plainTextFromHtml(String(body || '')).trim().length > 0;
    }

export async function clearEmptyNewDraft(controller, storageKey) {
      if (!storageKey) return;
      await deleteLocalDraft(storageKey).catch(() => {});
      try {
        const emergency = JSON.parse(localStorage.getItem(controller.emergencyDraftStorageKey()) || 'null');
        if (emergency && emergency.key === storageKey && !emergency.letterId) {
          localStorage.removeItem(controller.emergencyDraftStorageKey());
        }
      } catch { /* No se conserva una instantánea vacía si el almacenamiento está dañado. */ }
    }

export function emergencyDraftStorageKey(controller) {
      return `nuestro-rincon:draft-emergency:${controller.session?.user?.id || 'guest'}`;
    }

export function persistEmergencyDraft(controller, snapshot = null) {
      const editor = snapshot || (controller.state.editor ? { ...controller.state.editor, ...controller.readEditorFromDom() } : null);
      if (!editor || editor.parentLetterId) return;
      if (!editor.letterId && !controller.hasDraftBody(editor.body)) return;
      const userId = controller.session?.user?.id;
      if (!userId) return;
      try {
        localStorage.setItem(controller.emergencyDraftStorageKey(), JSON.stringify({
          ...editor,
          key: controller.localDraftKey || controller.localDraftKeyFor(editor.letterId ? `letter:${editor.letterId}` : 'new'),
          userId,
          pendingSync: true,
          savedAt: editor.savedAt || new Date().toISOString()
        }));
      } catch { /* IndexedDB conserva la copia principal. */ }
    }

export function readEmergencyDraft(controller, expectedKey = null) {
      const userId = controller.session?.user?.id;
      if (!userId) return null;
      try {
        const raw = localStorage.getItem(controller.emergencyDraftStorageKey());
        if (!raw) return null;
        const draft = JSON.parse(raw);
        if (draft.userId !== userId || !draft.key || draft.parentLetterId) return null;
        if (!draft.letterId && !controller.hasDraftBody(draft.body)) {
          localStorage.removeItem(controller.emergencyDraftStorageKey());
          return null;
        }
        if (expectedKey && draft.key !== expectedKey) return null;
        return { ...draft, pendingSync: true, localOnly: true };
      } catch { return null; }
    }

export async function restoreEmergencyDraft(controller) {
      const userId = controller.session?.user?.id;
      if (!userId) return;
      const draft = controller.readEmergencyDraft();
      if (!draft) return;
      if (!draft.letterId && !controller.hasDraftBody(draft.body)) {
        await controller.clearEmptyNewDraft(draft.key);
        return;
      }
      if (draft.key.startsWith(`${userId}:`)) controller.localDraftKey = draft.key;
      await putLocalDraft(draft);
    }

export async function hydrateEditorFromLocal(controller, storageKey, identity) {
      const local = await getLocalDraft(storageKey);
      if (!local || controller.state.route !== 'write' || controller.state.editor?.creationRequestId !== identity) return;
      const emergency = controller.readEmergencyDraft(storageKey);
      const newest = [local, emergency].filter(Boolean)
        .sort((a,b) => new Date(b.savedAt || 0).getTime() - new Date(a.savedAt || 0).getTime())[0];
      if (!newest) return;
      const current = controller.state.editor;
      if (new Date(newest.savedAt || 0).getTime() < new Date(current.savedAt || 0).getTime()) return;
      controller.state.editor = { ...current, ...newest, creationRequestId: newest.creationRequestId || identity };
      controller.render();
      if (controller.state.editor.pendingSync || controller.state.editor.localOnly) controller.saveDraft(true).catch(() => {});
    }

export function flushDraftOnExit(controller) {
      if (!controller.state.editor) return;
      const snapshot = { ...controller.state.editor, ...controller.readEditorFromDom(), saving: true, saved: false, pendingSync: true, localOnly: true };
      if (!snapshot.letterId && !controller.hasDraftBody(snapshot.body)) return;
      if (snapshot.parentLetterId && !controller.hasDraftBody(snapshot.body)) return;
      controller.persistEmergencyDraft(snapshot);
      const storageKey = controller.localDraftKey || controller.localDraftKeyFor(snapshot.letterId ? `letter:${snapshot.letterId}` : 'new');
      putLocalDraft({ key: storageKey, ...snapshot }).then(() => {
        if (navigator.onLine) controller.enqueueDraftSync(snapshot, storageKey, { keepalive: true }).catch(() => {});
      }).catch(() => {});
    }

export async function persistLocalDraft(controller) {
      if (!controller.state.editor) return;
      const current = controller.readEditorFromDom();
      controller.state.editor = { ...controller.state.editor, ...current, savedAt: controller.state.editor.savedAt || new Date().toISOString(), pendingSync: true, saved: false };
      const storageKey = controller.localDraftKey || controller.localDraftKeyFor(controller.state.editor.letterId ? `letter:${controller.state.editor.letterId}` : 'new');
      if (!controller.state.editor.letterId && !controller.hasDraftBody(controller.state.editor.body)) {
        await controller.clearEmptyNewDraft(storageKey);
        return;
      }
      controller.persistEmergencyDraft(controller.state.editor);
      await putLocalDraft({ key: storageKey, ...controller.state.editor, pendingSync: true });
    }

