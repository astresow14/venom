import { expect, test, type Page } from "@playwright/test";
import {
  bypassBotProtection,
  deleteUserByEmail,
  ensureTestUser,
  forceClientCaptchaBypass,
} from "../support/clerk-backend";

/**
 * Live credential-flow coverage for the phone app (Expo web target).
 *
 * The hermetic suite runs in UI-test mode, which treats a placeholder user
 * as signed in, and auth-welcome.spec.ts stubs every sign-in attempt — so
 * the real journey (credentials, session, the stepped verification forms,
 * post-auth routing into chat, and sign-out) had no automated proof on
 * mobile. These specs drive the REAL Clerk Frontend API with a
 * server-created +clerk_test account and assert arrival on the chat screen.
 *
 * The stepped forms are the app's own custom UI (not hosted components), so
 * no Turnstile widget renders; the Testing Token appended by
 * bypassBotProtection still lifts server-side bot protection for sign-up.
 */

/** Fixed verification code Clerk accepts for +clerk_test addresses. */
const TEST_CODE = "424242";

// A retry lands in a fresh worker, so each worker mints its own credentials
// and the sign-in account/password pair always match. The instance's
// password policy requires >= 15 characters.
const runId = `${Date.now()}`;
const password = `Task197!venom-${runId}-${process.pid}`;
const signInEmail = `venom.task197.signin.${runId}+clerk_test@example.com`;
const signUpEmail = `venom.task197.signup.${runId}+clerk_test@example.com`;

test.beforeAll(async () => {
  await ensureTestUser(signInEmail, password);
});

test.afterAll(async () => {
  await Promise.all([signInEmail, signUpEmail].map(deleteUserByEmail));
});

const MANAGED_MODELS = [
  {
    id: "venom-gpt",
    provider: "openai",
    name: "Venom GPT",
    family: "GPT",
    summary: "Balanced general-purpose reasoning.",
    available: true,
    availabilityText: "Ready",
  },
];

async function stubJsonGet(
  page: Page,
  url: string,
  body: unknown,
  status = 200,
) {
  await page.route(url, async (route) => {
    if (route.request().method() !== "GET") {
      await route.fallback();
      return;
    }
    await route.fulfill({
      status,
      contentType: "application/json",
      body: JSON.stringify(body),
    });
  });
}

/**
 * The auth e2e server serves the UI only — no API server runs. Stub every
 * backend read the signed-in workspace performs so the journey ends on a
 * rendered chat screen instead of retry spinners. The catch-all is
 * registered FIRST so the specific stubs below win, and anything unlisted
 * fails fast instead of hanging on the absent server.
 */
async function stubServerApis(page: Page) {
  await page.route("**/api/venom/**", (route) =>
    route.fulfill({
      status: 404,
      contentType: "application/json",
      body: JSON.stringify({ error: "Not found" }),
    }),
  );
  await stubJsonGet(page, "**/api/venom/models", MANAGED_MODELS);
  await stubJsonGet(page, "**/api/venom/workspaces", []);
  await stubJsonGet(page, "**/api/venom/deliberation", {
    available: false,
    mode: "multi-model",
    voices: [],
  });
  await stubJsonGet(page, "**/api/venom/identity", {
    displayName: null,
    email: null,
    provider: null,
  });
  await stubJsonGet(page, "**/api/venom/community/notifications/unread-count", {
    count: 0,
  });
  await stubJsonGet(page, "**/api/venom/community/briefing*", {
    community: [],
    agenda: [],
    calendarStatus: "not_connected",
    viewerProfile: null,
    nextCursor: null,
  });
  await stubJsonGet(
    page,
    "**/api/venom/community/profile",
    { message: "Community profile not set up" },
    404,
  );
  await stubJsonGet(page, "**/api/venom/sources/sync-alerts", { alerts: [] });

  // Cloud workspace: a fresh account (GET) plus an echoing save (PUT), the
  // same contract the real server honors for a first sign-in.
  await page.route("**/api/venom/workspace", async (route) => {
    const method = route.request().method();
    if (method === "GET") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          state: null,
          revision: 0,
          updatedAt: new Date().toISOString(),
        }),
      });
      return;
    }
    if (method === "PUT") {
      let body: { state?: unknown; baseRevision?: number } = {};
      try {
        body = route.request().postDataJSON() as typeof body;
      } catch {
        // An unreadable body still gets a valid snapshot back.
      }
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          state: body.state ?? null,
          revision: (body.baseRevision ?? 0) + 1,
          updatedAt: new Date().toISOString(),
        }),
      });
      return;
    }
    await route.fallback();
  });
}

