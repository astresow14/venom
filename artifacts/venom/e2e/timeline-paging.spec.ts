import { expect, test, type Page, type Route } from "@playwright/test";

const APP_ID = "a0000000-0000-4000-8000-000000000003";

const APP = {
  id: APP_ID,
  name: "Field Guide",
  brand: "Venom Labs",
  status: "active",
  purpose: "Companion field guide app.",
  description: "Companion site fed by the Atlas project.",
  sourceType: "zip",
  sourceVersion: 3,
  importStatus: "imported",
  detectedStack: [],
  linkedProjectId: null,
  linkedProjectName: null,
  latestIterationNumber: 2,
  liveReleaseId: null,
  liveIterationNumber: null,
  livePublishedAt: null,
  improvementSignal: null,
  createdAt: "2026-08-01T10:00:00.000Z",
  updatedAt: "2026-08-10T10:00:00.000Z",
};

function entry(n: number, occurredAt: string) {
  return {
    id: `evt-${n}`,
    kind: "package_iteration",
    title: `Iteration ${n}`,
    detail: null,
    actor: "You",
    status: "approved",
    occurredAt,
  };
}

const EMBEDDED = [
  entry(1, "2026-08-10T10:00:00.000Z"),
  entry(2, "2026-08-09T10:00:00.000Z"),
];
const PAGE_ONE = [
  entry(3, "2026-08-08T10:00:00.000Z"),
  entry(4, "2026-08-07T10:00:00.000Z"),
];
const PAGE_TWO = [
  entry(5, "2026-08-06T10:00:00.000Z"),
  entry(6, "2026-08-05T10:00:00.000Z"),
];
const CURSOR_EMBEDDED_TAIL = "2026-08-09T10:00:00.000Z~evt-2";
const CURSOR_PAGE_ONE_TAIL = "2026-08-07T10:00:00.000Z~evt-4";

async function installApi(page: Page) {
  const cursorsSeen: Array<string | null> = [];
  const state = { failNextTimelinePage: true };

  await page.route("**/api/venom/**", async (route: Route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;

    if (path === "/api/venom/apps" && request.method() === "GET") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify([APP]),
      });
      return;
    }

    if (path === `/api/venom/apps/${APP_ID}/timeline`) {
      const cursor = url.searchParams.get("cursor");
      cursorsSeen.push(cursor);
      if (state.failNextTimelinePage) {
        state.failNextTimelinePage = false;
        await route.fulfill({
          status: 500,
          contentType: "application/json",
          body: JSON.stringify({ error: "boom" }),
        });
        return;
      }
      if (cursor === CURSOR_EMBEDDED_TAIL) {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            entries: PAGE_ONE,
            nextCursor: CURSOR_PAGE_ONE_TAIL,
            total: 6,
          }),
        });
        return;
      }
      if (cursor === CURSOR_PAGE_ONE_TAIL) {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            entries: PAGE_TWO,
            nextCursor: null,
            total: 6,
          }),
        });
        return;
      }
      await route.fulfill({
        status: 400,
        contentType: "application/json",
        body: JSON.stringify({ error: "Unexpected cursor" }),
      });
      return;
    }

    if (path === `/api/venom/apps/${APP_ID}`) {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          app: APP,
          versions: [],
          importJobs: [],
          deploymentLinks: [],
          provisioningReleases: [],
          iterations: [],
          timeline: EMBEDDED,
          timelineTotal: 6,
          timelineTruncated: true,
        }),
      });
      return;
    }

    await route.fulfill({
      status: 404,
      contentType: "application/json",
      body: JSON.stringify({ error: "Not found" }),
    });
  });

  return { cursorsSeen };
}

test("pages older timeline entries with a visible retry after a failure", async ({
  page,
}) => {
  test.setTimeout(120_000);

  const api = await installApi(page);
  await page.goto(`/apps?venomUiTest=true`);

  await page.getByRole("button", { name: /Open Field Guide/ }).click();
  await expect(page.getByTestId("timeline-entry-evt-1")).toBeVisible();

  // Expand history — expansion alone never claims completeness.
  const toggle = page.getByTestId(`button-timeline-toggle-${APP_ID}`);
  await expect(toggle).toContainText("Show history (6 entries)");
  await toggle.click();
  await expect(toggle).toContainText("Show fewer entries");

  const loadMore = page.getByTestId(`button-timeline-more-${APP_ID}`);
  await expect(loadMore).toContainText("Load older entries (2 of 6 shown)");

  // First page load fails: the view stays expanded and shows an inline
  // error with a retry — no collapse/reopen required.
  await loadMore.click();
  await expect(page.getByTestId(`timeline-error-${APP_ID}`)).toBeVisible();
  await expect(page.getByTestId("timeline-entry-evt-2")).toBeVisible();
  await expect(page.getByTestId("timeline-entry-evt-3")).toHaveCount(0);

  // Retry continues from the last visible entry's keyset cursor.
  await page.getByTestId(`button-timeline-retry-${APP_ID}`).click();
  await expect(page.getByTestId("timeline-entry-evt-4")).toBeVisible();
  await expect(loadMore).toContainText("Load older entries (4 of 6 shown)");

  // The next page follows the server cursor to the end; the control then
  // disappears, leaving every entry reachable with no client-side cap.
  await loadMore.click();
  await expect(page.getByTestId("timeline-entry-evt-6")).toBeVisible();
  await expect(loadMore).toHaveCount(0);
  for (const id of ["evt-1", "evt-2", "evt-3", "evt-4", "evt-5", "evt-6"]) {
    await expect(page.getByTestId(`timeline-entry-${id}`)).toBeVisible();
  }
  expect(api.cursorsSeen).toEqual([
    CURSOR_EMBEDDED_TAIL,
    CURSOR_EMBEDDED_TAIL,
    CURSOR_PAGE_ONE_TAIL,
  ]);
});

