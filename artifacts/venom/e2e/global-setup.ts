import type { FullConfig } from '@playwright/test';

/**
 * Warm the Metro web bundle before any test navigates.
 *
 * The dev server answers `/` with a tiny HTML shell long before the bundle
 * behind its script tag has compiled, so Playwright's web-server readiness
 * check passes while the first `page.goto` still faces a multi-minute cold
 * build — which used to burn most of the first test's timeout. Fetching the
 * bundle here moves that wait out of the tests: the run starts when the app
 * is actually servable. Against an already-warm external server this is a
 * cheap cache hit.
 */
export default async function globalSetup(config: FullConfig) {
  const baseURL = config.projects[0]?.use?.baseURL;
  if (!baseURL) return;

  const deadline = Date.now() + 240_000;
  const shell = await fetchWithDeadline(new URL('/', baseURL), deadline);
  const src = (await shell.text()).match(/<script[^>]+src="([^"]+)"/)?.[1];
  if (!src) return;

  const bundle = await fetchWithDeadline(new URL(src, baseURL), deadline);
  if (!bundle.ok) {
    throw new Error(
      `Web bundle failed to build before the run: HTTP ${bundle.status}`,
    );
  }
  // Drain so Metro finishes serializing; the body itself is irrelevant.
  await bundle.arrayBuffer();
}

async function fetchWithDeadline(url: URL, deadline: number): Promise<Response> {
  let lastError: unknown = null;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, {
        signal: AbortSignal.timeout(Math.max(1_000, deadline - Date.now())),
      });
      // Retry non-OK shells; Metro can briefly 500 while it boots.
      if (response.ok) return response;
      lastError = new Error(`HTTP ${response.status} for ${url.pathname}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  throw new Error(`Timed out warming ${url.pathname}: ${String(lastError)}`);
}