async function preparePage(page: Page) {
  await stubServerApis(page);
  await bypassBotProtection(page);
}

/** The signed-out entry: the Strike-first welcome state of /sign-in. */
const welcomeHeading = (page: Page) =>
  page.getByRole("heading", { name: "Strike first" });

/** The chat screen's composer — proof the workspace rendered. */
const chatInput = (page: Page) => page.getByTestId("chat-input");

/**
 * Complete the "Verify this device" step with the fixed test code if the
 * app shows one: sign-in challenges untrusted clients, and every fresh
 * headless context is one. Skipped when the session lands directly.
 */
async function passDeviceCheckIfShown(page: Page) {
  const codeField = page.getByTestId("sign-in-code");
  await expect(codeField.or(chatInput(page)).first()).toBeVisible({
    timeout: 90_000,
  });
  if (await chatInput(page).isVisible().catch(() => false)) return;
  await codeField.fill(TEST_CODE);
  await page.getByTestId("verify-sign-in").click();
}

test("signing in lands in chat, and sign-out returns to the signed-out entry", async ({
  page,
}) => {
  await preparePage(page);

  // A signed-out visit to the root is parked on the sign-in screen.
  await page.goto("/");
  await expect(welcomeHeading(page)).toBeVisible({ timeout: 60_000 });
  await expect(page).toHaveURL(/\/sign-in$/);

  // The stepped form: welcome -> credentials -> (device check) -> chat.
  await page.getByTestId("continue-with-email").click();
  await page.getByTestId("sign-in-email").fill(signInEmail);
  await page.getByTestId("sign-in-password").fill(password);
  await page.getByTestId("submit-sign-in").click();
  await passDeviceCheckIfShown(page);

  // Real credentials must land on the chat screen.
  await expect(chatInput(page)).toBeVisible({ timeout: 90_000 });
  await expect(page.getByTestId("workspace-chat")).toBeVisible();
  await expect(page).toHaveURL(/\/$/);

  // A signed-in visit to an auth screen forwards back into the workspace.
  await page.goto("/sign-in");
  await expect(chatInput(page)).toBeVisible({ timeout: 90_000 });

  // Sign out from Settings returns to the signed-out entry…
  await page.getByTestId("open-settings").click();
  await page.getByTestId("sign-out").click();
  await expect(welcomeHeading(page)).toBeVisible({ timeout: 60_000 });
  await expect(page).toHaveURL(/\/sign-in$/);

  // …and the workspace is gated again for signed-out visitors.
  await page.goto("/");
  await expect(welcomeHeading(page)).toBeVisible({ timeout: 60_000 });
  await expect(page).toHaveURL(/\/sign-in$/);
});

test("account creation lands in chat", async ({ page }) => {
  await preparePage(page);

  await page.goto("/");
  await expect(welcomeHeading(page)).toBeVisible({ timeout: 60_000 });

  // Reach account creation through the welcome screen's own cross-link.
  await page.getByRole("link", { name: "Create an account" }).click();
  await expect(
    page.getByRole("heading", { name: "Create your account" }),
  ).toBeVisible();
  await expect(page).toHaveURL(/\/sign-up$/);

  // Without the client-side pin, clerk-js awaits an unsolvable headless
  // captcha before it even sends the attempt; see forceClientCaptchaBypass.
  await forceClientCaptchaBypass(page);
  await page.getByTestId("sign-up-email").fill(signUpEmail);
  await page.getByTestId("sign-up-password").fill(password);
  await page.getByTestId("submit-sign-up").click();

  // Email verification with the fixed test code.
  await expect(
    page.getByRole("heading", { name: "Check your email" }),
  ).toBeVisible({ timeout: 60_000 });
  await page.getByTestId("sign-up-code").fill(TEST_CODE);
  await page.getByTestId("verify-sign-up").click();

  // A brand-new account must land on the chat screen too.
  await expect(chatInput(page)).toBeVisible({ timeout: 90_000 });
  await expect(page.getByTestId("workspace-chat")).toBeVisible();
  await expect(page).toHaveURL(/\/$/);
});
