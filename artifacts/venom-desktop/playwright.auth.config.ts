import { defineConfig, devices } from '@playwright/test';
import {
  AUTH_E2E_BASE_PATH,
  AUTH_E2E_ORIGIN,
  AUTH_E2E_PORT,
} from './e2e/support/auth-target';

/**
 * Live auth-flow suite (e2e/auth): drives the REAL Clerk credential flow,
 * so unlike playwright.config.ts it runs WITHOUT UI-test mode — the
 * signed-in gate, redirects, and sign-out behave exactly as in production.
 *
 * The app is deliberately served under a non-root base path so that every
 * redirect assertion catches a dropped artifact prefix.
 *
 * Requirements: network access to Clerk plus CLERK_PUBLISHABLE_KEY and
 * CLERK_SECRET_KEY in the environment (both are workspace secrets).
 * Global setup fails the run loudly when either is missing.
 *
 * Run manually with: pnpm --filter @workspace/venom-desktop run test:e2e:auth
 *
 * Wiring: the suite ALSO runs automatically as the `desktop-auth-e2e`
 * validation step on every task completion, alongside the hermetic
 * suites, via the test:e2e:auth:validation package script. That script
 * pins its own web-server port (22170), so a stale manual auth run
 * (22169) or the hermetic suite's server (22168) can never collide with
 * the automated copy. The GitHub mirror's CI deliberately does NOT run
 * this suite: the mirror has no Clerk secrets, and its workflow files
 * cannot be edited from this workspace until a workflow-capable
 * credential exists.
 */
export default defineConfig({
  testDir: './e2e/auth',
  globalSetup: './e2e/support/auth-global-setup.ts',
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  /**
   * A network-dependent suite gets retries wherever it runs unattended: a
   * retry lands in a fresh worker, which mints fresh credentials, so a
   * transient Clerk/network blip never blocks a task merge on its own.
   * Set VENOM_DESKTOP_AUTH_E2E_RETRIES=0 for immediate failures while
   * debugging locally.
   */
  retries:
    process.env.VENOM_DESKTOP_AUTH_E2E_RETRIES !== undefined
      ? Number(process.env.VENOM_DESKTOP_AUTH_E2E_RETRIES)
      : 2,
  workers: 1,
  timeout: 180_000,
  expect: {
    timeout: 15_000,
  },
  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: AUTH_E2E_ORIGIN,
    ...devices['Desktop Chrome'],
    launchOptions: {
      executablePath:
        process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined,
    },
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
  webServer: {
    command: [
      `PORT=${AUTH_E2E_PORT}`,
      `BASE_PATH=${AUTH_E2E_BASE_PATH}/`,
      'VITE_CLERK_PUBLISHABLE_KEY=$CLERK_PUBLISHABLE_KEY',
      'pnpm exec vite --config vite.config.ts --host 127.0.0.1',
    ].join(' '),
    url: `${AUTH_E2E_ORIGIN}${AUTH_E2E_BASE_PATH}/`,
    timeout: 120_000,
    reuseExistingServer: false,
  },
  outputDir: 'test-results-auth',
});
