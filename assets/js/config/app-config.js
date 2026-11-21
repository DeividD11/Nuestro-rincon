/** Configuración pública: estas dos constantes no son secretos. */
const e2eConfig = globalThis.__NR_E2E_CONFIG__ && typeof globalThis.__NR_E2E_CONFIG__ === 'object'
  ? globalThis.__NR_E2E_CONFIG__
  : {};

export const APP_CONFIG = Object.freeze({
  name: 'Nuestro Rincón',
  supabaseUrl: typeof e2eConfig.supabaseUrl === 'string' ? e2eConfig.supabaseUrl : 'https://tiqbmuubpbmxqvtkcdhq.supabase.co',
  publishableKey: typeof e2eConfig.publishableKey === 'string' ? e2eConfig.publishableKey : 'sb_publishable_ZOBe7jIgdkDM4NUp3H4a8A_yIeM5XfS',
  authFunction: 'auth-api',
  lettersFunction: 'letters-api',
  refreshStorageKey: 'nuestro-rincon.refresh.v1',
  locale: 'es-CO',
  timeZone: 'America/Bogota'
});
