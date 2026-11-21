import { APP_CONFIG } from '../config/app-config.js';

export class SessionService {
  constructor(api) {
    this.api = api;
    this.accessToken = null;
    this.user = null;
    this.sessionId = null;
    this.refreshToken = sessionStorage.getItem(APP_CONFIG.refreshStorageKey) || null;
    this.listeners = new Set();
    this.refreshPromise = null;
    this.sessionEpoch = 0;
  }

  subscribe(listener) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  notify() { this.listeners.forEach(listener => listener(this.user)); }
  setSession(payload) {
    this.sessionEpoch++;
    this.accessToken = payload.accessToken;
    this.user = payload.user;
    if (payload.sessionId) this.sessionId = payload.sessionId;
    if (payload.refreshToken) {
      this.refreshToken = payload.refreshToken;
      sessionStorage.setItem(APP_CONFIG.refreshStorageKey, payload.refreshToken);
    }
    this.notify();
  }

  refreshSession() {
    if (this.refreshPromise) return this.refreshPromise;
    const refreshToken = this.refreshToken;
    if (!refreshToken) return Promise.reject(new Error('SESSION_REFRESH_UNAVAILABLE'));

    // Todos los 401 de una pestaña comparten una única rotación. Si cada
    // petición rotara el mismo refresh token en paralelo, la segunda
    // rotación se interpretaría correctamente como replay y revocaría sesión.
    const epoch = this.sessionEpoch;
    this.refreshPromise = this.api.auth('refresh', { refreshToken }).then(payload => {
      // No resucitar una sesión si hubo logout o un nuevo login mientras
      // la renovación estaba en curso.
      if (this.sessionEpoch === epoch && this.refreshToken === refreshToken) this.setSession(payload);
      return payload;
    }).finally(() => {
      this.refreshPromise = null;
    });
    return this.refreshPromise;
  }

  async restore() {
    if (!this.refreshToken) return false;
    try {
      await this.refreshSession();
      return Boolean(this.accessToken && this.user);
    } catch {
      this.clearSession();
      return false;
    }
  }

  async login(identifier, password) {
    const payload = await this.api.auth('login', { identifier, password });
    this.setSession(payload);
    return payload;
  }

  async register(account) {
    const payload = await this.api.auth('register', account);
    // La cuenta puede haberse creado y la sesión no. En ese caso no se debe
    // fabricar un estado autenticado; el controlador muestra el código local
    // y permite volver a iniciar sesión o reintentar con la misma idempotencia.
    if (payload.authenticated === true && payload.accessToken && payload.refreshToken) {
      this.setSession(payload);
    }
    return payload;
  }

  async logout() {
    try { await this.api.auth('logout'); } finally { this.clearSession(); }
  }

  clearSession() {
    this.sessionEpoch++;
    this.accessToken = null;
    this.user = null;
    this.sessionId = null;
    this.refreshToken = null;
    sessionStorage.removeItem(APP_CONFIG.refreshStorageKey);
    this.notify();
  }
}
