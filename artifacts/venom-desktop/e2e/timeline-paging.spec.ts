import { expect, test } from '@playwright/test';
import { stubWorkspaceApis } from './support/stubs';

const APP_ID = 'a0000000-0000-4000-8000-000000000002';

const APP = {
  id: APP_ID,
  name: 'Field Guide',
  brand: 'Venom Labs',
  status: 'active',
  purpose: 'Companion field guide app.',
  description: 'Companion site fed by the Atlas project.',
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
  updatedAt: '2026-08-10T10:00:00.000Z',
};

function entry(n: number, occurredAt: string) {
  return {
    id: `evt-${n}`,
    kind: 'package_iteration',
    title: `Iteration ${n}`,
    detail: null,
    actor: 'You',
    status: 'approved',
    occurredAt,
  };
}

const EMBEDDED = [entry(1, '2026-08-10T10:00:00.000Z'), entry(2, '2026-08-09T10:00:00.000Z')];
const PAGE_ONE = [entry(3, '2026-08-08T10:00:00.000Z'), entry(4, '2026-08-07T10:00:00.000Z')];
const PAGE_TWO = [entry(5, '2026-08-06T10:00:00.000Z'), entry(6, '2026-08-05T10:00:00.000Z')];
const CURSOR_EMBEDDED_TAIL = '2026-08-09T10:00:00.000Z~evt-2';
const CURSOR_PAGE_ONE_TAIL = '2026-08-07T10:00:00.000Z~evt-4';

const DETAIL = {
  app: APP,
  versions: [],
  importJobs: [],
  deploymentLinks: [],
  provisioningReleases: [],
  iterations: [],
  timeline: EMBEDDED,
  timelineTotal: 6,
  timelineTruncated: true,
};

test.beforeEach(async ({ page }) => {
  await stubWorkspaceApis(page);
});

test('pages the evolution timeline one cursor page at a time with retry', async ({
  page,
}) => {
  const cursorsSeen: Array<string | null> = [];
  let failedOnce = false;

  await page.route(`**/venom/apps/${APP_ID}`, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(DETAIL),
    }),
  );
  await page.route(`**/venom/apps/${APP_ID}/timeline*`, (route) => {
    const url = new URL(route.request().url());
    const cursor = url.searchParams.get('cursor');
    cursorsSeen.push(cursor);
    if (!failedOnce) {
      failedOnce = true;
      return route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'boom' }),
      });
    }
    if (cursor === CURSOR_EMBEDDED_TAIL) {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          entries: PAGE_ONE,
          nextCursor: CURSOR_PAGE_ONE_TAIL,
          total: 6,
        }),
      });
    }
    if (cursor === CURSOR_PAGE_ONE_TAIL) {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ entries: PAGE_TWO, nextCursor: null, total: 6 }),
      });
    }
    return route.fulfill({
      status: 400,
      contentType: 'application/json',
      body: JSON.stringify({ error: 'Unexpected cursor' }),
    });
  });

  await page.goto(`/workspace/apps/${APP_ID}`);

  // Embedded head renders with an honest "older entries" control — never a
  // "complete history" claim.
  await expect(page.getByTestId('timeline-entry-evt-2')).toBeVisible();
  const loadMore = page.getByTestId(`button-timeline-load-more-${APP_ID}`);
  await expect(loadMore).toContainText('Load older entries (2 of 6 shown)');

  // A failed page load surfaces as a retry on the same control.
  await loadMore.click();
  await expect(loadMore).toContainText('Could not load older entries — retry');
  await expect(page.getByTestId('timeline-entry-evt-3')).toHaveCount(0);

  // Retry continues from the last visible entry's keyset cursor.
  await loadMore.click();
  await expect(page.getByTestId('timeline-entry-evt-4')).toBeVisible();
  await expect(loadMore).toContainText('Load older entries (4 of 6 shown)');

  // The next click follows the server cursor to the final page, after which
  // the control disappears — every entry is reachable, no client-side cap.
  await loadMore.click();
  await expect(page.getByTestId('timeline-entry-evt-6')).toBeVisible();
  await expect(loadMore).toHaveCount(0);
  for (const id of ['evt-1', 'evt-2', 'evt-3', 'evt-4', 'evt-5', 'evt-6']) {
    await expect(page.getByTestId(`timeline-entry-${id}`)).toBeVisible();
  }
  expect(cursorsSeen).toEqual([
    CURSOR_EMBEDDED_TAIL,
    CURSOR_EMBEDDED_TAIL,
    CURSOR_PAGE_ONE_TAIL,
  ]);
});

