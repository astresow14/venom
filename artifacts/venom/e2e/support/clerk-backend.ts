import type { Page } from "@playwright/test";

/**
 * Clerk Backend API helpers for the live auth-flow suite (e2e/auth).
 *
 * The auth specs drive the REAL stepped credential flow, which needs two
 * things automation cannot get from the browser alone:
 *
 *  - a server-created test account for the sign-IN journey. `+clerk_test`
 *    addresses never receive real mail and accept the fixed 424242
 *    verification code;
 *  - a Testing Token appended to every Frontend API request, which lifts
 *    bot protection for the sign-UP flow — headless browsers otherwise
 *    fail Clerk's bot detection with `captcha_invalid`. The app's custom
 *    forms never render the Turnstile widget (that is a hosted-components
 *    concern), but sign-up creation is still validated server-side.
 *
 * Every request here runs in the Playwright process using the
 * CLERK_SECRET_KEY environment secret; the key itself never reaches the
 * page under test. Mirrors venom-desktop/e2e/support/clerk-backend.ts.
 */

const BACKEND_API = "https://api.clerk.com/v1";

function clerkSecretKey(): string {
  const key = process.env.CLERK_SECRET_KEY;
  if (!key) {
    throw new Error(
      "CLERK_SECRET_KEY is not set. The auth-flow suite exercises the real " +
        "Clerk credential flow and cannot run without the backend key.",
    );
  }
  return key;
}

async function backend(path: string, init?: RequestInit): Promise<Response> {
  return fetch(`${BACKEND_API}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${clerkSecretKey()}`,
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
  });
}

/** Host of the Clerk Frontend API, decoded from the publishable key. */
export function frontendApiHost(): string {
  const publishableKey =
    process.env.EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY ??
    process.env.CLERK_PUBLISHABLE_KEY;
  if (!publishableKey) {
    throw new Error("CLERK_PUBLISHABLE_KEY is not set.");
  }
  const encoded = publishableKey.replace(/^pk_(test|live)_/, "");
  const host = Buffer.from(encoded, "base64")
    .toString("utf8")
    .replace(/\$$/, "");
  if (!host.includes(".")) {
    throw new Error(
      "Could not decode the Clerk Frontend API host from the publishable key.",
    );
  }
  return host;
}

async function findUserIdByEmail(email: string): Promise<string | null> {
  const response = await backend(
    `/users?email_address=${encodeURIComponent(email)}&limit=1`,
  );
  if (!response.ok) return null;
  const users = (await response.json()) as Array<{ id: string }>;
  return users[0]?.id ?? null;
}

/** Create (or reuse) a password test user for the sign-in journey. */
export async function ensureTestUser(
  email: string,
  password: string,
): Promise<void> {
  const created = await backend("/users", {
    method: "POST",
    body: JSON.stringify({ email_address: [email], password }),
  });
  if (created.ok) return;

  const body = await created.text();
  // A rerun in the same worker reuses the run's address — that is fine.
  if (created.status === 422 && body.includes("form_identifier_exists")) {
    return;
  }
  throw new Error(
    `Clerk test-user creation failed (${created.status}): ${body.slice(0, 300)}`,
  );
}

/** Best-effort cleanup so the dev instance does not accumulate task users. */
export async function deleteUserByEmail(email: string): Promise<void> {
  try {
    const id = await findUserIdByEmail(email);
    if (id) await backend(`/users/${id}`, { method: "DELETE" });
  } catch {
    // Cleanup must never fail the suite.
  }
}

/**
 * Append a fresh Testing Token to every Frontend API request the page
 * makes. This is Clerk's documented mechanism for running sign-ups from
 * automation: with the token attached, bot protection is skipped
 * server-side and the invisible CAPTCHA outcome no longer matters.
 */
export async function bypassBotProtection(page: Page): Promise<void> {
  const response = await backend("/testing_tokens", { method: "POST" });
  if (!response.ok) {
    throw new Error(
      `Clerk testing-token request failed (${response.status}): ` +
        (await response.text()).slice(0, 300),
    );
  }
  const { token } = (await response.json()) as { token: string };
  const host = frontendApiHost();

  await page.route(
    (url) => url.hostname === host && url.pathname.startsWith("/v1/"),
    async (route) => {
      const url = new URL(route.request().url());
      url.searchParams.set("__clerk_testing_token", token);
      await route.continue({ url: url.toString() });
    },
  );
}

/**
 * Pin `Clerk.client.captchaBypass` to true on the CURRENT page.
 *
 * The Testing Token lifts bot protection server-side, but clerk-js decides
 * CLIENT-side whether to solve a captcha before it ever sends the sign-up
 * attempt: unless `client.captchaBypass` is set, SignUp.create awaits a
 * managed/invisible Turnstile that can never complete in headless Chromium,
 * so the submit spinner hangs forever (observed empirically — the custom
 * stepped form skips the widget UI, not the orchestration). Call this after
 * a navigation renders a Clerk-gated screen and before submitting sign-up.
 */
export async function forceClientCaptchaBypass(page: Page): Promise<void> {
  await page.waitForFunction(
    () =>
      (globalThis as { Clerk?: { loaded?: boolean } }).Clerk?.loaded === true,
    undefined,
    { timeout: 60_000 },
  );
  await page.evaluate(() => {
    const clerk = (globalThis as unknown as { Clerk: { client: object } })
      .Clerk;
    Object.defineProperty(clerk.client, "captchaBypass", {
      configurable: true,
      get: () => true,
      set: () => {},
    });
  });
}
