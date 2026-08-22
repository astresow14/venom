import type { Page } from '@playwright/test';

/**
 * Clerk Backend API helpers for the live auth-flow suite.
 *
 * The auth specs drive the REAL Clerk credential flow, which needs two
 * things automation cannot get from the browser alone:
 *
 *  - a server-created test account for the sign-IN journey. `+clerk_test`
 *    addresses never receive real mail and accept the fixed 424242
 *    verification code;
 *  - a Testing Token appended to every Frontend API request, which lifts
 *    bot protection for the sign-UP form — headless browsers otherwise
 *    fail Clerk's invisible CAPTCHA with `captcha_invalid`.
 *
 * Every request here runs in the Playwright process using the
 * CLERK_SECRET_KEY environment secret; the key itself never reaches the
 * page under test.
 */

const BACKEND_API = 'https://api.clerk.com/v1';

function clerkSecretKey(): string {
  const key = process.env.CLERK_SECRET_KEY;
  if (!key) {
    throw new Error(
      'CLERK_SECRET_KEY is not set. The auth-flow suite exercises the real ' +
        'Clerk credential flow and cannot run without the backend key.',
    );
  }
  return key;
}

async function backend(path: string, init?: RequestInit): Promise<Response> {
  return fetch(`${BACKEND_API}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${clerkSecretKey()}`,
      'Content-Type': 'application/json',
      ...(init?.headers ?? {}),
    },
  });
}

/** Host of the Clerk Frontend API, decoded from the publishable key. */
export function frontendApiHost(): string {
  const publishableKey =
    process.env.CLERK_PUBLISHABLE_KEY ??
    process.env.VITE_CLERK_PUBLISHABLE_KEY;
  if (!publishableKey) {
    throw new Error('CLERK_PUBLISHABLE_KEY is not set.');
  }
  const encoded = publishableKey.replace(/^pk_(test|live)_/, '');
  const host = Buffer.from(encoded, 'base64')
    .toString('utf8')
    .replace(/\$$/, '');
  if (!host.includes('.')) {
    throw new Error(
      'Could not decode the Clerk Frontend API host from the publishable key.',
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
  const created = await backend('/users', {
    method: 'POST',
    body: JSON.stringify({ email_address: [email], password }),
  });
  if (created.ok) return;

  const body = await created.text();
  // A rerun in the same worker reuses the run's address — that is fine.
  if (created.status === 422 && body.includes('form_identifier_exists')) {
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
    if (id) await backend(`/users/${id}`, { method: 'DELETE' });
  } catch {
    // Cleanup must never fail the suite.
  }
}

/**
 * Address fingerprint for every account this suite mints. The stale-user
 * sweep keys off it, so it must stay distinct from the tags other live
 * harnesses use (scripts/live/* mint venom.task1xx.* accounts that may be
 * in use while this suite runs).
 */
const TEST_EMAIL_PREFIX = 'venom.desktop.auth.';

/** Tags earlier revisions of this suite used; their leftovers still get swept. */
const LEGACY_TEST_EMAIL_PREFIXES = ['venom.task80.', 'venom.auth.reset.'] as const;

/** Test address for one journey of one run — always a +clerk_test account. */
export function authTestEmail(
  kind: 'signin' | 'signup' | 'reset',
  runId: string,
): string {
  return `${TEST_EMAIL_PREFIX}${kind}.${runId}+clerk_test@example.com`;
}

/**
 * Delete leftovers from earlier runs whose afterAll cleanup never ran
 * (crashed or killed suite). Only this suite's own fingerprints are
 * touched, and only accounts old enough that no live run — retries
 * included — could still be using them. Runs from global setup on every
 * invocation, so the per-task-completion cadence cannot accumulate users
 * on the dev instance.
 *
 * Best-effort by design: hygiene must never mask the login signal this
 * suite exists to produce, so failures warn loudly instead of throwing.
 */
export async function sweepStaleTestUsers(
  maxAgeMs = 2 * 60 * 60 * 1000,
): Promise<void> {
  const cutoff = Date.now() - maxAgeMs;
  const prefixes = [TEST_EMAIL_PREFIX, ...LEGACY_TEST_EMAIL_PREFIXES];
  try {
    const stale = new Map<string, string>(); // user id -> email
    for (const prefix of prefixes) {
      const response = await backend(
        `/users?query=${encodeURIComponent(prefix)}&limit=100`,
      );
      if (!response.ok) {
        console.warn(
          `[auth-e2e sweep] user listing failed (${response.status}); ` +
            'leftover test users may be accumulating on the dev instance.',
        );
        continue;
      }
      const users = (await response.json()) as Array<{
        id: string;
        created_at: number;
        email_addresses?: Array<{ email_address?: string }>;
      }>;
      for (const user of users) {
        const email = user.email_addresses?.find((entry) =>
          entry.email_address?.startsWith(prefix),
        )?.email_address;
        if (!email || !email.includes('+clerk_test@')) continue;
        if (user.created_at >= cutoff) continue; // possibly still in use
        stale.set(user.id, email);
      }
    }
    for (const [id, email] of stale) {
      const deleted = await backend(`/users/${id}`, { method: 'DELETE' });
      if (deleted.ok) {
        console.log(`[auth-e2e sweep] removed stale test user ${email}`);
      } else {
        console.warn(
          `[auth-e2e sweep] could not delete ${email} (${deleted.status})`,
        );
      }
    }
  } catch (error) {
    console.warn(
      '[auth-e2e sweep] failed; leftover test users may be accumulating ' +
        `on the dev instance: ${String(error)}`,
    );
  }
}

/**
 * Force clerk-js to skip its client-side CAPTCHA orchestration.
 *
 * FAPI skips captcha VALIDATION for requests carrying the testing token
 * (see bypassBotProtection), but clerk-js only skips the Turnstile WIDGET
 * when the client resource carries `captcha_bypass` — and this instance
 * does not set that from the token alone, so headless runs stall on an
 * interactive "Verify you are human" checkbox that can never be solved.
 * Pin the documented flag the widget check reads (clerk-js
 * `getCaptchaToken` returns early on `clerk.client.captchaBypass`); every
 * credential request is still validated server-side under the testing
 * token.
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
    Object.defineProperty(clerk.client, 'captchaBypass', {
      configurable: true,
      get: () => true,
      set: () => {},
    });
  });
}

/**
 * Append a fresh Testing Token to every Frontend API request the page
 * makes. This is Clerk's documented mechanism for running sign-ups from
 * automation: with the token attached, bot protection is skipped
 * server-side and the invisible CAPTCHA outcome no longer matters.
 */
export async function bypassBotProtection(page: Page): Promise<void> {
  const response = await backend('/testing_tokens', { method: 'POST' });
  if (!response.ok) {
    throw new Error(
      `Clerk testing-token request failed (${response.status}): ` +
        (await response.text()).slice(0, 300),
    );
  }
  const { token } = (await response.json()) as { token: string };
  const host = frontendApiHost();

  await page.route(
    (url) => url.hostname === host && url.pathname.startsWith('/v1/'),
    async (route) => {
      const url = new URL(route.request().url());
      url.searchParams.set('__clerk_testing_token', token);
      await route.continue({ url: url.toString() });
    },
  );
}
