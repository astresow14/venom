import { expect, test, type Page, type Route } from "@playwright/test";

/**
 * Improve-this-app loop on the portfolio screen: the new-data suggestion on an
 * app's detail leads to the Improve modal (baseline + what's-new context),
 * starting an iteration hands off to the Builds tab with the queued run open,
 * blocked baselines (none / unresolvable) keep the start action inert, and
 * dismissing the suggestion hides it without starting anything. Every
 * iteration endpoint is stubbed so the flow stays hermetic.
 */

const APP_ID = "a0000000-0000-4000-8000-000000000041";
const NO_BASELINE_APP_ID = "a0000000-0000-4000-8000-000000000042";
const UNRESOLVABLE_APP_ID = "a0000000-0000-4000-8000-000000000043";
const RUN_ID = "b0000000-0000-4000-8000-000000000044";
const BASELINE_ITERATION_ID = "c0000000-0000-4000-8000-000000000045";
const BASELINE_BUILD_RUN_ID = "c0000000-0000-4000-8000-000000000046";
const BASELINE_REVISION_ID = "c0000000-0000-4000-8000-000000000047";
const CORRELATION_ID = "c0000000-0000-4000-8000-000000000048";
const SOURCE_VERSION_ID = "c0000000-0000-4000-8000-000000000049";
const NOW = "2026-08-20T12:00:00.000Z";
const SIGNAL_SUMMARY =
  "Atlas Research absorbed 3 new concepts and refreshed 1 source since package v1.";
const INSTRUCTION = "Surface the newest Atlas findings on the landing page.";
const CONSTRAINTS = "Keep the current navigation.";

function makeApp(
  id: string,
  name: string,
  overrides: Record<string, unknown> = {},
) {
  return {
    id,
    name,
    purpose: "Companion field guide app.",
    brand: "Venom Labs",
    status: "active",
    detectedStack: [],
    sourceType: "zip",
    sourceVersion: 3,
    deploymentUrl: null,
    importStatus: "imported",
    sourceUpdatedAt: NOW,
    linkedProjectId: "proj_alpha",
    linkedProjectName: "Atlas Research",
    latestIterationNumber: 1,
    improvementSignal: null,
    createdAt: "2026-08-01T10:00:00.000Z",
    updatedAt: NOW,
    ...overrides,
  };
}

const SUGGESTED_APP = makeApp(APP_ID, "Field Guide", {
  improvementSignal: {
    since: "2026-08-18T09:00:00.000Z",
    knowledgeChanges: 3,
    sourceChanges: 1,
    totalChanges: 4,
    summary: SIGNAL_SUMMARY,
    baselineIterationNumber: 1,
  },
});

const NO_BASELINE_APP = makeApp(NO_BASELINE_APP_ID, "Fresh Import", {
  latestIterationNumber: 0,
  linkedProjectId: null,
  linkedProjectName: null,
});

const UNRESOLVABLE_APP = makeApp(UNRESOLVABLE_APP_ID, "Legacy Kiosk", {
  latestIterationNumber: 2,
});

function appDetail(app: Record<string, unknown>) {
  return {
    app,
    versions: [],
    importJobs: [],
    deploymentLinks: [],
    provisioningReleases: [],
    iterations: [],
    timeline: [],
    timelineTotal: 0,
    timelineTruncated: false,
  };
}

const CONTEXT_READY = {
  appId: APP_ID,
  appName: "Field Guide",
  linkedProject: { id: "proj_alpha", name: "Atlas Research" },
  baseline: {
    iterationId: BASELINE_ITERATION_ID,
    iterationNumber: 1,
    buildRunId: BASELINE_BUILD_RUN_ID,
    revisionId: BASELINE_REVISION_ID,
    packageTitle: "Field Guide package",
    approvedAt: NOW,
    resolvable: true,
  },
  latestSourceVersion: {
    id: SOURCE_VERSION_ID,
    versionNumber: 3,
    archiveFilename: "field-guide-v3.zip",
  },
  suggestedSops: [],
  changes: {
    since: "2026-08-18T09:00:00.000Z",
    knowledgeChanges: 3,
    sourceChanges: 1,
    summary: SIGNAL_SUMMARY,
  },
  canIterate: true,
  blockedReason: null,
};

const CONTEXT_NO_BASELINE = {
  appId: NO_BASELINE_APP_ID,
  appName: "Fresh Import",
  linkedProject: null,
  baseline: null,
  latestSourceVersion: null,
  suggestedSops: [],
  changes: null,
  canIterate: false,
  blockedReason: "no_baseline",
};

const CONTEXT_UNRESOLVABLE = {
  appId: UNRESOLVABLE_APP_ID,
  appName: "Legacy Kiosk",
  linkedProject: { id: "proj_alpha", name: "Atlas Research" },
  baseline: {
    iterationId: BASELINE_ITERATION_ID,
    iterationNumber: 2,
    buildRunId: BASELINE_BUILD_RUN_ID,
    revisionId: BASELINE_REVISION_ID,
    packageTitle: "Legacy Kiosk package",
    approvedAt: NOW,
    resolvable: false,
  },
  latestSourceVersion: null,
  suggestedSops: [],
  changes: null,
  canIterate: false,
  blockedReason: "baseline_unresolvable",
};

