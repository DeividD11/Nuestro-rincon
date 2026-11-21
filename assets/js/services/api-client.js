import { APP_CONFIG } from '../config/app-config.js';

export class ApiError extends Error {
  constructor(message, status = 0, code = 'API_ERROR', details = null) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

const wait = ms => new Promise(resolve => window.setTimeout(resolve, ms));
const RETRYABLE_READ_ACTIONS = new Set(['dashboard', 'list', 'get', 'notifications', 'settings:get', 'sessions']);

export class ApiClient {
  constructor(sessionService) {
    this.sessionService = sessionService;
    this.requestTimeoutMs = 12000;
  }

  async call(functionName, payload, options = {}) {
    const headers = {
      'Content-Type': 'application/json',
      'apikey': APP_CONFIG.publishableKey
    };
    const token = options.public ? null : this.sessionService?.accessToken;
    if (token) headers.Authorization = `Bearer ${token}`;

    // Las lecturas idempotentes admiten un reintento de red. Las escrituras
    // solo pueden repetirse ante 401 después de renovar la sesión: requireSession
    // rechaza la petición antes de ejecutar su acción y no puede duplicarla.
    const maxAttempts = options.safeToRetry ? 2 : 1;
    let response = null;
    let lastTransportError = null;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const controller = new AbortController();
      const timeout = window.setTimeout(() => controller.abort(), options.timeoutMs || this.requestTimeoutMs);
      try {
        const requestBody = JSON.stringify(payload);
        const keepalive = options.keepalive === true && requestBody.length <= 60000;
        response = await fetch(`${APP_CONFIG.supabaseUrl}/functions/v1/${functionName}`, {
          method: 'POST', headers, body: requestBody, credentials: 'omit',
          cache: 'no-store', signal: controller.signal, keepalive
        });
        lastTransportError = null;
      } catch (error) {
        lastTransportError = error;
        const retryable = options.safeToRetry && attempt + 1 < maxAttempts;
        if (retryable && !(typeof navigator !== 'undefined' && navigator.onLine === false)) {
          await wait(350 * (attempt + 1));
          continue;
        }
        if (typeof navigator !== 'undefined' && navigator.onLine === false) {
          throw new ApiError('Tu dispositivo parece estar sin conexión a Internet. Comprueba la conexión y vuelve a intentarlo.', 0, 'NETWORK_OFFLINE');
        }
        if (error?.name === 'AbortError' || error?.name === 'TimeoutError') {
          throw new ApiError('La solicitud tardó demasiado en responder. La sección no se quedó bloqueada; puedes volver a intentarlo.', 0, 'REQUEST_TIMEOUT', { functionName });
        }
        const message = error instanceof TypeError
          ? 'El navegador no pudo completar la solicitud a Supabase. Puede tratarse de un bloqueo CORS, un problema de DNS o una interrupción temporal del servicio.'
          : 'No se recibió respuesta de Supabase. Vuelve a intentarlo.';
        throw new ApiError(message, 0, 'NETWORK_ERROR', {
          functionName,
          cause: error instanceof Error ? error.name : 'UnknownError'
        });
      } finally {
        window.clearTimeout(timeout);
      }

      if (options.safeToRetry && attempt + 1 < maxAttempts && (response.status === 429 || response.status === 502 || response.status === 503 || response.status === 504)) {
        await wait(350 * (attempt + 1));
        continue;
      }
      break;
    }

    if (!response) {
      throw new ApiError('No se recibió respuesta de Supabase. Vuelve a intentarlo.', 0, 'NETWORK_ERROR', { cause: lastTransportError?.name || 'UnknownError' });
    }

    const raw = await response.text();
    let data = {};
    try { data = raw ? JSON.parse(raw) : {}; } catch { data = { message: 'Respuesta no válida del servidor.' }; }
    if (!response.ok || data.ok === false) {
      if (response.status === 401 && functionName === APP_CONFIG.lettersFunction && !options.retried) {
        // Si otra petición ya renovó el token mientras esta solicitud estaba
        // en vuelo, reutiliza el token nuevo en vez de rotar otra vez el mismo.
        if (token && this.sessionService?.accessToken && token !== this.sessionService.accessToken) {
          return this.call(functionName, payload, { ...options, retried: true });
        }
        if (this.sessionService?.refreshToken && this.sessionService?.refreshSession) {
          try {
            await this.sessionService.refreshSession();
            return this.call(functionName, payload, { ...options, retried: true });
          } catch { /* La sesión ya no se puede renovar; se propaga el error original. */ }
        }
      }
      throw new ApiError(data.message || 'La operación no se pudo completar.', response.status, data.code || 'REQUEST_FAILED', data.details || null);
    }
    return data;
  }

  auth(action, payload = {}, options = {}) {
    const publicActions = new Set(['login', 'register', 'recover-with-code', 'refresh']);
    // El registro y la rotación de códigos llevan requestId + hash de contenido;
    // por ello, repetir la misma escritura es idempotente incluso si el primer
    // resultado se confirmó en PostgreSQL pero se perdió la respuesta HTTP.
    const idempotentActions = new Set(['register', 'recovery-code:rotate']);
    return this.call(APP_CONFIG.authFunction, { action, ...payload }, {
      public: publicActions.has(action),
      safeToRetry: idempotentActions.has(action),
      ...options
    });
  }

  letters(action, payload = {}, options = {}) {
    return this.call(APP_CONFIG.lettersFunction, { action, ...payload }, { safeToRetry: RETRYABLE_READ_ACTIONS.has(action), ...options });
  }
}
