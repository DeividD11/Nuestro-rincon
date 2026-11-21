import { test, expect } from '@playwright/test';

const themes = ['light', 'dark'];
const screens = [
  'login', 'register', 'recovery', 'inbox', 'write', 'notifications', 'settings'
];

async function renderFixture(page, screen, theme) {
  await page.goto('/');
  await page.evaluate(async ({ screen, theme }) => {
    document.documentElement.dataset.theme = theme;
    const { AppView } = await import('/assets/js/views/app-view.js');
    const view = new AppView(document.querySelector('#app'));

    if (screen === 'login') return view.renderLogin();
    if (screen === 'register') return view.renderRegister();
    if (screen === 'recovery') return view.renderRecovery();

    const state = {
      route: screen,
      routeLoading: false,
      routeError: null,
      routeNotice: null,
      user: { id: 'a11y-test-user', username: 'prueba', displayName: 'Cuenta de prueba', email: '' },
      dashboard: { unread: 0, received: 0, sent: 0, drafts: 0, recent: [] },
      notifications: [],
      mobileNavOpen: false,
      settings: {
        theme,
        time_zone: 'America/Bogota',
        in_app_notifications_enabled: true
      },
      sessions: [],
      invitation: { canCreate: true, accountCount: 1, pending: false },
      editor: { letterId: null, title: '', body: '', saving: false, saved: false },
      letters: [],
      pagination: { hasMore: false, loading: false, loadedCount: 0 },
      notificationPagination: { hasMore: false, loading: false, loadedCount: 0 },
      search: '',
      selectedLetter: null,
      pendingLetterActions: new Set()
    };
    view.renderShell(state);
  }, { screen, theme });
}

for (const theme of themes) {
  for (const screen of screens) {
    test(`${screen} · tema ${theme} · WCAG 2.2 A/AA`, async ({ page }) => {
      await renderFixture(page, screen, theme);
      await page.addScriptTag({ url: '/node_modules/axe-core/axe.min.js' });
      const results = await page.evaluate(async () => window.axe.run(document, {
        runOnly: {
          type: 'tag',
          values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']
        }
      }));
      const violations = results.violations.map(item => ({
        id: item.id,
        impact: item.impact,
        description: item.description,
        help: item.help,
        nodes: item.nodes.map(node => ({ target: node.target, summary: node.failureSummary }))
      }));
      expect(violations, JSON.stringify(violations, null, 2)).toEqual([]);
    });
  }
}

test('el pie del editor permanece dentro de la tarjeta y no se desborda en resoluciones comunes', async ({ page }) => {
  for (const width of [390, 768, 1024, 1280, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    await renderFixture(page, 'write', 'light');
    const metrics = await page.evaluate(() => {
      const footer = document.querySelector('.editor-footer');
      const shell = document.querySelector('.editor-shell');
      const sidebar = document.querySelector('.sidebar');
      const footerRect = footer.getBoundingClientRect();
      const shellRect = shell.getBoundingClientRect();
      const mainRect = document.querySelector('.main-area').getBoundingClientRect();
      return {
        insideShell: shell.contains(footer),
        footerWithinShell: footerRect.left >= shellRect.left - 1 && footerRect.right <= shellRect.right + 1,
        footerWithinMain: footerRect.left >= mainRect.left - 1,
        documentOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
        sidebarRight: sidebar.getBoundingClientRect().right,
        footerLeft: footerRect.left
      };
    });
    expect(metrics.insideShell, `ancho ${width}: el footer debe pertenecer a editor-shell`).toBe(true);
    expect(metrics.footerWithinShell, `ancho ${width}: el footer debe quedar dentro de editor-shell`).toBe(true);
    expect(metrics.footerWithinMain, `ancho ${width}: el footer debe estar dentro del área principal`).toBe(true);
    expect(metrics.documentOverflow, `ancho ${width}: no debe existir desbordamiento horizontal`).toBe(false);
  }
});

test('los controles de formato y las acciones del editor son alcanzables mediante teclado', async ({ page }) => {
  await renderFixture(page, 'write', 'light');
  const toolbarButtons = page.locator('.editor-toolbar button');
  await expect(toolbarButtons).toHaveCount(6);
  for (let index = 0; index < await toolbarButtons.count(); index++) {
    await toolbarButtons.nth(index).focus();
    await expect(toolbarButtons.nth(index)).toBeFocused();
    await expect(toolbarButtons.nth(index)).toHaveAttribute('aria-label', /.+/);
  }
  await expect(page.locator('[data-action="save-draft"]')).toHaveAttribute('type', 'button');
  await expect(page.locator('[data-action="preview-send"]')).toHaveAttribute('type', 'button');
});
