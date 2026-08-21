import { expect, test, type Page } from '@playwright/test';
import { AUTH_E2E_BASE_PATH } from '../support/auth-target';
import {
  bypassBotProtection,
  deleteUserByEmail,
  ensureTestUser,
  forceClientCaptchaBypass,
} from '../support/clerk-backend';
import { stubJsonGet, stubWorkspaceApis } from '../support/stubs';

/**
 * Live credential-flow coverage: these tests drive the REAL Clerk forms and
 * assert the app's own redirect wiring lands people straight in chat.
 *
 * The hermetic suite runs in UI-test mode, which bypasses the signed-in
 * gate, so everything past the hosted form — credentials, session, the
 * redirect back into the workspace, and sign-out — was unverified there.
 *
 * The server under test is mounted at a NON-ROOT base path (see
 * playwright.auth.config.ts). Every asserted URL carries that prefix, so a
 * redirect that drops the artifact base path fails these tests.
 */

const DESKTOP = { width: 1280, height: 860 };
test.use({ viewport: DESKTOP });

const base = AUTH_E2E_BASE_PATH;

/** Fixed verification code Clerk accepts for +clerk_test addresses. */
const TEST_CODE = '424242';

const escapeForRegex = (value: string) =>
  value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Anchored URL matcher with the artifact base path applied. */
const atApp = (path: string) =>
  new RegExp(`${escapeForRegex(base + path)}/?$`);

// A retry lands in a fresh worker, so each worker mints its own credentials
// and the sign-in account/password pair always match.
const runId = `${Date.now()}`;
const password = `Task80!venom-${runId}-${process.pid}`;
const signInEmail = `venom.task80.signin.${runId}+clerk_test@example.com`;
const signUpEmail = `venom.task80.signup.${runId}+clerk_test@example.com`;

test.beforeAll(async () => {
  await ensureTestUser(signInEmail, password);
});

test.afterAll(async () => {
  await Promise.all([signInEmail, signUpEmail].map(deleteUserByEmail));
});

/**
 * The auth e2e server serves the UI only; stub every backend read the
 * signed-in shell performs, plus fresh-account cloud sync, so the journey
 * ends on a rendered chat instead of an error boundary.
 */
async function prepareAppPage(page: Page) {
  await stubWorkspaceApis(page);
  await stubJsonGet(page, '**/venom/identity', {
    displayName: null,
    email: null,
    provider: null,
  });
  await stubJsonGet(page, '**/venom/deliberation', {
    available: false,
    mode: 'multi-model',
    voices: [],
  });
  await stubJsonGet(page, '**/venom/community/notifications/unread-count', {
    count: 0,
  });
  await page.route('**/venom/workspace', async (route) => {
    const method = route.request().method();
    if (method === 'GET') {
      // The real server's fresh-account snapshot: no state yet, revision 0.
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          state: null,
          revision: 0,
          updatedAt: new Date().toISOString(),
        }),
      });
      return;
    }
    if (method === 'PUT') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          state: null,
          revision: 1,
          updatedAt: new Date().toISOString(),
        }),
      });
      return;
    }
    await route.fallback();
  });
  await bypassBotProtection(page);
}

/** The Clerk card's primary action ("Continue"). */
const primaryButton = (page: Page) =>
  page.locator('.cl-formButtonPrimary').first();

async function fillClerkField(page: Page, name: string, value: string) {
  const field = page.locator(`input[name="${name}"]`).first();
  await expect(field).toBeVisible({ timeout: 45_000 });
  await field.fill(value);
}

/**
 * Complete a verification-code step with the fixed test code if Clerk shows
 * one. Sign-up always verifies the address; sign-in challenges untrusted
 * clients — and every fresh headless context is one.
 */
async function passCodeStepIfShown(page: Page) {
  const codeInput = page
    .locator('input[autocomplete="one-time-code"]')
    .first();
  const arrived = page.getByTestId('sidebar-desktop');
  await expect(codeInput.or(arrived).first()).toBeVisible({
    timeout: 60_000,
  });
  if (await arrived.isVisible()) return;
  await codeInput.click();
  await page.keyboard.type(TEST_CODE, { delay: 60 });
  // Clerk auto-submits a complete code; arrival is asserted by the caller.
}

/** Fill the sign-in form, tolerating one- and two-step layouts. */
async function submitSignInForm(page: Page, email: string, pass: string) {
  await fillClerkField(page, 'identifier', email);
  const passwordField = page.locator('input[name="password"]').first();
  if (!(await passwordField.isVisible())) {
    await primaryButton(page).click();
    await expect(passwordField).toBeVisible({ timeout: 30_000 });
  }
  await passwordField.fill(pass);
  await primaryButton(page).click();
}

test('sign-in lands straight in chat and sign-out returns to the gateway', async ({
  page,
}) => {
  await prepareAppPage(page);

  // Enter through the signed-out gateway's own link.
  await page.goto(`${base}/`);
  await expect(page.getByTestId('link-sign-in')).toBeVisible({
    timeout: 30_000,
  });
  await page.getByTestId('link-sign-in').click();
  await expect(page).toHaveURL(atApp('/sign-in'));

  await submitSignInForm(page, signInEmail, password);
  await passCodeStepIfShown(page);

  // The credential flow must land on chat, base path included.
  await expect(page).toHaveURL(atApp('/workspace/chat'), { timeout: 60_000 });
  await expect(page.getByTestId('sidebar-desktop')).toBeVisible();
  await expect(page.getByTestId('form-composer')).toBeVisible();

  // A signed-in visit to the gateway forwards straight to chat.
  await page.goto(`${base}/`);
  await expect(page).toHaveURL(atApp('/workspace/chat'), { timeout: 30_000 });

  // Sign out from the sidebar returns to the signed-out gateway…
  await page.getByTestId('button-sign-out-desktop').click();
  await expect(page).toHaveURL(atApp(''), { timeout: 30_000 });
  await expect(page.getByTestId('link-sign-in')).toBeVisible({
    timeout: 30_000,
  });

  // …and the workspace is gated again for signed-out visitors.
  await page.goto(`${base}/workspace/chat`);
  await expect(page).toHaveURL(atApp(''), { timeout: 30_000 });
  await expect(page.getByTestId('link-sign-in')).toBeVisible();
});

test('account creation lands straight in chat', async ({ page }) => {
  await prepareAppPage(page);

  await page.goto(`${base}/`);
  await expect(page.getByTestId('link-sign-up')).toBeVisible({
    timeout: 30_000,
  });
  await page.getByTestId('link-sign-up').click();
  await expect(page).toHaveURL(atApp('/sign-up'));

  // Headless runs cannot solve an interactive CAPTCHA; rely on the
  // server-side testing token and skip the client-side widget.
  await forceClientCaptchaBypass(page);

  await fillClerkField(page, 'emailAddress', signUpEmail);
  const firstName = page.locator('input[name="firstName"]').first();
  if (await firstName.isVisible()) {
    await firstName.fill('Venom');
    const lastName = page.locator('input[name="lastName"]').first();
    if (await lastName.isVisible()) await lastName.fill('Task Eighty');
  }
  await fillClerkField(page, 'password', password);
  await primaryButton(page).click();

  // Email verification with the fixed test code.
  await passCodeStepIfShown(page);

  await expect(page).toHaveURL(atApp('/workspace/chat'), { timeout: 90_000 });
  await expect(page.getByTestId('sidebar-desktop')).toBeVisible();
  await expect(page.getByTestId('form-composer')).toBeVisible();
});
