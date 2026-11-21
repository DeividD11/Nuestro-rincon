/**
 * Poller sensible a actividad y visibilidad.
 * - No trabaja en pestañas ocultas ni sin conexión.
 * - Se despierta al regresar a la pestaña, con una protección contra ráfagas.
 * - Usa intervalos distintos para actividad e inactividad y backoff exponencial.
 */
export class AdaptivePoller {
  constructor({
    task,
    enabled = () => true,
    activeIntervalMs = 120_000,
    idleIntervalMs = 600_000,
    idleAfterMs = 120_000,
    minRefreshGapMs = 30_000,
    maxBackoffMs = 900_000,
    runImmediately = true,
    onError = () => {}
  } = {}) {
    if (typeof task !== 'function') throw new TypeError('POLL_TASK_REQUIRED');
    this.task = task;
    this.enabled = enabled;
    this.activeIntervalMs = Math.max(1_000, activeIntervalMs);
    this.idleIntervalMs = Math.max(this.activeIntervalMs, idleIntervalMs);
    this.idleAfterMs = Math.max(1_000, idleAfterMs);
    this.minRefreshGapMs = Math.max(0, minRefreshGapMs);
    this.maxBackoffMs = Math.max(this.idleIntervalMs, maxBackoffMs);
    this.runImmediately = runImmediately;
    this.onError = onError;

    this.timer = null;
    this.dueAt = 0;
    this.running = false;
    this.inFlight = false;
    this.failures = 0;
    this.lastSuccessAt = 0;
    this.lastActivityAt = Date.now();

    this.handleVisibility = () => {
      if (!document.hidden) this.wake();
      else this.clearTimer();
    };
    this.handleWake = () => this.wake();
    this.handleActivity = () => {
      this.lastActivityAt = Date.now();
      if (this.running && this.timer && this.canRun()) {
        const activeDueAt = Date.now() + this.nextDelay(true);
        if (activeDueAt < this.dueAt) this.schedule(activeDueAt - Date.now());
      }
    };
  }

  start() {
    if (this.running) return;
    this.running = true;
    document.addEventListener('visibilitychange', this.handleVisibility);
    window.addEventListener('focus', this.handleWake);
    window.addEventListener('online', this.handleWake);
    for (const eventName of ['pointerdown', 'keydown', 'touchstart', 'scroll']) {
      window.addEventListener(eventName, this.handleActivity, { passive: true });
    }
    this.schedule(this.runImmediately ? 0 : this.nextDelay());
  }

  stop() {
    if (!this.running) return;
    this.running = false;
    this.clearTimer();
    document.removeEventListener('visibilitychange', this.handleVisibility);
    window.removeEventListener('focus', this.handleWake);
    window.removeEventListener('online', this.handleWake);
    for (const eventName of ['pointerdown', 'keydown', 'touchstart', 'scroll']) {
      window.removeEventListener(eventName, this.handleActivity);
    }
  }

  clearTimer() {
    if (this.timer !== null) window.clearTimeout(this.timer);
    this.timer = null;
    this.dueAt = 0;
  }

  canRun() {
    return this.running && this.enabled() && !document.hidden && navigator.onLine !== false;
  }

  nextDelay(forceActive = false) {
    const idle = !forceActive && Date.now() - this.lastActivityAt >= this.idleAfterMs;
    const base = idle ? this.idleIntervalMs : this.activeIntervalMs;
    return Math.min(this.maxBackoffMs, base * (2 ** Math.min(this.failures, 6)));
  }

  schedule(delayMs) {
    if (!this.running) return;
    this.clearTimer();
    const delay = Math.max(0, delayMs);
    this.dueAt = Date.now() + delay;
    this.timer = window.setTimeout(() => {
      this.timer = null;
      this.dueAt = 0;
      this.tick().catch(() => {});
    }, delay);
  }

  wake() {
    if (!this.canRun()) return;
    const stale = Date.now() - this.lastSuccessAt >= this.minRefreshGapMs;
    if (stale && !this.inFlight) this.schedule(0);
    else if (!this.timer && !this.inFlight) this.schedule(this.nextDelay());
  }

  async tick() {
    if (!this.canRun()) return;
    if (this.inFlight) {
      this.schedule(1_000);
      return;
    }
    this.inFlight = true;
    try {
      const result = await this.task();
      if (result === false) throw new Error('POLL_TASK_UNCONFIRMED');
      this.failures = 0;
      this.lastSuccessAt = Date.now();
    } catch (error) {
      this.failures = Math.min(this.failures + 1, 6);
      try { this.onError(error); } catch { /* Un manejador de errores no rompe el poller. */ }
    } finally {
      this.inFlight = false;
      if (this.running && this.canRun()) this.schedule(this.nextDelay());
    }
  }
}
