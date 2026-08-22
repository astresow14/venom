import {
  expect,
  test,
  type Locator,
  type Page,
  type Route,
} from "@playwright/test";

/**
 * The project picker and the app-creation dialog share the card editor's
 * dismissal pattern (see BoardWorkspace in app/index.tsx): no modal animation
 * on web — a fading modal keeps its focus trap alive and strands keyboard
 * focus when its opener has been replaced — plus an explicit focus handoff to
 * a visible control related to what the user just did.
 */

const APP_ID = "b0000000-0000-4000-8000-000000000042";
const NOW = "2026-08-21T09:00:00.000Z";

async function expectVisibleKeyboardFocus(locator: Locator) {
  await expect(locator).toBeFocused();
  const focusIsVisible = await locator.evaluate((element) => {
    const style = getComputedStyle(element);
    const borderIsVisible = [
      style.borderTopColor,
      style.borderRightColor,
      style.borderBottomColor,
      style.borderLeftColor,
    ].some(
      (color) =>
        color !== "rgba(0, 0, 0, 0)" &&
        color !== "transparent" &&
        style.borderWidth !== "0px",
    );
    const outlineIsVisible =
      style.outlineStyle !== "none" && style.outlineWidth !== "0px";
    return borderIsVisible || outlineIsVisible || style.boxShadow !== "none";
  });
  expect(focusIsVisible).toBe(true);
}

test("project dialog dismissal keeps keyboard focus on a related control", async ({
  page,
}) => {
  await page.goto("/?venomUiTest=true");
  await expect(page.getByTestId("chat-input")).toBeVisible();

  await page.getByTestId("open-projects").click();
  const createButton = page.getByTestId("create-project");
  await expect(createButton).toBeVisible();

  // Cancelling stays on the projects screen: focus returns to the button
  // that opened the dialog.
  await createButton.click();
  await expect(page.getByTestId("new-project-name")).toBeFocused();
  await page.getByRole("button", { name: "Cancel" }).click();
  await expectVisibleKeyboardFocus(createButton);

  // Escape closes through onRequestClose and lands the same way.
  await createButton.click();
  await expect(page.getByTestId("new-project-name")).toBeFocused();
  await page.keyboard.press("Escape");
  await expectVisibleKeyboardFocus(createButton);

  // Creating pops back to the workspace: focus lands on the project
  // switcher, which now names the project that was just created.
  await createButton.click();
  await page.getByTestId("new-project-name").fill("Handoff Target");
  await page.getByTestId("save-project").click();
  await expect(page.getByTestId("chat-input")).toBeVisible();
  await expect(page.getByTestId("open-projects")).toContainText(
    "Handoff Target",
  );
  await expectVisibleKeyboardFocus(page.getByTestId("open-projects"));
});

