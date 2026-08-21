import { defineConfig, devices } from '@playwright/test';

const port = Number(process.env.VENOM_DESKTOP_E2E_PORT ?? 22168);
const baseURL =
  process.env.VENOM_DESKTOP_E2E_BASE_URL ?? `http://127.0.0.1:${port}`;
const usesExternalTarget = Boolean(process.env.VENOM_DESKTOP_E2E_BASE_URL);

export default defineConfig({
  testDir: './e2e',
  // The live Clerk auth suite has its own server and config
  // (playwright.auth.config.ts); keep this suite hermetic.
  testIgnore: '**/auth/**',
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 2 : 0,
  workers: 1,
  timeout: 120_000,
  expect: {
    timeout: 10_000,
  },
  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL,
    ...devices['Desktop Chrome'],
    launchOptions: {
      executablePath:
        process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined,
    },
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
  webServer: usesExternalTarget
    ? undefined
    : {
        command: [
          `PORT=${port}`,
          'BASE_PATH=/',
          'VITE_VENOM_UI_TEST=true',
          'VITE_CLERK_PUBLISHABLE_KEY=$CLERK_PUBLISHABLE_KEY',
          'pnpm exec vite --config vite.config.ts --host 127.0.0.1',
        ].join(' '),
        url: baseURL,
        timeout: 120_000,
        reuseExistingServer: false,
      },
  outputDir: 'test-results',
});