import { expect, test } from '@playwright/test';

/**
 * Public share surfaces: `/s/:slug` (full page) and `/s/:slug/embed`
 * (minimal chrome for iframes). Both are unauthenticated; resolution goes
 * through the public no-store endpoint, and every non-live outcome renders
 * the same quiet branded fallback with zero detail about why.
 */

const SLUG = 'shareabc123def456ghi789';
const FRAME_URL = 'https://app-one.example.com/live';

const LIVE_FRAME = {
  status: 'live',
  appName: 'Field Guide',
  viewMode: 'frame',
  frameUrl: FRAME_URL,
};

const LIVE_REDIRECT = { ...LIVE_FRAME, viewMode: 'redirect' };

const UNAVAILABLE = {
  status: 'unavailable',
  appName: null,
  viewMode: null,
  frameUrl: null,
};

async function stubResolution(
  page: import('@playwright/test').Page,
  body: unknown,
  status = 200,
) {
  await page.route('**/api/public/app-shares/*', (route) =>
    route.fulfill({
      status,
      contentType: 'application/json',
      body: JSON.stringify(body),
    }),
  );
}

async function stubExternalApp(page: import('@playwright/test').Page) {
  await page.route('https://app-one.example.com/**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'text/html',
      body: '<html><body><h1>External app</h1></body></html>',
    }),
  );
}

test('share page frames the running app with the Venom badge', async ({
  page,
}) => {
  await stubResolution(page, LIVE_FRAME);
  await stubExternalApp(page);
  await page.goto(`/s/${SLUG}`);

  const frame = page.getByTestId('share-frame');
  await expect(frame).toBeVisible();
  await expect(frame).toHaveAttribute('src', FRAME_URL);
  await expect(frame).toHaveAttribute('title', 'Field Guide');
  // The framed app actually renders inside the iframe.
  await expect(
    page.frameLocator('[data-testid="share-frame"]').locator('h1'),
  ).toHaveText('External app');
  // Full-page view carries the badge back to Venom.
  await expect(page.getByTestId('link-share-badge')).toBeVisible();
  await expect(page).toHaveTitle('Field Guide · Venom');
});

test('share page redirects when the provider cannot be framed', async ({
  page,
}) => {
  await stubResolution(page, LIVE_REDIRECT);
  await stubExternalApp(page);
  await page.goto(`/s/${SLUG}`);

  await page.waitForURL('https://app-one.example.com/**');
  await expect(page.locator('h1')).toHaveText('External app');
});

test('unknown or disabled slugs get the branded fallback, not an error', async ({
  page,
}) => {
  await stubResolution(page, UNAVAILABLE);
  await page.goto(`/s/${SLUG}`);

  const fallback = page.getByTestId('share-fallback');
  await expect(fallback).toBeVisible();
  await expect(fallback).toContainText("This app isn't live right now.");
  await expect(page.getByTestId('share-frame')).toHaveCount(0);
  await expect(page.getByTestId('link-share-badge')).toHaveCount(0);
});

test('a failing resolution endpoint degrades to the same fallback', async ({
  page,
}) => {
  await stubResolution(page, { message: 'boom' }, 500);
  await page.goto(`/s/${SLUG}`);

  await expect(page.getByTestId('share-fallback')).toBeVisible();
});

test('embed view is chromeless: just the app frame', async ({ page }) => {
  await stubResolution(page, LIVE_FRAME);
  await stubExternalApp(page);
  await page.goto(`/s/${SLUG}/embed`);

  const frame = page.getByTestId('share-frame');
  await expect(frame).toBeVisible();
  await expect(frame).toHaveAttribute('src', FRAME_URL);
  // No badge, no extra chrome inside someone else's page.
  await expect(page.getByTestId('link-share-badge')).toHaveCount(0);
});

test('embed view in redirect mode offers an explicit open action instead of navigating', async ({
  page,
}) => {
  await stubResolution(page, LIVE_REDIRECT);
  await page.goto(`/s/${SLUG}/embed`);

  const openLink = page.getByTestId('link-embed-open');
  await expect(openLink).toBeVisible();
  await expect(openLink).toHaveAttribute('href', FRAME_URL);
  await expect(openLink).toHaveAttribute('target', '_top');
  // An embed must never yank the host page anywhere on its own.
  expect(page.url()).toContain(`/s/${SLUG}/embed`);
});

test('embed view shows the compact fallback when nothing is live', async ({
  page,
}) => {
  await stubResolution(page, UNAVAILABLE);
  await page.goto(`/s/${SLUG}/embed`);

  await expect(page.getByTestId('share-fallback')).toBeVisible();
  await expect(page.getByTestId('share-frame')).toHaveCount(0);
});
