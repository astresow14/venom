import { expect, test, type Page, type Route } from "@playwright/test";

/**
 * Portfolio sharing card on the app detail: sharing state is visible, the
 * toggle flips visibility (private by default, disable kills the link), and
 * the owner can copy the stable share link. Endpoints are stubbed so the
 * flow stays hermetic.
 */

const APP_ID = "a0000000-0000-4000-8000-000000000071";
const SLUG = "stableslug1234567890abcd";
const SHARE_URL = `https://venom.example.com/s/${SLUG}`;
const NOW = "2026-08-20T12:00:00.000Z";

const APP = {
  id: APP_ID,
  name: "Field Guide",
  purpose: "Companion field guide app.",
  brand: "Venom Labs",
  status: "active",
  detectedStack: [],
  sourceType: "zip",
  sourceVersion: 3,
  deploymentUrl: null,
  importStatus: "imported",
  sourceUpdatedAt: NOW,
  linkedProjectId: null,
  linkedProjectName: null,
  latestIterationNumber: 2,
  improvementSignal: null,
  createdAt: "2026-08-01T10:00:00.000Z",
  updatedAt: NOW,
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

const CONTEXT_EMPTY = {
  appId: APP_ID,
  appName: "Field Guide",
  linkedProject: null,
  baseline: null,
  latestSourceVersion: null,
  suggestedSops: [],
  changes: null,
  canIterate: false,
  blockedReason: "no_baseline",
};

const DISABLED_STATE = {
  appId: APP_ID,
  enabled: false,
  slug: null,
  shareUrl: null,
  embedUrl: null,
  embedSnippet: null,
  publicStatus: "live",
  liveIterationNumber: 2,
  livePublishedAt: "2026-08-15T12:00:00.000Z",
};

const ENABLED_STATE = {
  ...DISABLED_STATE,
  enabled: true,
  slug: SLUG,
  shareUrl: SHARE_URL,
  embedUrl: `${SHARE_URL}/embed`,
  embedSnippet: `<iframe src="${SHARE_URL}/embed" title="Field Guide"></iframe>`,
};

type SharingHarness = {
  putBodies: Array<Record<string, unknown>>;
};

async function installSharingApi(page: Page): Promise<SharingHarness> {
  const harness: SharingHarness = { putBodies: [] };
  let sharing: Record<string, unknown> = { ...DISABLED_STATE };

  const json = (route: Route, body: unknown, status = 200) =>
    route.fulfill({
      status,
      contentType: "application/json",
      body: JSON.stringify(body),
    });

  await page.route("**/api/venom/**", async (route: Route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;

    if (path === "/api/venom/apps" && request.method() === "GET") {
      await json(route, [APP]);
      return;
    }
    if (path === `/api/venom/apps/${APP_ID}/sharing`) {
      if (request.method() === "GET") {
        await json(route, sharing);
        return;
      }
      if (request.method() === "PUT") {
        const body = request.postDataJSON() as Record<string, unknown>;
        harness.putBodies.push(body);
        sharing = body.enabled
          ? { ...ENABLED_STATE }
          : {
              ...ENABLED_STATE,
              enabled: false,
              shareUrl: null,
              embedUrl: null,
              embedSnippet: null,
            };
        await json(route, sharing);
        return;
      }
    }
    if (path === `/api/venom/apps/${APP_ID}/iteration-context`) {
      await json(route, CONTEXT_EMPTY);
      return;
    }
    if (path === `/api/venom/apps/${APP_ID}`) {
      await json(route, DETAIL);
      return;
    }
    if (path === "/api/venom/build-runs" && request.method() === "GET") {
      await json(route, []);
      return;
    }
    if (path === "/api/venom/provisioning/capability") {
      await json(route, {
        health: "healthy",
        summary: "Provisioning agent connected.",
        recoveryGuidance: null,
        supportedTargetTypes: ["app", "website"],
        rollbackSupported: true,
        publishSupported: true,
        frameEmbeddingSupported: true,
        permissionSummary: null,
      });
      return;
    }
    if (path === "/api/venom/provisioning/runs") {
      await json(route, []);
      return;
    }
    if (path === "/api/venom/sops") {
      await json(route, []);
      return;
    }
    await json(route, { error: "Not found" }, 404);
  });

  return harness;
}

function skipOnDesktop(testInfo: { project: { name: string } }) {
  test.skip(
    testInfo.project.name === "desktop-chromium",
    "The portfolio sharing card is covered at the mobile viewport.",
  );
}

test.use({ permissions: ["clipboard-read", "clipboard-write"] });

test("owner toggles sharing and copies the stable link from the portfolio detail", async ({
  page,
}, testInfo) => {
  test.setTimeout(120_000);
  skipOnDesktop(testInfo);

  const harness = await installSharingApi(page);
  await page.goto("/apps?venomUiTest=true");
  await expect(page.getByText("Control Plane")).toBeVisible();

  await page.getByRole("button", { name: /Open Field Guide/ }).click();

  // Private by default; the card says so.
  const status = page.getByTestId(`text-sharing-status-${APP_ID}`);
  await expect(status).toHaveText("Private");
  await expect(page.getByTestId(`text-share-url-${APP_ID}`)).toHaveCount(0);

  // Enable: the stable link appears along with what it serves.
  await page.getByTestId(`switch-app-sharing-${APP_ID}`).click();
  await expect(status).toHaveText("Anyone with the link · serving v2");
  await expect.poll(() => harness.putBodies).toEqual([{ enabled: true }]);
  await expect(page.getByTestId(`text-share-url-${APP_ID}`)).toHaveText(
    SHARE_URL,
  );

  // Copy puts the link on the clipboard and confirms quietly.
  await page.getByTestId(`button-copy-share-link-${APP_ID}`).click();
  await expect(page.getByTestId(`text-share-notice-${APP_ID}`)).toHaveText(
    "Link copied",
  );
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
    SHARE_URL,
  );

  // Disable: immediately back to private, link row gone.
  await page.getByTestId(`switch-app-sharing-${APP_ID}`).click();
  await expect(status).toHaveText("Private");
  await expect(page.getByTestId(`text-share-url-${APP_ID}`)).toHaveCount(0);
  await expect.poll(() => harness.putBodies).toEqual([
    { enabled: true },
    { enabled: false },
  ]);
});