function appPayload() {
  return {
    id: APP_ID,
    name: "Handoff Product",
    purpose: "Prove dialog dismissal focuses the created card.",
    brand: "Venom Labs",
    status: "draft",
    detectedStack: [],
    sourceType: "none",
    sourceVersion: 0,
    deploymentUrl: null,
    importStatus: null,
    sourceUpdatedAt: null,
    linkedProjectId: null,
    linkedProjectName: null,
    latestIterationNumber: 0,
    liveReleaseId: null,
    liveIterationNumber: null,
    livePublishedAt: null,
    improvementSignal: null,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

// CI has no API server, so every portfolio endpoint the screen touches is
// stubbed: the list is empty until the POST "creates" the app, after which
// the refreshed list (and the detail poll) return it.
async function installPortfolioApi(page: Page) {
  const state = { created: false };
  await page.route("**/api/venom/**", async (route: Route) => {
    const request = route.request();
    const pathname = new URL(request.url()).pathname;

    if (pathname === "/api/venom/apps" && request.method() === "GET") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(state.created ? [appPayload()] : []),
      });
      return;
    }
    if (pathname === "/api/venom/apps" && request.method() === "POST") {
      state.created = true;
      await route.fulfill({
        status: 201,
        contentType: "application/json",
        body: JSON.stringify(appPayload()),
      });
      return;
    }
    if (
      pathname === `/api/venom/apps/${APP_ID}` &&
      request.method() === "GET"
    ) {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          app: appPayload(),
          versions: [],
          importJobs: [],
          deploymentLinks: [],
          provisioningReleases: [],
          iterations: [],
          timeline: [],
          timelineTotal: 0,
          timelineTruncated: false,
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
}

test("app creation dialog hands focus to the created card, cancel to its opener", async ({
  page,
}) => {
  await installPortfolioApi(page);
  await page.goto("/apps?venomUiTest=true");

  const createButton = page.getByRole("button", {
    name: "Create app record",
  });
  await expect(createButton).toBeVisible();

  // Cancelling: focus returns to the button that opened the dialog.
  await createButton.click();
  await expect(page.getByLabel("Product name")).toBeFocused();
  await page.getByRole("button", { name: "Cancel" }).click();
  await expectVisibleKeyboardFocus(createButton);

  // Escape closes this dialog too (onRequestClose), with the same handoff.
  await createButton.click();
  await expect(page.getByLabel("Product name")).toBeFocused();
  await page.keyboard.press("Escape");
  await expectVisibleKeyboardFocus(createButton);

  // Creating: the dialog stays up until the refreshed list contains the new
  // app, then focus lands on that app's card.
  await createButton.click();
  await page.getByLabel("Product name").fill("Handoff Product");
  await page
    .getByLabel("Purpose")
    .fill("Prove dialog dismissal focuses the created card.");
  await page.getByLabel("Brand").fill("Venom Labs");
  await page.getByRole("button", { name: "Create", exact: true }).click();
  const appCard = page.getByRole("button", {
    name: /^Open Handoff Product/,
  });
  await expect(appCard).toBeVisible();
  await expectVisibleKeyboardFocus(appCard);
});

const BUILD_RUN_ID = "c1111111-1111-4111-8111-111111111111";
const ITERATION_RUN_ID = "d2222222-2222-4222-8222-222222222222";

function runSummary(id: string, targetName: string) {
  return {
    id,
    correlationId: "e3333333-3333-4333-8333-333333333333",
    appId: null,
    targetType: "website",
    targetName,
    status: "queued",
    progress: 0,
    currentRevisionNumber: 0,
    approvedRevisionId: null,
    failureMessage: null,
    cancelledReason: null,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function runDetail(id: string, targetName: string) {
  return {
    ...runSummary(id, targetName),
    request: {
      targetType: "website",
      targetName,
      requirements: "Prove dialog dismissal hands focus to the new run row.",
      constraints: null,
      brandDirection: null,
      appId: null,
      sourceVersionId: null,
      projectId: null,
      sopRevisionIds: [],
    },
    revisions: [],
    events: [],
    attempt: 1,
    failureCode: null,
    startedAt: null,
    completedAt: null,
  };
}

// The Builds tab and the portfolio's improve flow share the control plane's
// API surface, so one installer stubs both: the run list is empty until
// either the create dialog POSTs a run or an app iteration starts one.
async function installControlPlaneApi(page: Page) {
  const state = { buildCreated: false, iterationStarted: false };
  await page.route("**/api/venom/**", async (route: Route) => {
    const request = route.request();
    const pathname = new URL(request.url()).pathname;

    if (pathname === "/api/venom/apps" && request.method() === "GET") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify([appPayload()]),
      });
      return;
    }
    if (
      pathname === `/api/venom/apps/${APP_ID}` &&
      request.method() === "GET"
    ) {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          app: appPayload(),
          versions: [],
          importJobs: [],
          deploymentLinks: [],
          provisioningReleases: [],
          iterations: [],
          timeline: [],
          timelineTotal: 0,
          timelineTruncated: false,
        }),
      });
      return;
    }
    if (pathname === `/api/venom/apps/${APP_ID}/iteration-context`) {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          appId: APP_ID,
          appName: "Handoff Product",
          linkedProject: null,
          baseline: null,
          latestSourceVersion: null,
          suggestedSops: [],
          changes: null,
          live: null,
          divergence: null,
          canIterate: true,
          blockedReason: null,
        }),
      });
      return;
    }
    if (
      pathname === `/api/venom/apps/${APP_ID}/iterations` &&
      request.method() === "POST"
    ) {
      state.iterationStarted = true;
      await route.fulfill({
        status: 201,
        contentType: "application/json",
        body: JSON.stringify(runSummary(ITERATION_RUN_ID, "Handoff Product")),
      });
      return;
    }
    if (pathname === "/api/venom/build-runs" && request.method() === "POST") {
      state.buildCreated = true;
      await route.fulfill({
        status: 201,
        contentType: "application/json",
        body: JSON.stringify(runSummary(BUILD_RUN_ID, "Focus Handoff")),
      });
      return;
    }
    if (pathname === "/api/venom/build-runs" && request.method() === "GET") {
      const runs = [
        ...(state.iterationStarted
          ? [runSummary(ITERATION_RUN_ID, "Handoff Product")]
          : []),
        ...(state.buildCreated
          ? [runSummary(BUILD_RUN_ID, "Focus Handoff")]
          : []),
      ];
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(runs),
      });
      return;
    }
    if (
      pathname === `/api/venom/build-runs/${BUILD_RUN_ID}` &&
      request.method() === "GET"
    ) {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(runDetail(BUILD_RUN_ID, "Focus Handoff")),
      });
      return;
    }
    if (
      pathname === `/api/venom/build-runs/${ITERATION_RUN_ID}` &&
      request.method() === "GET"
    ) {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(runDetail(ITERATION_RUN_ID, "Handoff Product")),
      });
      return;
    }
    if (pathname === "/api/venom/provisioning/capability") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          health: "healthy",
          summary: "Provisioning is available.",
          recoveryGuidance: null,
          supportedTargetTypes: ["website", "app"],
          publishSupported: true,
          rollbackSupported: true,
        }),
      });
      return;
    }
    if (pathname === "/api/venom/provisioning/runs") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: "[]",
      });
      return;
    }
    if (pathname === "/api/venom/sops") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: "[]",
      });
      return;
    }
    await route.fulfill({
      status: 404,
      contentType: "application/json",
      body: JSON.stringify({ error: "Not found" }),
    });
  });
}

