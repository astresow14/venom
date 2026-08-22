import { expect, test, type Page } from "@playwright/test";

/**
 * Scheduled source updates run on the API server now (see
 * artifacts/api-server/src/lib/venom-scheduled-source-sync.ts), so a due
 * schedule holds even when nobody has Venom open. What the client owes in
 * exchange, and what these tests pin down:
 *
 * - the open app never re-syncs a due source itself (the server owns the
 *   cadence; a second in-app sync would double what the server just did)
 * - the schedule state the server writes — attempt bookkeeping and the last
 *   failure — renders on the source card exactly as if this device did it
 */

const WEBSITE_SOURCE_ROUTE = "**/venom/projects/*/sources/website";
const SOURCE_ID = "source_schedule_ui_test";
const SOURCES_STORAGE_KEY = "@venom_sources_v1:venom-ui-test";

function websiteSourcePayload({
  syncedAt,
  citationCount,
  excerpt,
}: {
  syncedAt: string;
  citationCount: number;
  excerpt: string;
}) {
  return {
    id: SOURCE_ID,
    projectId: "proj_default",
    provider: "website",
    name: "Example Domain",
    url: "https://example.com/",
    status: "connected",
    syncedAt,
    summary: "Example Domain • public website",
    context: `[source:cite_${citationCount}] website: Example Domain. ${excerpt}`,
    citations: Array.from({ length: citationCount }, (_, index) => ({
      id: `cite_${citationCount}_${index}`,
      provider: "website",
      kind: "website",
      title: "Example Domain",
      url: "https://example.com/",
      excerpt,
      reference: null,
    })),
    clusters: [],
  };
}

/**
 * The UI test workspace is shared, so a scheduled source left behind would
 * confuse later tests. Every test hands the workspace back empty.
 */
async function disconnectSource(page: Page) {
  // Removal is destructive, so the control stages a confirmation dialog
  // rather than acting on one tap.
  await page.getByTestId(`remove-source-${SOURCE_ID}`).click();
  await page.getByTestId("confirm-remove-source").click();
  await expect(page.getByTestId(`remove-source-${SOURCE_ID}`)).toHaveCount(0);
}

async function openSettings(page: Page) {
  await expect(page.getByTestId("open-settings")).toBeVisible();
  await page.getByTestId("open-settings").click();
  await expect(page.getByText("Cloud backup", { exact: true })).toBeVisible();
}

async function connectStaleWebsiteSource(page: Page) {
  await page.getByTestId("website-source-url").fill("https://example.com");
  await page.getByTestId("connect-website-source").click();
  await expect(page.getByTestId(`source-sync-status-${SOURCE_ID}`)).toHaveText(
    "1 citations · Last synced 3d ago",
  );
}

test("a due schedule waits for the server instead of re-syncing in the app", async ({
  page,
}) => {
  let connectCount = 0;
  await page.route(WEBSITE_SOURCE_ROUTE, async (route) => {
    connectCount += 1;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(
        websiteSourcePayload({
          syncedAt: new Date(
            Date.now() - (3 * 86_400_000 + 10 * 60_000),
          ).toISOString(),
          citationCount: 1,
          excerpt: "Stale copy",
        }),
      ),
    });
  });

  await page.goto("/?venomUiTest=true");
  await openSettings(page);
  await connectStaleWebsiteSource(page);

  const schedule = page.getByTestId(`source-schedule-status-${SOURCE_ID}`);
  await expect(schedule).toHaveText("Manual updates only");

  // The source is three days stale, so a daily schedule is due immediately —
  // but the due sync belongs to the server now. The app must only mark the
  // schedule and sit still, or it would double-sync what the server handles.
  await page.getByTestId(`source-schedule-daily-${SOURCE_ID}`).click();
  await expect(schedule).toHaveText("Daily updates · due now");
  await expect(
    page.getByRole("radio", { name: "Daily updates for Example Domain" }),
  ).toHaveAttribute("aria-checked", "true");

  // The retired in-app runner used to fire within a tick of the schedule
  // flipping on; give a regression that window to betray itself.
  await page.waitForTimeout(1_500);
  expect(connectCount).toBe(1);
  await expect(page.getByTestId(`source-sync-status-${SOURCE_ID}`)).toHaveText(
    "1 citations · Last synced 3d ago",
  );

  // Cadence changes stay local bookkeeping too. Three days stale is inside a
  // weekly window, so the schedule reads as upcoming rather than due.
  await page.getByTestId(`source-schedule-weekly-${SOURCE_ID}`).click();
  await expect(schedule).toHaveText("Weekly updates · next in 4d");
  expect(connectCount).toBe(1);

  await page.getByTestId(`source-schedule-off-${SOURCE_ID}`).click();
  await expect(schedule).toHaveText("Manual updates only");

  await disconnectSource(page);
});