const RUN_SUMMARY = {
  id: RUN_ID,
  correlationId: CORRELATION_ID,
  appId: APP_ID,
  runKind: "app_iteration",
  targetType: "app",
  targetName: "Field Guide",
  status: "queued",
  progress: 0,
  currentRevisionNumber: 0,
  approvedRevisionId: null,
  failureMessage: null,
  cancelledReason: null,
  createdAt: NOW,
  updatedAt: NOW,
};

const RUN_DETAIL = {
  ...RUN_SUMMARY,
  request: {
    targetType: "app",
    targetName: "Field Guide",
    requirements: INSTRUCTION,
    constraints: CONSTRAINTS,
    brandDirection: "",
    appId: APP_ID,
    sourceVersionId: SOURCE_VERSION_ID,
    projectId: "proj_alpha",
    sopRevisionIds: [],
    baselineIterationId: BASELINE_ITERATION_ID,
    baselineRevisionId: BASELINE_REVISION_ID,
    changesSummary: SIGNAL_SUMMARY,
  },
  revisions: [],
  events: [],
  attempt: 1,
  failureCode: null,
  startedAt: null,
  completedAt: null,
};

const CAPABILITY = {
  health: "healthy",
  summary: "Provisioning agent connected.",
  recoveryGuidance: null,
  supportedTargetTypes: ["app", "website"],
  rollbackSupported: true,
  publishSupported: true,
  permissionSummary: null,
};

