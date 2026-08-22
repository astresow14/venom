import { defineConfig, devices } from "@playwright/test";

const port = Number(process.env.VENOM_AUTH_E2E_PORT ?? 22171);
const baseURL =
  process.env.VENOM_AUTH_E2E_BASE_URL ?? `http://127.0.0.1:${port}`;
const usesExternalTarget = Boolean(process.env.VENOM_AUTH_E2E_BASE_URL);

/**
 * Live auth-flow suite (e2e/auth): drives the REAL stepped Clerk credential
 * flow, so unlike playwright.config.ts the web server does NOT bake
 * EXPO_PUBLIC_VENOM_UI_TEST into the bundle — the auth gate, the custom
 * sign-in/sign-up forms, post-auth routing, and sign-out behave exactly as
 * they do for real phone users.
 *
 * Requirements: network access to Clerk plus CLERK_PUBLISHABLE_KEY and
 * CLERK_SECRET_KEY in the environment (both are workspace secrets). The
 * suite is therefore excluded from the hermetic config and from CI.
 *
 * Run with: pnpm --filter @workspace/venom run test:e2e:auth
 */
export default defineConfig({
  testDir: "./e2e/auth",
  // Same bundle warm-up as the hermetic suite: Metro answers `/` long
  // before the web bundle has compiled, so pay the cold build before the
  // first spec navigates.
  globalSetup: "./e2e/global-setup.ts",
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 2 : 0,
  workers: 1,
  timeout: 180_000,
  expect: {
    timeout: 15_000,
  },
  reporter: process.env.CI ? [["github"], ["html", { open: "never" }]] : "list",
  use: {
    baseURL,
    // The app's real surface is a phone; run the journey at the same
    // viewport the hermetic mobile project uses.
    ...devices["Pixel 7"],
    viewport: { width: 400, height: 720 },
    launchOptions: {
      executablePath:
        process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined,
    },
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
  // Point VENOM_AUTH_E2E_BASE_URL at a server already started with this
  // block's env to iterate without paying the cold Metro build each run.
  webServer: usesExternalTarget
    ? undefined
    : {
        command: [
          "CI=1",
          "EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY=$CLERK_PUBLISHABLE_KEY",
          `EXPO_PACKAGER_PROXY_URL=${baseURL}`,
          `EXPO_PUBLIC_DOMAIN=127.0.0.1:${port}`,
          "REACT_NATIVE_PACKAGER_HOSTNAME=127.0.0.1",
          `pnpm exec expo start --web --localhost --port ${port} --clear`,
        ].join(" "),
        url: baseURL,
        timeout: 180_000,
        reuseExistingServer: false,
      },
  outputDir: "test-results-auth",
});
