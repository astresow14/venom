/**
 * Shared target description for the live auth-flow suite
 * (playwright.auth.config.ts and e2e/auth/*).
 *
 * The auth suite serves the app under a NON-ROOT base path on purpose:
 * every redirect in the sign-in / sign-up / sign-out journey must carry
 * this prefix, so a regression that drops the artifact base path fails the
 * suite instead of shipping. The constant lives here so the web server
 * (vite BASE_PATH) and the specs' URL assertions cannot drift apart.
 */
export const AUTH_E2E_PORT = Number(
  process.env.VENOM_DESKTOP_AUTH_E2E_PORT ?? 22169,
);

/** Artifact base path under test — no trailing slash. */
export const AUTH_E2E_BASE_PATH = '/desktop';

export const AUTH_E2E_ORIGIN = `http://127.0.0.1:${AUTH_E2E_PORT}`;