test("schedule state written by the server renders on the card as-is", async ({
  page,
}) => {
  let connectCount = 0;
  await page.route(WEBSITE_SOURCE_ROUTE, async (route) => {
    connectCount += 1;
    await route.fulfill({ status: 500, body: "must never be called" });
  });

  await page.goto("/?venomUiTest=true");
  await expect(page.getByTestId("chat-input")).toBeVisible();

  // A workspace the server already worked on: the scheduled sync failed a few
  // minutes ago, so the source card must show that failure and the snapshot
  // the server deliberately left in place.
  await page.evaluate(
    ({ key, source }) => {
      window.localStorage.setItem(key, JSON.stringify([source]));
    },
    {
      key: SOURCES_STORAGE_KEY,
      source: {
        ...websiteSourcePayload({
          syncedAt: new Date(
            Date.now() - (3 * 86_400_000 + 10 * 60_000),
          ).toISOString(),
          citationCount: 1,
          excerpt: "Snapshot the failed update kept",
        }),
        schedule: {
          cadence: "daily",
          updatedAt: Date.now() - 86_400_000,
          lastAttemptAt: Date.now() - 5 * 60_000,
          lastError: "Venom could not read this website.",
        },
      },
    },
  );
  await page.reload();
  await expect(page.getByTestId("chat-input")).toBeVisible();
  await openSettings(page);

  await expect(
    page.getByTestId(`source-schedule-status-${SOURCE_ID}`),
  ).toHaveText("Daily updates · last update failed");
  await expect(
    page.getByTestId(`source-refresh-error-${SOURCE_ID}`),
  ).toContainText("Venom could not read this website.");
  // The previous snapshot survived the failed server sync.
  await expect(page.getByTestId(`source-sync-status-${SOURCE_ID}`)).toHaveText(
    "1 citations · Last synced 3d ago",
  );
  await expect(
    page.getByRole("radio", { name: "Daily updates for Example Domain" }),
  ).toHaveAttribute("aria-checked", "true");

  // Neither the failure nor the due retry tempts the app into syncing.
  await page.waitForTimeout(1_500);
  expect(connectCount).toBe(0);

  await disconnectSource(page);
});

test("a server check that changed nothing reads as checked, not stalled", async ({
  page,
}) => {
  await page.goto("/?venomUiTest=true");
  await expect(page.getByTestId("chat-input")).toBeVisible();

  // A workspace after a skipped write: the server stamped its check two
  // hours ago (schedule.lastAttemptAt) but deliberately kept the three-day-
  // old snapshot because the site's content had not changed.
  await page.evaluate(
    ({ key, source }) => {
      window.localStorage.setItem(key, JSON.stringify([source]));
    },
    {
      key: SOURCES_STORAGE_KEY,
      source: {
        ...websiteSourcePayload({
          syncedAt: new Date(
            Date.now() - (3 * 86_400_000 + 10 * 60_000),
          ).toISOString(),
          citationCount: 1,
          excerpt: "Snapshot the unchanged check kept",
        }),
        schedule: {
          cadence: "daily",
          updatedAt: Date.now() - 86_400_000,
          lastAttemptAt: Date.now() - 2 * 3_600_000,
        },
      },
    },
  );
  await page.reload();
  await expect(page.getByTestId("chat-input")).toBeVisible();
  await openSettings(page);

  await expect(
    page.getByTestId(`source-schedule-status-${SOURCE_ID}`),
  ).toHaveText("Daily updates · checked 2h ago · next in 22h");
  // The snapshot itself is untouched — old date, and no failure to report.
  await expect(page.getByTestId(`source-sync-status-${SOURCE_ID}`)).toHaveText(
    "1 citations · Last synced 3d ago",
  );
  await expect(
    page.getByTestId(`source-refresh-error-${SOURCE_ID}`),
  ).toHaveCount(0);

  await disconnectSource(page);
});