test("build-package create dialog hands focus to its opener on cancel and the new run row on create", async ({
  page,
}) => {
  test.setTimeout(120_000);
  await installControlPlaneApi(page);
  await page.goto("/apps?venomUiTest=true");

  await page.getByRole("tab", { name: "Builds" }).click();
  const createButton = page.getByTestId("button-create-build");
  await expect(createButton).toBeVisible();

  // Cancelling: focus returns to the button that opened the dialog.
  await createButton.click();
  await expect(page.getByLabel("Target Name")).toBeFocused();
  await page.getByTestId("button-cancel-create-build").click();
  await expectVisibleKeyboardFocus(createButton);

  // Escape closes through onRequestClose with the same handoff.
  await createButton.click();
  await expect(page.getByLabel("Target Name")).toBeFocused();
  await page.keyboard.press("Escape");
  await expectVisibleKeyboardFocus(createButton);

  // Creating: the dialog stays up until the refreshed list contains the new
  // run, then focus lands on that run's row.
  await createButton.click();
  await page.getByLabel("Target Name").fill("Focus Handoff");
  await page
    .getByLabel("Requirements")
    .fill("Prove dialog dismissal hands focus to the new run row.");
  await page.getByTestId("button-submit-create-build").click();
  const runRow = page.getByTestId(`card-build-run-${BUILD_RUN_ID}`);
  await expect(runRow).toBeVisible();
  await expectVisibleKeyboardFocus(runRow);
});

test("link picker and improve dialog hand focus back across dismissal, including the cross-tab handoff", async ({
  page,
}) => {
  test.setTimeout(120_000);
  await installControlPlaneApi(page);
  await page.goto("/apps?venomUiTest=true");

  const appCard = page.getByRole("button", { name: /^Open Handoff Product/ });
  await appCard.click();

  // Link picker: opening focuses the first project option; closing returns
  // focus to the opener.
  const linkOpener = page.getByTestId("button-open-link-picker");
  await expect(linkOpener).toBeVisible();
  await linkOpener.click();
  await expect(
    page.getByTestId("option-link-project-proj_default"),
  ).toBeFocused();
  await page.getByTestId("button-close-link-picker").click();
  await expectVisibleKeyboardFocus(linkOpener);

  // Improve dialog: cancel returns focus to the action that opened it.
  const improveButton = page.getByTestId(`button-improve-app-${APP_ID}`);
  await improveButton.click();
  await expect(page.getByTestId("input-iteration-instruction")).toBeFocused();
  await page.getByTestId("button-cancel-iteration").click();
  await expectVisibleKeyboardFocus(improveButton);

  // Starting an iteration navigates to the Builds tab; the handoff focuses
  // the run row the iteration just created.
  await improveButton.click();
  await page
    .getByTestId("input-iteration-instruction")
    .fill("Tighten the empty states.");
  await page.getByTestId("button-start-iteration").click();
  const runRow = page.getByTestId(`card-build-run-${ITERATION_RUN_ID}`);
  await expect(runRow).toBeVisible();
  await expectVisibleKeyboardFocus(runRow);
});

test("brain note composer hands focus back to the capture button", async ({
  page,
}) => {
  test.setTimeout(120_000);
  await page.goto("/?venomUiTest=true&slimeTier=off");

  const brainTab = page.getByRole("tab", { name: "Open Brain workspace" });
  await brainTab.click();
  const captureButton = page.getByTestId("brain-note-open");
  await expect(captureButton).toBeVisible();

  // Closing with the header X returns focus to the capture button.
  await captureButton.click();
  const noteInput = page
    .getByPlaceholder("Capture a decision, plan, dependency, risk, or idea…")
    .first();
  await expect(noteInput).toBeFocused();
  await page.getByTestId("brain-note-close").click();
  await expectVisibleKeyboardFocus(captureButton);

  // Escape closes the composer the same way.
  await captureButton.click();
  await expect(noteInput).toBeFocused();
  await page.keyboard.press("Escape");
  await expectVisibleKeyboardFocus(captureButton);
});
