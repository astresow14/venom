import { expect, test, type Page } from "@playwright/test";
import type { WorkspaceSyncTestHarness } from "../context/workspaceSyncTestHarness";

declare global {
  interface Window {
    __venomWorkspaceSyncTest?: WorkspaceSyncTestHarness;
  }
}

const userId = "venom-ui-test";
const SOURCE_ID = "source_claim_test";
const WEBSITE_SOURCE_ROUTE = "**/venom/projects/*/sources/website";
const LEASE_MS = 10 * 60_000;

function syncTestUrl() {
  return "/?venomUiTest=true&venomWorkspaceSyncTest=true";
}

async function addTaskThatChangesWorkspace(page: Page, title: string) {
  const boardTab = page.getByRole("tab", { name: "Open To-Do workspace" });
  await boardTab.click();
  await expect(page.getByText("Task Board", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Add card to To Do" }).click();
  await page.getByLabel("New task title for To Do").fill(title);
  await page.getByRole("button", { name: "Add card", exact: true }).click();
  await expect(
    page.getByRole("button", { name: `Edit task ${title}` }),
  ).toBeVisible();
}

async function openSettings(page: Page) {
  await expect(page.getByTestId("open-settings")).toBeVisible();
  await page.getByTestId("open-settings").click();
  await expect(page.getByText("Cloud backup", { exact: true })).toBeVisible();
}

/**
 * Plants a stale, daily-scheduled source in the fake cloud, claimed by a
 * device that is not this browser. `claimAgeMs` controls whether that other
 * device still holds a live lease or abandoned the source long ago.
 */
async function seedClaimedSourceInCloud(page: Page, claimAgeMs: number) {
  await page.evaluate(
    ({ id, sourceId, ageMs }) => {
      const harness = window.__venomWorkspaceSyncTest;
      const snapshot = harness?.snapshots[id];
      if (!harness || !snapshot) throw new Error("No cloud snapshot to edit.");
      const state = snapshot.state as {
        projects?: { id: string }[];
        sources?: { id: string }[];
      };
      const now = Date.now();
      const source = {
        id: sourceId,
        projectId: state.projects?.[0]?.id ?? "proj_default",
        provider: "website",
        name: "Example Domain",
        url: "https://example.com/",
        status: "connected",
        syncedAt: new Date(now - (3 * 86_400_000 + 10 * 60_000)).toISOString(),
        summary: "Example Domain • public website",
        context: "[source:cite_seed] website: Example Domain. Stale copy",
        citations: [
          {
            id: "cite_seed",
            provider: "website",
            kind: "website",
            title: "Example Domain",
            url: "https://example.com/",
            excerpt: "Stale copy",
            reference: null,
          },
        ],
        clusters: [],
        schedule: {
          cadence: "daily",
          updatedAt: 1,
          claimedAt: now - ageMs,
          claimedBy: "another-device-session",
        },
      };
      harness.seedSnapshot(id, {
        ...state,
        sources: [...(state.sources ?? []), source],
      } as never);
    },
    { id: userId, sourceId: SOURCE_ID, ageMs: claimAgeMs },
  );
}

function cloudScheduleOutcome(page: Page) {
  return page.evaluate(
    ({ id, sourceId }) => {
      const snapshot = window.__venomWorkspaceSyncTest?.snapshots[id];
      const state = snapshot?.state as
        | {
            sources?: {
              id: string;
              schedule?: { claimedBy?: string; lastAttemptAt?: number };
            }[];
          }
        | undefined;
      const source = (state?.sources ?? []).find(
        (item) => item.id === sourceId,
      );
      if (!source) return null;
      return {
        claimedBy: source.schedule?.claimedBy ?? null,
        attempted: typeof source.schedule?.lastAttemptAt === "number",
      };
    },
    { id: userId, sourceId: SOURCE_ID },
  );
}

async function loadWorkspaceWithClaimedSource(
  page: Page,
  taskTitle: string,
  claimAgeMs: number,
) {
  await page.goto(syncTestUrl());
  await expect(page.getByTestId("open-settings")).toBeVisible();

  // The fake cloud only has a snapshot to edit once this device saves one.
  await addTaskThatChangesWorkspace(page, taskTitle);
  await expect
    .poll(() =>
      page.evaluate(
        (id) => Boolean(window.__venomWorkspaceSyncTest?.snapshots[id]),
        userId,
      ),
    )
    .toBe(true);

  await seedClaimedSourceInCloud(page, claimAgeMs);

  // Reload so the device restores a workspace where another device already
  // claimed the due source, exactly as if that device's save had synced down.
  await page.goto(syncTestUrl());
  await openSettings(page);
}

test("a source another device is updating right now is left alone", async ({
  page,
}, testInfo) => {
  let connectCount = 0;
  await page.route(WEBSITE_SOURCE_ROUTE, async (route) => {
    connectCount += 1;
    await route.fulfill({ status: 502, body: "{}" });
  });

  await loadWorkspaceWithClaimedSource(
    page,
    `Fresh claim ${testInfo.project.name}`,
    60_000,
  );

  // The source is three days stale on a daily cadence — without the claim it
  // would re-sync immediately, like the plain schedule journey proves. The
  // other device's live claim shows as an update in progress instead.
  await expect(
    page.getByTestId(`source-schedule-status-${SOURCE_ID}`),
  ).toHaveText("Daily updates · updating now");
  await page.waitForTimeout(1_500);
  expect(connectCount).toBe(0);
});

test("a claim from a device that died mid-sync is left for the server after its lease", async ({
  page,
}, testInfo) => {
  let connectCount = 0;

  // If the open app wrongly ran the update itself, this fresh copy would land
  // and flip the card — every assertion below would see it.
  await page.route(WEBSITE_SOURCE_ROUTE, async (route) => {
    connectCount += 1;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        id: SOURCE_ID,
        projectId: "proj_default",
        provider: "website",
        name: "Example Domain",
        url: "https://example.com/",
        status: "connected",
        syncedAt: new Date().toISOString(),
        summary: "Example Domain • public website",
        context: "[source:cite_fresh_0] website: Example Domain. Fresh copy",
        citations: [
          {
            id: "cite_fresh_0",
            provider: "website",
            kind: "website",
            title: "Example Domain",
            url: "https://example.com/",
            excerpt: "Fresh copy",
            reference: null,
          },
        ],
        clusters: [],
      }),
    });
  });

  await loadWorkspaceWithClaimedSource(
    page,
    `Expired claim ${testInfo.project.name}`,
    LEASE_MS + 60_000,
  );

  // The dead device's lease has run out, so its claim no longer reads as an
  // update in progress: the schedule is honestly overdue again.
  await expect(
    page.getByTestId(`source-schedule-status-${SOURCE_ID}`),
  ).toHaveText("Daily updates · due now");

  // But the open app does not take the slot over. Unattended updates run on
  // the API server (artifacts/api-server/src/lib/venom-scheduled-source-sync.ts,
  // with its own takeover coverage), and a second in-app sync would double
  // what the server does. The stale snapshot stays until the server's pass.
  await page.waitForTimeout(2_500);
  expect(connectCount).toBe(0);
  await expect(page.getByTestId(`source-sync-status-${SOURCE_ID}`)).toHaveText(
    "1 citations · Last synced 3d ago",
  );

  // This device's own saves must also round-trip the abandoned claim
  // untouched: the server worker takes over expired leases with a
  // compare-and-set on exactly these fields, so a save that dropped or spent
  // them would let two runners race the same cadence slot.
  const carriedTitle = `Claim carried ${testInfo.project.name}`;
  await page.goto(syncTestUrl());
  await expect(page.getByTestId("open-settings")).toBeVisible();
  await addTaskThatChangesWorkspace(page, carriedTitle);
  await expect
    .poll(
      () =>
        page.evaluate(
          ({ id, title }) => {
            const snapshot = window.__venomWorkspaceSyncTest?.snapshots[id];
            return snapshot
              ? JSON.stringify(snapshot.state).includes(title)
              : false;
          },
          { id: userId, title: carriedTitle },
        ),
      { timeout: 15_000 },
    )
    .toBe(true);

  // The abandoned claim is left for the server worker to spend: this device
  // neither steals nor clears it.
  expect(await cloudScheduleOutcome(page)).toEqual({
    claimedBy: "another-device-session",
    attempted: false,
  });
});
