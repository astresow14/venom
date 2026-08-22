import { expect, test, type Page, type Route } from "@playwright/test";

/**
 * Portfolio app AI card: metered month usage is visible and the switch is
 * the instant pause — flipping it sends the full settings body and the
 * paused state reads back clearly. Endpoints are stubbed so the flow stays
 * hermetic.
 */

const APP_ID = "a0000000-0000-4000-8000-000000000072";
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

const SHARING_DISABLED = {
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

const AI_OVERVIEW = {
  appId: APP_ID,
  paused: false,
  monthlyCapUsd: 12.5 as number | null,
  safetyCapUsd: 25,
  credential: {
    displayPrefix: "vak_11111111",
    createdAt: "2026-08-02T09:00:00.000Z",
    lastUsedAt: "2026-08-19T18:00:00.000Z",
    delivered: true,
  },
  usage: {
    periodStart: "2026-08-01",
    periodEnd: "2026-09-01",
    costUsd: 3.42,
    requests: 128,
    promptTokens: 90000,
    outputTokens: 41000,
    hasEstimates: false,
    models: [
      {
        modelId: "venom-gpt",
        modelName: "Venom GPT",
        costUsd: 3.42,
        requests: 128,
      },
    ],
  },
  ownerMonthUsd: 5.05,
};

type AiHarness = {
  putBodies: Array<Record<string, unknown>>;
};

async function installPortfolioApi(page: Page): Promise<AiHarness> {
  const harness: AiHarness = { putBodies: [] };
  const ai = JSON.parse(JSON.stringify(AI_OVERVIEW)) as typeof AI_OVERVIEW;

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
    if (path === `/api/venom/apps/${APP_ID}/ai`) {
      await json(route, ai);
      return;
    }
    if (
      path === `/api/venom/apps/${APP_ID}/ai/settings` &&
      request.method() === "PUT"
    ) {
      const body = request.postDataJSON() as {
        paused: boolean;
        monthlyCapUsd: number | null;
      };
      harness.putBodies.push(body);
      ai.paused = body.paused;
      ai.monthlyCapUsd = body.monthlyCapUsd;
      await json(route, ai);
      return;
    }
    if (path === `/api/venom/apps/${APP_ID}/sharing`) {
      await json(route, SHARING_DISABLED);
      return;
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
    "The portfolio AI card is covered at the mobile viewport.",
  );
}

test("owner sees app AI usage and pauses it from the portfolio detail", async ({
  page,
}, testInfo) => {
  test.setTimeout(120_000);
  skipOnDesktop(testInfo);

  const harness = await installPortfolioApi(page);
  await page.goto("/apps?venomUiTest=true");
  await expect(page.getByText("Control Plane")).toBeVisible();

  await page.getByRole("button", { name: /Open Field Guide/ }).click();

  // Metered usage and the owner-wide total are visible, cap included.
  const usage = page.getByTestId(`text-app-ai-usage-${APP_ID}`);
  await expect(usage).toHaveText("$3.42 this month · 128 requests");
  const detailLine = page.getByTestId(`text-app-ai-detail-${APP_ID}`);
  await expect(detailLine).toHaveText(
    "All your apps: $5.05 this month · cap $12.50",
  );

  // Pause: the full settings body rides the PUT and the card says paused.
  const toggle = page.getByTestId(`switch-app-ai-pause-${APP_ID}`);
  await toggle.click();
  await expect.poll(() => harness.putBodies).toEqual([
    { paused: true, monthlyCapUsd: 12.5 },
  ]);
  await expect(detailLine).toHaveText(
    "Paused — the app's AI requests are refused instantly.",
  );
  await expect(page.getByTestId(`text-app-ai-notice-${APP_ID}`)).toHaveText(
    "App AI paused",
  );

  // Resume restores the metered view.
  await toggle.click();
  await expect.poll(() => harness.putBodies.length).toBe(2);
  expect(harness.putBodies[1]).toEqual({ paused: false, monthlyCapUsd: 12.5 });
  await expect(detailLine).toHaveText(
    "All your apps: $5.05 this month · cap $12.50",
  );
});
