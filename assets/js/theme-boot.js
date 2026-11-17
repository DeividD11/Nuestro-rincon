// Aplica la última preferencia conocida antes de descargar la hoja de estilos.
// La preferencia persistente por cuenta se sincroniza después de iniciar sesión.
(() => {
  try {
    const stored = localStorage.getItem('nuestro-rincon:theme:last');
    const preference = ['light', 'dark', 'system'].includes(stored) ? stored : 'system';
    const systemDark = window.matchMedia?.('(prefers-color-scheme: dark)')?.matches ?? false;
    const resolved = preference === 'system' ? (systemDark ? 'dark' : 'light') : preference;
    const root = document.documentElement;
    root.dataset.theme = resolved;
    root.dataset.themePreference = preference;
    root.style.colorScheme = resolved;
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.content = resolved === 'dark' ? '#171615' : '#f4eee5';
  } catch {
    document.documentElement.dataset.theme = 'light';
  }
})();
