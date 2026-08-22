import { defineConfig, devices } from "@playwright/test";

const port = Number(process.env.VENOM_E2E_PORT ?? 22167);
const baseURL =
  process.env.VENOM_E2E_BASE_URL ??
  `http://127.0.0.1:${port}`;
const usesExternalTarget = Boolean(process.env.VENOM_E2E_BASE_URL);

export default defineConfig({
  testDir: "./e2e",
  // The live credential-flow suite (e2e/auth) needs network access to Clerk
  // plus CLERK_SECRET_KEY, so it runs through playwright.auth.config.ts
  // only — never as part of this hermetic suite or its CI check.
  testIgnore: "**/auth/**",
  globalSetup: "./e2e/global-setup.ts",
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 2 : 0,
  // Two workers on GitHub's 4-vCPU hosted runners: the SwiftShader-rendered
  // GL specs are CPU-bound, and a third worker measurably slowed individual
  // tests and flaked the timing-sensitive swipe/keyboard specs into retries.
  // Locally one worker stays the default because the Replit container is far
  // weaker than a hosted runner.
  workers: process.env.CI ? 2 : 1,
  timeout: 120_000,
  expect: {
    timeout: 10_000,
  },
  // `list` prints every test with its duration, so a CI overrun names the
  // tests that ate the budget instead of a bare row of dots.
  reporter: process.env.CI
    ? [["list"], ["github"], ["html", { open: "never" }]]
    : "list",
  use: {
    baseURL,
    launchOptions: {
      executablePath:
        process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined,
    },
    screenshot: "only-on-failure",
    // Recording traces for every clean run costs a measurable slice of the CI
    // budget; record them only when a test already failed once.
    trace: process.env.CI ? "on-first-retry" : "retain-on-failure",
  },
  projects: [
    // Pays the dev server's one-time web bundle compile under its own
    // generous budget, so the alphabetically-first real spec does not
    // absorb it into a 120s test timeout on a loaded machine.
    {
      name: "warmup",
      testMatch: /support\/warmup\.setup\.ts/,
      timeout: 240_000,
    },
    {
      name: "mobile-chromium",
      use: {
        ...devices["Pixel 7"],
        viewport: { width: 400, height: 720 },
      },
      dependencies: ["warmup"],
    },
    // Runs everywhere, including the GitHub "Kanban browser regression"
    // job. That job once excluded this project under a fixed 15-minute
    // budget (no workflow-capable credential could raise it); its
    // timeout-minutes in .github/workflows/venom-kanban-e2e.yml is now
    // sized for both viewport passes, so keep the two in step when adding
    // especially heavy specs.
    {
      name: "desktop-chromium",
      use: devices["Desktop Chrome"],
      dependencies: ["warmup"],
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
          `pnpm exec expo start --web --localhost --port ${port} --clear`,
        ].join(" "),
        url: baseURL,
        timeout: 180_000,
        reuseExistingServer: false,
      },
  outputDir: "test-results",
});