async function installImprovementApi(page: Page) {
  const state = {
    iterationPosts: [] as Array<Record<string, unknown>>,
    dismissCalls: 0,
    dismissed: false,
    started: false,
  };

  const json = (route: Route, body: unknown, status = 200) =>
    route.fulfill({
      status,
      contentType: "application/json",
      body: JSON.stringify(body),
    });

  await page.route("**/api/venom/**", async (route: Route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;

    const suggestedApp = () =>
      state.dismissed
        ? { ...SUGGESTED_APP, improvementSignal: null }
        : SUGGESTED_APP;

    if (path === "/api/venom/apps" && request.method() === "GET") {
      await json(route, [suggestedApp(), NO_BASELINE_APP, UNRESOLVABLE_APP]);
      return;
    }

    if (
      path === `/api/venom/apps/${APP_ID}/improvement-suggestion/dismiss` &&
      request.method() === "POST"
    ) {
      state.dismissCalls += 1;
      state.dismissed = true;
      await json(route, { ...SUGGESTED_APP, improvementSignal: null });
      return;
    }

    const iterationMatch = path.match(
      /^\/api\/venom\/apps\/([0-9a-f-]{36})\/iterations$/,
    );
    if (iterationMatch && request.method() === "POST") {
      state.iterationPosts.push({
        appId: iterationMatch[1],
        ...(request.postDataJSON() as Record<string, unknown>),
      });
      state.started = true;
      await json(route, RUN_DETAIL, 201);
      return;
    }

    if (path === `/api/venom/apps/${APP_ID}/iteration-context`) {
      await json(route, CONTEXT_READY);
      return;
    }
    if (path === `/api/venom/apps/${NO_BASELINE_APP_ID}/iteration-context`) {
      await json(route, CONTEXT_NO_BASELINE);
      return;
    }
    if (path === `/api/venom/apps/${UNRESOLVABLE_APP_ID}/iteration-context`) {
      await json(route, CONTEXT_UNRESOLVABLE);
      return;
    }

    if (path === `/api/venom/apps/${APP_ID}`) {
      await json(route, appDetail(suggestedApp()));
      return;
    }
    if (path === `/api/venom/apps/${NO_BASELINE_APP_ID}`) {
      await json(route, appDetail(NO_BASELINE_APP));
      return;
    }
    if (path === `/api/venom/apps/${UNRESOLVABLE_APP_ID}`) {
      await json(route, appDetail(UNRESOLVABLE_APP));
      return;
    }

    if (path === "/api/venom/build-runs" && request.method() === "GET") {
      await json(route, state.started ? [RUN_SUMMARY] : []);
      return;
    }
    if (path === `/api/venom/build-runs/${RUN_ID}`) {
      await json(route, RUN_DETAIL);
      return;
    }

    if (path === "/api/venom/provisioning/capability") {
      await json(route, CAPABILITY);
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

    await route.fulfill({
      status: 404,
      contentType: "application/json",
      body: JSON.stringify({ error: "Not found" }),
    });
  });

  return state;
}

function skipOnDesktop(testInfo: { project: { name: string } }) {
  test.skip(
    testInfo.project.name === "desktop-chromium",
    "The portfolio improvement flow is covered at the mobile viewport.",
  );
}

test("walks an improvement suggestion into a queued iteration run", async ({
  page,
}, testInfo) => {
  test.setTimeout(120_000);
  skipOnDesktop(testInfo);

  const api = await installImprovementApi(page);
  await page.goto("/apps?venomUiTest=true");
  await expect(page.getByText("Control Plane")).toBeVisible();

  await page.getByRole("button", { name: /Open Field Guide/ }).click();

  // The suggestion banner surfaces the new-data summary on the app detail.
  const banner = page.getByTestId(`banner-improvement-${APP_ID}`);
  await expect(banner).toBeVisible();
  await expect(banner).toContainText("New data since package v1");
  await expect(banner).toContainText(SIGNAL_SUMMARY);

  // Review & iterate opens the Improve modal with baseline + what's-new.
  await page.getByTestId(`button-review-iterate-${APP_ID}`).click();
  await expect(page.getByText("Baseline · package v1")).toBeVisible();
  await expect(page.getByText(/Field Guide package · source v3/)).toBeVisible();
  await expect(page.getByText("What's new since v1")).toBeVisible();
  await expect(page.getByText(SIGNAL_SUMMARY).last()).toBeVisible();

  // Nothing starts without an instruction.
  const start = page.getByTestId("button-start-iteration");
  await expect(start).toHaveAttribute("aria-disabled", "true");
  await page.getByTestId("input-iteration-instruction").fill(INSTRUCTION);
  await page.getByTestId("input-iteration-constraints").fill(CONSTRAINTS);
  await expect(start).not.toHaveAttribute("aria-disabled", "true");
  await start.click();

  // The submitted request carries the instruction, constraints, and an
  // idempotency key.
  await expect.poll(() => api.iterationPosts.length).toBe(1);
  expect(api.iterationPosts[0].appId).toBe(APP_ID);
  expect(api.iterationPosts[0].instruction).toBe(INSTRUCTION);
  expect(api.iterationPosts[0].constraints).toBe(CONSTRAINTS);
  expect(typeof api.iterationPosts[0].idempotencyKey).toBe("string");
  expect(String(api.iterationPosts[0].idempotencyKey).length).toBeGreaterThan(
    0,
  );

  // Handoff lands on the Builds tab with the queued run open.
  await expect(page.getByRole("tab", { name: "Builds" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(page.getByText("Working on it... 0%")).toBeVisible();
});

test("blocks iterating without a baseline and with an unresolvable baseline", async ({
  page,
}, testInfo) => {
  test.setTimeout(120_000);
  skipOnDesktop(testInfo);

  const api = await installImprovementApi(page);
  await page.goto("/apps?venomUiTest=true");
  await expect(page.getByText("Control Plane")).toBeVisible();

  // No approved package yet: the modal explains and the start action is inert.
  await page.getByRole("button", { name: /Open Fresh Import/ }).click();
  await expect(
    page.getByTestId(`banner-improvement-${NO_BASELINE_APP_ID}`),
  ).toHaveCount(0);
  await page.getByTestId(`button-improve-app-${NO_BASELINE_APP_ID}`).click();
  await expect(
    page.getByText(/This app has no approved package yet/),
  ).toBeVisible();
  const start = page.getByTestId("button-start-iteration");
  await expect(start).toHaveAttribute("aria-disabled", "true");
  await expect(
    page.getByTestId("input-iteration-instruction"),
  ).toHaveJSProperty("readOnly", true);
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await page.getByRole("button", { name: "Close app detail" }).click();

  // Unresolvable pinned baseline: blocked with the explicit safety copy.
  await page.getByRole("button", { name: /Open Legacy Kiosk/ }).click();
  await page.getByTestId(`button-improve-app-${UNRESOLVABLE_APP_ID}`).click();
  await expect(page.getByText("Baseline · package v2")).toBeVisible();
  await expect(
    page.getByText(/pinned baseline package can no longer be resolved/),
  ).toBeVisible();
  await expect(
    page.getByTestId("button-start-iteration"),
  ).toHaveAttribute("aria-disabled", "true");
  await expect(
    page.getByTestId("input-iteration-instruction"),
  ).toHaveJSProperty("readOnly", true);

  expect(api.iterationPosts).toHaveLength(0);
});

test("dismissing the suggestion hides it without starting anything", async ({
  page,
}, testInfo) => {
  test.setTimeout(120_000);
  skipOnDesktop(testInfo);

  const api = await installImprovementApi(page);
  await page.goto("/apps?venomUiTest=true");
  await expect(page.getByText("Control Plane")).toBeVisible();

  await page.getByRole("button", { name: /Open Field Guide/ }).click();
  const banner = page.getByTestId(`banner-improvement-${APP_ID}`);
  await expect(banner).toBeVisible();

  await page.getByTestId(`button-dismiss-suggestion-${APP_ID}`).click();

  // The 2s detail poll delivers the signal-less app; the banner goes away and
  // stays away without any run starting.
  await expect(banner).toHaveCount(0, { timeout: 15_000 });
  expect(api.dismissCalls).toBe(1);
  expect(api.iterationPosts).toHaveLength(0);

  // Still on the portfolio detail with the manual entry point intact.
  await expect(page.getByRole("tab", { name: "Portfolio" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(
    page.getByTestId(`button-improve-app-${APP_ID}`),
  ).toBeVisible();
});