const NEW_HEAD = entry(0, "2026-08-11T10:00:00.000Z");
const CURSOR_SHIFTED_TAIL = "2026-08-10T10:00:00.000Z~evt-1";

async function installShiftApi(page: Page) {
  const state = { shifted: false };

  await page.route("**/api/venom/**", async (route: Route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;

    if (path === "/api/venom/apps" && request.method() === "GET") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify([APP]),
      });
      return;
    }

    if (path === `/api/venom/apps/${APP_ID}/timeline`) {
      const cursor = url.searchParams.get("cursor");
      if (!state.shifted && cursor === CURSOR_EMBEDDED_TAIL) {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            entries: PAGE_ONE,
            nextCursor: CURSOR_PAGE_ONE_TAIL,
            total: 6,
          }),
        });
        return;
      }
      if (state.shifted && cursor === CURSOR_SHIFTED_TAIL) {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            entries: [EMBEDDED[1], ...PAGE_ONE, ...PAGE_TWO],
            nextCursor: null,
            total: 7,
          }),
        });
        return;
      }
      await route.fulfill({
        status: 400,
        contentType: "application/json",
        body: JSON.stringify({ error: "Unexpected cursor" }),
      });
      return;
    }

    if (path === `/api/venom/apps/${APP_ID}`) {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          app: APP,
          versions: [],
          importJobs: [],
          deploymentLinks: [],
          provisioningReleases: [],
          iterations: [],
          timeline: state.shifted ? [NEW_HEAD, EMBEDDED[0]] : EMBEDDED,
          timelineTotal: state.shifted ? 7 : 6,
          timelineTruncated: true,
        }),
      });
      return;
    }

    await route.fulfill({
      status: 404,
      contentType: "application/json",
      body: JSON.stringify({ error: "Not found" }),
    });
  });

  return state;
}

test("recovers an entry displaced from the embedded slice by a live refresh", async ({
  page,
}) => {
  test.setTimeout(120_000);

  // A new entry arriving mid-pagination shifts the capped embedded slice:
  // evt-0 pushes evt-2 out. The 2-second detail poll delivers the shifted
  // slice; cached older pages must reset so evt-2 is recovered, not lost.
  const state = await installShiftApi(page);
  await page.goto(`/apps?venomUiTest=true`);

  await page.getByRole("button", { name: /Open Field Guide/ }).click();
  await page.getByTestId(`button-timeline-toggle-${APP_ID}`).click();

  const loadMore = page.getByTestId(`button-timeline-more-${APP_ID}`);
  await expect(loadMore).toContainText("Load older entries (2 of 6 shown)");
  await loadMore.click();
  await expect(page.getByTestId("timeline-entry-evt-4")).toBeVisible();
  await expect(loadMore).toContainText("Load older entries (4 of 6 shown)");

  // The shifted embedded slice arrives on the next poll; pagination resets
  // instead of continuing after the stale cached page.
  state.shifted = true;
  await expect(page.getByTestId("timeline-entry-evt-0")).toBeVisible({
    timeout: 15_000,
  });
  await expect(loadMore).toContainText("Load older entries (2 of 7 shown)");
  await expect(page.getByTestId("timeline-entry-evt-3")).toHaveCount(0);

  // Loading again starts from the refreshed tail and recovers the displaced
  // evt-2 — every entry reachable, no gap.
  await loadMore.click();
  for (const id of [
    "evt-0",
    "evt-1",
    "evt-2",
    "evt-3",
    "evt-4",
    "evt-5",
    "evt-6",
  ]) {
    await expect(page.getByTestId(`timeline-entry-${id}`)).toBeVisible();
  }
  await expect(loadMore).toHaveCount(0);
});
