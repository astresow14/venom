import { expect, test } from '@playwright/test';
import { stubWorkspaceApis } from './support/stubs';

/**
 * Owner sharing panel on the app detail page: private by default, enabling
 * mints a stable link, copy actions put the link / iframe snippet on the
 * clipboard, and disabling reverts to the private state while keeping the
 * slug for a later re-enable.
 */

const APP_ID = 'a0000000-0000-4000-8000-000000000061';
const SLUG = 'stableslug1234567890abcd';
const SHARE_URL = `https://venom.example.com/s/${SLUG}`;
const EMBED_URL = `${SHARE_URL}/embed`;
const EMBED_SNIPPET = `<iframe src="${EMBED_URL}" title="Field Guide" style="border:0;width:100%;height:600px;border-radius:12px" allow="clipboard-write; fullscreen" loading="lazy"></iframe>`;

const APP = {
  id: APP_ID,
  name: 'Field Guide',
  brand: 'Venom Labs',
  status: 'active',
  purpose: 'Companion field guide app.',
  sourceType: 'zip',
  sourceVersion: 3,
  importStatus: 'imported',
  detectedStack: [],
  linkedProjectId: null,
  linkedProjectName: null,
  latestIterationNumber: 2,
  liveReleaseId: null,
  liveIterationNumber: null,
  livePublishedAt: null,
  improvementSignal: null,
  createdAt: '2026-08-01T10:00:00.000Z',
  updatedAt: '2026-08-19T10:00:00.000Z',
};

const DETAIL = {
  app: APP,
  versions: [],
  importJobs: [],
  deploymentLinks: [],
  provisioningReleases: [],
  iterations: [],
  timeline: [],
  timelineTotal: 0,
  timelineTruncated: false,
};

const DISABLED_STATE = {
  appId: APP_ID,
  enabled: false,
  slug: null,
  shareUrl: null,
  embedUrl: null,
  embedSnippet: null,
  publicStatus: 'live',
  liveIterationNumber: 2,
  livePublishedAt: '2026-08-15T12:00:00.000Z',
};

const ENABLED_STATE = {
  ...DISABLED_STATE,
  enabled: true,
  slug: SLUG,
  shareUrl: SHARE_URL,
  embedUrl: EMBED_URL,
  embedSnippet: EMBED_SNIPPET,
};

test.use({ permissions: ['clipboard-read', 'clipboard-write'] });

type SharingHarness = {
  putBodies: Array<Record<string, unknown>>;
};

async function installSharingApi(
  page: import('@playwright/test').Page,
  initial: Record<string, unknown>,
): Promise<SharingHarness> {
  let sharingState = { ...initial };
  const harness: SharingHarness = { putBodies: [] };

  await page.route(`**/venom/apps/${APP_ID}/sharing`, async (route) => {
    const method = route.request().method();
    if (method === 'GET') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(sharingState),
      });
      return;
    }
    if (method === 'PUT') {
      const body = route.request().postDataJSON() as Record<string, unknown>;
      harness.putBodies.push(body);
      sharingState = body.enabled
        ? { ...ENABLED_STATE }
        : {
            ...ENABLED_STATE,
            enabled: false,
            shareUrl: null,
            embedUrl: null,
            embedSnippet: null,
          };
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(sharingState),
      });
      return;
    }
    await route.fallback();
  });
  return harness;
}

test.beforeEach(async ({ page }) => {
  await stubWorkspaceApis(page);
  await page.route(`**/venom/apps/${APP_ID}`, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(DETAIL),
    }),
  );
  await page.route(`**/venom/apps/${APP_ID}/iteration-context`, (route) =>
    route.fulfill({
      status: 404,
      contentType: 'application/json',
      body: JSON.stringify({ message: 'No iteration context' }),
    }),
  );
});

test('owner enables sharing, copies link and embed code, then disables', async ({
  page,
}) => {
  const harness = await installSharingApi(page, DISABLED_STATE);
  await page.goto(`/workspace/apps/${APP_ID}`);

  // Private by default.
  const panel = page.getByTestId(`card-sharing-${APP_ID}`);
  await expect(panel).toBeVisible();
  const toggle = page.getByTestId(`switch-app-sharing-${APP_ID}`);
  await expect(toggle).toHaveAttribute('aria-checked', 'false');
  await expect(panel).toContainText('Private — only you can open this app.');

  // Enable: PUT {enabled:true}, link + embed controls appear.
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-checked', 'true');
  await expect.poll(() => harness.putBodies).toEqual([{ enabled: true }]);
  await expect(page.getByTestId(`input-share-url-${APP_ID}`)).toHaveValue(
    SHARE_URL,
  );
  await expect(page.getByTestId(`text-sharing-status-${APP_ID}`)).toContainText(
    'The link serves v2',
  );
  const openLink = page.getByTestId(`link-open-share-${APP_ID}`);
  await expect(openLink).toHaveAttribute('href', SHARE_URL);
  await expect(openLink).toHaveAttribute('target', '_blank');

  // Copy the share link.
  await page.getByTestId(`button-copy-share-link-${APP_ID}`).click();
  await expect(page.getByText('Link copied').first()).toBeVisible();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
    SHARE_URL,
  );

  // Copy the embed snippet.
  await page.getByTestId(`button-copy-embed-${APP_ID}`).click();
  await expect(page.getByText('Embed code copied').first()).toBeVisible();
  const copiedSnippet = await page.evaluate(() =>
    navigator.clipboard.readText(),
  );
  expect(copiedSnippet).toContain('<iframe');
  expect(copiedSnippet).toContain(EMBED_URL);

  // Disable: back to private, controls gone, slug retained server-side.
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-checked', 'false');
  await expect.poll(() => harness.putBodies).toEqual([
    { enabled: true },
    { enabled: false },
  ]);
  await expect(panel).toContainText(
    'Turning sharing back on restores the same link.',
  );
  await expect(page.getByTestId(`input-share-url-${APP_ID}`)).toHaveCount(0);
});

test('an enabled link with nothing live warns about the fallback', async ({
  page,
}) => {
  await installSharingApi(page, {
    ...ENABLED_STATE,
    publicStatus: 'unavailable',
    liveIterationNumber: null,
    livePublishedAt: null,
  });
  await page.goto(`/workspace/apps/${APP_ID}`);

  await expect(page.getByTestId(`text-sharing-status-${APP_ID}`)).toContainText(
    'Nothing is live right now',
  );
  // The link itself still shows so the owner knows what visitors will hit.
  await expect(page.getByTestId(`input-share-url-${APP_ID}`)).toHaveValue(
    SHARE_URL,
  );
});
