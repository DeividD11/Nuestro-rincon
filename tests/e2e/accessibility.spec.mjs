import { test, expect } from '@playwright/test';

const themes = ['light', 'dark'];
const screens = [
  'login', 'register', 'recovery', 'inbox', 'write', 'notifications', 'settings', 'trash', 'letter'
];

async function renderFixture(page, screen, theme, options = {}) {
  await page.goto('/');
  await page.evaluate(async ({ screen, theme, error }) => {
    document.documentElement.dataset.theme = theme;
    const { AppView } = await import('/assets/js/views/app-view.js');
    const view = new AppView(document.querySelector('#app'));

    if (screen === 'login') return view.renderLogin(error);
    if (screen === 'register') return view.renderRegister(error);
    if (screen === 'recovery') return view.renderRecovery(error);
    if (screen === 'recovery-code') {
      return view.renderRecoveryCode(
        Array.from({ length: 10 }, (_, index) => `ABCD12-EFGH34-IJKL56-MNOP78-QRST90-UVWX12-${String(index).padStart(6, '0')}`),
        { bundle: true, message: 'Guarda estos códigos en un lugar seguro.' }
      );
    }

    const now = '2026-11-21T12:00:00.000Z';
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
      pushNotifications: { supported: false, configured: false, subscribed: false },
      editor: { letterId: null, title: '', body: '', saving: false, saved: false },
      letters: screen === 'trash' ? [
        {
          id: 'trash-awaiting-confirmation', title: 'Carta pendiente de confirmación', status: 'sent',
          otherName: 'Persona destinataria', isInTrash: true, purgeConfirmedAt: now, sent_at: now
        },
        {
          id: 'trash-action-pending', title: 'Carta con acción pendiente', status: 'sent',
          otherName: 'Persona destinataria', isInTrash: true, sent_at: now
        }
      ] : [],
      pagination: { hasMore: false, loading: false, loadedCount: 0 },
      notificationPagination: { hasMore: false, loading: false, loadedCount: 0 },
      search: '',
      selectedLetter: screen === 'letter' ? {
        letter: {
          id: 'selected-trash-letter', title: 'Carta seleccionada', body: '<p>Contenido de prueba.</p>',
          status: 'sent', isInTrash: true, purgeConfirmedAt: null,
          sender_id: 'other-user', senderName: 'Otra persona', recipientName: 'Cuenta de prueba',
          sent_at: now, created_at: now
        },
        thread: []
      } : null,
      pendingLetterActions: new Set(['trash-action-pending'])
    };
    view.renderShell(state);
  }, { screen, theme, error: options.error || '' });
}

async function expectAxeClean(page) {
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
}

