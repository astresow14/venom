import { defineConfig, devices } from "@playwright/test";

const port = Number(process.env.VENOM_E2E_PORT ?? 22167);
const baseURL =
  process.env.VENOM_E2E_BASE_URL ??
  `http://127.0.0.1:${port}`;
const usesExternalTarget = Boolean(process.env.VENOM_E2E_BASE_URL);

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 2 : 0,
  workers: 1,
  timeout: 120_000,
  expect: {
    timeout: 10_000,
  },
  reporter: process.env.CI ? [["github"], ["html", { open: "never" }]] : "list",
  use: {
    baseURL,
    launchOptions: {
      executablePath:
        process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined,
    },
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
  projects: [
    {
      name: "mobile-chromium",
      use: {
        ...devices["Pixel 7"],
        viewport: { width: 400, height: 720 },
      },
    },
    {
      name: "desktop-chromium",
      use: devices["Desktop Chrome"],
    },
  ],
  webServer: usesExternalTarget
    ? undefined
    : {
        command: [
          "CI=1",
          "EXPO_PUBLIC_VENOM_UI_TEST=true",
          "EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY=$CLERK_PUBLISHABLE_KEY",
          `EXPO_PACKAGER_PROXY_URL=${baseURL}`,
          `EXPO_PUBLIC_DOMAIN=127.0.0.1:${port}`,
          "REACT_NATIVE_PACKAGER_HOSTNAME=127.0.0.1",
          `pnpm exec expo start --web --localhost --port ${port}`,
        ].join(" "),
        url: baseURL,
        timeout: 180_000,
        reuseExistingServer: false,
      },
  outputDir: "test-results",
});
