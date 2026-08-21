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
 *
 * Run with: pnpm --filter @workspace/venom-desktop run test:e2e:auth
 */
export default defineConfig({
  testDir: './e2e/auth',
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 2 : 0,
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
