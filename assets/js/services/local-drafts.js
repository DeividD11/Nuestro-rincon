const DB_NAME = 'nuestro-rincon-local';
const STORE = 'drafts';

function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'key' });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export async function putLocalDraft(draft) {
  try {
    const db = await openDatabase();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put({ ...draft, savedAt: draft.savedAt || new Date().toISOString() });
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  } catch (error) {
    console.warn('No se pudo guardar la copia local del borrador.', error);
  }
}

export async function getLocalDraft(key) {
  try {
    const db = await openDatabase();
    const value = await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readonly');
      const request = tx.objectStore(STORE).get(key);
      request.onsuccess = () => resolve(request.result || null);
      request.onerror = () => reject(request.error);
    });
    db.close();
    return value;
  } catch { return null; }
}

export async function deleteLocalDraft(key) {
  try {
    const db = await openDatabase();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).delete(key);
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  } catch { /* La copia local expira al limpiar datos del sitio. */ }
}


export async function getLocalDraftsForUser(userId) {
  if (!userId) return [];
  try {
    const db = await openDatabase();
    const values = await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readonly');
      const request = tx.objectStore(STORE).getAll();
      request.onsuccess = () => resolve(request.result || []);
      request.onerror = () => reject(request.error);
    });
    db.close();
    const prefix = `${userId}:`;
    return values.filter(item => typeof item?.key === 'string' && item.key.startsWith(prefix))
      .sort((a, b) => new Date(a.savedAt || 0).getTime() - new Date(b.savedAt || 0).getTime());
  } catch { return []; }
}

export async function deleteLocalDraftsForUser(userId) {
  if (!userId) return;
  const drafts = await getLocalDraftsForUser(userId);
  try {
    const db = await openDatabase();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      const store = tx.objectStore(STORE);
      drafts.forEach(item => store.delete(item.key));
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  } catch { /* La limpieza local se reintentará al cerrar la sesión. */ }
}
