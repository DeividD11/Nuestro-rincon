import { test, expect } from '@playwright/test';

const projectRef = process.env.NR_E2E_PROJECT_REF || '';
const productionProjectRef = 'tiqbmuubpbmxqvtkcdhq';
const supabaseUrl = process.env.NR_E2E_SUPABASE_URL || '';
const publishableKey = process.env.NR_E2E_PUBLISHABLE_KEY || '';
const users = ['A', 'B'].map(suffix => ({
  suffix,
  username: process.env[`NR_E2E_ACCOUNT_${suffix}_USERNAME`] || '',
  password: process.env[`NR_E2E_ACCOUNT_${suffix}_PASSWORD`] || '',
  displayName: process.env[`NR_E2E_ACCOUNT_${suffix}_DISPLAY_NAME`] || ''
}));
const configured = Boolean(projectRef && supabaseUrl && publishableKey
  && users.every(user => user.username && user.password && user.displayName));

function assertIsolatedProject() {
  if (projectRef === productionProjectRef) throw new Error('Playwright está bloqueado contra el proyecto de producción.');
  const url = new URL(supabaseUrl);
  if (url.protocol !== 'https:' || url.hostname !== `${projectRef}.supabase.co`) {
    throw new Error('NR_E2E_SUPABASE_URL no coincide con el proyecto aislado NR_E2E_PROJECT_REF.');
  }
}

for (const user of users) {
  test(`la cuenta ${user.suffix} inicia sesión y muestra su espacio privado`, async ({ page }) => {
    test.skip(!configured, 'Configura credenciales de dos cuentas exclusivas del proyecto de pruebas.');
    assertIsolatedProject();

    await page.addInitScript(config => {
      Object.defineProperty(window, '__NR_E2E_CONFIG__', {
        configurable: false, enumerable: false, writable: false, value: config
      });
    }, { supabaseUrl, publishableKey });

    await page.goto('./');
    const form = page.locator('#login-form');
    await expect(form).toBeVisible();
    await form.locator('[name="identifier"]').fill(user.username);
    await form.locator('[name="password"]').fill(user.password);
    await form.locator('button[type="submit"]').click();

    await expect(page.locator('.app-shell')).toBeVisible();
    await expect(page.locator('.user-mini strong')).toHaveText(user.displayName);
    await expect(page.locator('[data-route="inbox"]')).toBeVisible();
  });
}
