import { defineConfig, devices } from "@playwright/test";

const port = Number(process.env.VENOM_E2E_PORT ?? 22167);
const baseURL = `http://127.0.0.1:${port}`;

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  workers: 1,
  reporter: "line",
  use: {
    ...devices["Pixel 7"],
    baseURL,
    trace: "retain-on-failure",
  },
  webServer: {
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
});