for (const theme of themes) {
  for (const screen of screens) {
    test(`${screen} · tema ${theme} · WCAG 2.2 A/AA`, async ({ page }) => {
      await renderFixture(page, screen, theme);
      await expectAxeClean(page);
    });
  }

  for (const screen of ['login', 'register', 'recovery']) {
    test(`${screen} con error del servidor · tema ${theme} · WCAG 2.2 A/AA`, async ({ page }) => {
      await renderFixture(page, screen, theme, { error: 'No se pudo validar la información. Comprueba los datos e inténtalo de nuevo.' });
      const formError = page.locator('.form-error[role="alert"]');
      await expect(formError).toBeVisible();
      await expect(formError).toContainText('No se pudo validar la información');
      await expectAxeClean(page);
    });
  }

  test(`códigos de recuperación · tema ${theme} · WCAG 2.2 A/AA`, async ({ page }) => {
    await renderFixture(page, 'recovery-code', theme);
    await expect(page.getByRole('heading', { name: 'Tus diez códigos de respaldo' })).toBeVisible();
    await expectAxeClean(page);
  });

  test(`confirmación destructiva de cuenta · tema ${theme} · WCAG 2.2 A/AA`, async ({ page }) => {
    await renderFixture(page, 'settings', theme);
    await expect(page.locator('#delete-account-form')).toBeVisible();
    await expect(page.locator('#delete-account-password')).toHaveAttribute('required', '');
    await expect(page.locator('#delete-account-confirmation')).toHaveAttribute('pattern', 'ELIMINAR');
    await page.locator('#delete-account-password').fill('UnaClaveSegura123!');
    await page.locator('#delete-account-confirmation').fill('BORRAR');
    expect(await page.locator('#delete-account-form').evaluate(form => form.checkValidity())).toBe(false);
    await page.locator('#delete-account-confirmation').fill('ELIMINAR');
    expect(await page.locator('#delete-account-form').evaluate(form => form.checkValidity())).toBe(true);
    await expectAxeClean(page);
  });

  test(`diálogo de confirmación peligroso · tema ${theme} · WCAG 2.2 A/AA`, async ({ page }) => {
    await renderFixture(page, 'settings', theme);
    const trigger = page.getByRole('button', { name: /Cerrar sesión/ });
    await trigger.focus();
    await page.evaluate(async () => {
      const { showConfirmDialog } = await import('/assets/js/utils/dom.js');
      window.__a11yDialogResolved = null;
      window.__a11yDialogResult = showConfirmDialog({
        tone: 'danger',
        title: 'Eliminar tu cuenta',
        message: 'Esta acción eliminará tu perfil y tus datos privados.',
        detail: 'Las cartas enviadas pueden permanecer para la otra persona. No se puede deshacer.',
        confirmLabel: 'Eliminar cuenta',
        cancelLabel: 'Conservar cuenta'
      }).then(result => { window.__a11yDialogResolved = result; });
    });
    const dialog = page.getByRole('alertdialog', { name: 'Eliminar tu cuenta' });
    await expect(dialog).toBeVisible();
    await expectAxeClean(page);

    const cancel = dialog.getByRole('button', { name: 'Conservar cuenta' });
    const confirm = dialog.getByRole('button', { name: 'Eliminar cuenta' });
    await expect(cancel).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(confirm).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(cancel).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expect(trigger).toBeFocused();
    await expect.poll(() => page.evaluate(() => window.__a11yDialogResolved)).toBe(false);
  });
}

test('la Papelera expone los estados seleccionado, hover, pendiente y deshabilitado', async ({ page }) => {
  await renderFixture(page, 'trash', 'light');
  await expect(page.locator('#primary-navigation [data-route="trash"]')).toHaveAttribute('aria-current', 'page');

  const cards = page.locator('.letter-card');
  await expect(cards).toHaveCount(2);
  const firstCard = cards.first();
  await firstCard.hover();
  await expect(firstCard).not.toHaveCSS('transform', 'none');

  const waitingButton = firstCard.getByRole('button', { name: 'Esperando confirmación' });
  await expect(waitingButton).toBeDisabled();
  await expect(waitingButton).toHaveAttribute('aria-disabled', 'true');
  const pendingCard = cards.nth(1);
  await expect(pendingCard.getByRole('button', { name: 'Recuperar' })).toBeDisabled();
  await expectAxeClean(page);
});

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

test('200 % de zoom equivalente y reflow a 320 px CSS no pierden contenido ni acciones', async ({ page }) => {
  const criticalScreens = ['inbox', 'write', 'trash', 'letter', 'settings'];
  for (const width of [640, 320]) {
    await page.setViewportSize({ width, height: 900 });
    for (const screen of criticalScreens) {
      await renderFixture(page, screen, 'light');
      const metrics = await page.evaluate(() => ({
        viewportWidth: document.documentElement.clientWidth,
        documentWidth: document.documentElement.scrollWidth,
        mainWidth: document.querySelector('.main-area')?.getBoundingClientRect().width ?? 0,
        headingVisible: Boolean(document.querySelector('#page-heading')?.getClientRects().length),
        primaryActionCount: document.querySelectorAll('main button, .main-area button, .auth-card button').length
      }));
      expect(metrics.documentWidth, `${screen} a ${width} CSS px: overflow horizontal`).toBeLessThanOrEqual(metrics.viewportWidth + 1);
      expect(metrics.headingVisible, `${screen} a ${width} CSS px: el encabezado debe seguir visible`).toBe(true);
      expect(metrics.primaryActionCount, `${screen} a ${width} CSS px: no deben desaparecer las acciones`).toBeGreaterThan(0);
    }
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
