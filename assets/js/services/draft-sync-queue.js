/** Cola serial por clave para evitar escrituras concurrentes de una misma cuenta. */
export class DraftSyncQueue {
  constructor() {
    this.queues = new Map();
  }

  enqueue(key, operation) {
    if (typeof key !== 'string' || !key || typeof operation !== 'function') {
      return Promise.reject(new TypeError('DRAFT_QUEUE_INPUT_INVALID'));
    }
    const previous = this.queues.get(key) || Promise.resolve();
    const next = previous.catch(() => {}).then(operation);
    this.queues.set(key, next);
    next.finally(() => {
      if (this.queues.get(key) === next) this.queues.delete(key);
    }).catch(() => {});
    return next;
  }

  isPending(key) {
    return this.queues.has(key);
  }

  clear() {
    // No cancela una operación que ya está en vuelo; solo elimina referencias.
    // Las tareas validan la identidad de cuenta antes de aplicar su resultado.
    this.queues.clear();
  }
}