test('recovers an entry displaced from the embedded slice by a live refresh', async ({
  page,
}) => {
  // A new entry arriving mid-pagination shifts the capped embedded slice:
  // evt-0 pushes evt-2 out. Cached older pages anchored on the old tail no
  // longer continue from what is on screen, so the client must reset paging
  // and recover evt-2 from the paged endpoint.
  const NEW_HEAD = entry(0, '2026-08-11T10:00:00.000Z');
  let shifted = false;
  const cursorsSeen: Array<string | null> = [];

  // An active import job keeps the detail query polling every 2 seconds,
  // which is how the refreshed (shifted) embedded slice reaches the client.
  const activeImportJob = {
    id: 'job-1',
    status: 'validating',
    archiveFilename: 'field-guide.zip',
  };

  await page.route(`**/venom/apps/${APP_ID}`, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        ...DETAIL,
        importJobs: [activeImportJob],
        timeline: shifted ? [NEW_HEAD, EMBEDDED[0]] : EMBEDDED,
        timelineTotal: shifted ? 7 : 6,
      }),
    }),
  );
  await page.route(`**/venom/apps/${APP_ID}/timeline*`, (route) => {
    const url = new URL(route.request().url());
    const cursor = url.searchParams.get('cursor');
    cursorsSeen.push(cursor);
    if (!shifted && cursor === CURSOR_EMBEDDED_TAIL) {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          entries: PAGE_ONE,
          nextCursor: CURSOR_PAGE_ONE_TAIL,
          total: 6,
        }),
      });
    }
    if (shifted && cursor === `2026-08-10T10:00:00.000Z~evt-1`) {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          entries: [EMBEDDED[1], ...PAGE_ONE, ...PAGE_TWO],
          nextCursor: null,
          total: 7,
        }),
      });
    }
    return route.fulfill({
      status: 400,
      contentType: 'application/json',
      body: JSON.stringify({ error: 'Unexpected cursor' }),
    });
  });

  await page.goto(`/workspace/apps/${APP_ID}`);

  const loadMore = page.getByTestId(`button-timeline-load-more-${APP_ID}`);
  await expect(loadMore).toContainText('Load older entries (2 of 6 shown)');
  await loadMore.click();
  await expect(page.getByTestId('timeline-entry-evt-4')).toBeVisible();
  await expect(loadMore).toContainText('Load older entries (4 of 6 shown)');

  // A new entry lands; the next 2s poll delivers the shifted embedded slice
  // ([evt-0, evt-1] — evt-2 displaced). Pagination must reset, not continue
  // from the stale cached pages.
  shifted = true;
  await expect(page.getByTestId('timeline-entry-evt-0')).toBeVisible({
    timeout: 15_000,
  });
  await expect(loadMore).toContainText('Load older entries (2 of 7 shown)');
  await expect(page.getByTestId('timeline-entry-evt-3')).toHaveCount(0);

  // Loading again starts from the refreshed tail and recovers the displaced
  // evt-2 — every entry reachable, no gap.
  await loadMore.click();
  for (const id of ['evt-0', 'evt-1', 'evt-2', 'evt-3', 'evt-4', 'evt-5', 'evt-6']) {
    await expect(page.getByTestId(`timeline-entry-${id}`)).toBeVisible();
  }
  await expect(loadMore).toHaveCount(0);
});
