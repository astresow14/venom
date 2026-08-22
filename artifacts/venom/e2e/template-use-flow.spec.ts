import { expect, test, type Page, type Route } from "@playwright/test";

/**
 * Global templates on mobile: the portfolio's template browser shows the
 * curated set, using a template files a real app, hands the Builds tab a
 * pre-filled build request stamped with template lineage, and the app's
 * detail card names its template origin. Every endpoint is stubbed so the
 * flow stays hermetic.
 */

const TEMPLATE_ID = "a1111111-1111-4111-8111-111111111151";
const OTHER_TEMPLATE_ID = "a1111111-1111-4111-8111-111111111152";
const APP_ID = "b1111111-1111-4111-8111-111111111153";
const RUN_ID = "c1111111-1111-4111-8111-111111111154";
const NOW = "2026-08-20T12:00:00.000Z";

const TEMPLATE_SUMMARY = {
  id: TEMPLATE_ID,
  slug: "client-booking-app",
  name: "Client Booking App",
  category: "app",
  description: "Let clients book time with you without the back-and-forth.",
  hasExamplePackage: true,
  updatedAt: NOW,
};

const OTHER_SUMMARY = {
  id: OTHER_TEMPLATE_ID,
  slug: "testimonial-wall-widget",
  name: "Testimonial Wall Widget",
  category: "widget",
  description: "A wall of customer praise for any existing site.",
  hasExamplePackage: false,
  updatedAt: NOW,
};

const TEMPLATE_DETAIL = {
  ...TEMPLATE_SUMMARY,
  previewSummary:
    "A booking flow for clients plus an owner dashboard of upcoming sessions.",
  targetType: "website",
  targetName: "Client Booking Site",
  requirements: "Build a booking site with real availability windows.",
  constraints: "No payment collection in the first version.",
  brandDirection: "Calm, professional, generous whitespace.",
  acceptanceChecks: [
    "A booked slot disappears from availability",
    "The owner sees new bookings immediately",
  ],
  examplePackage: { title: "Booking starter package" },
  status: "active",
};

const CREATED_APP = {
  id: APP_ID,
  name: "My Booking Studio",
  purpose: "Let clients book time with you without the back-and-forth.",
  brand: "Client Booking App",
  status: "draft",
  detectedStack: [],
  sourceType: null,
  sourceVersion: 0,
  deploymentUrl: null,
  importStatus: null,
  sourceUpdatedAt: null,
  linkedProjectId: null,
  linkedProjectName: null,
  latestIterationNumber: null,
  improvementSignal: null,
  liveReleaseId: null,
  templateId: TEMPLATE_ID,
  templateName: "Client Booking App",
  createdAt: NOW,
  updatedAt: NOW,
};

const USE_RESULT = {
  app: CREATED_APP,
  templateId: TEMPLATE_ID,
  templateName: "Client Booking App",
  prefill: {
    targetType: "website",
    targetName: "Client Booking Site",
    requirements: "Build a booking site with real availability windows.",
    constraints: "No payment collection in the first version.",
    brandDirection: "Calm, professional, generous whitespace.",
  },
};

const APP_DETAIL = {
  app: CREATED_APP,
  versions: [],
  importJobs: [],
  deploymentLinks: [],
  provisioningReleases: [],
  iterations: [],
  timeline: [],
  timelineTotal: 0,
  timelineTruncated: false,
};

const RUN_SUMMARY = {
  id: RUN_ID,
  correlationId: "d1111111-1111-4111-8111-111111111155",
  appId: APP_ID,
  targetType: "website",
  targetName: "Client Booking Site",
  status: "queued",
  progress: 0,
  currentRevisionNumber: 0,
  approvedRevisionId: null,
  templateId: TEMPLATE_ID,
  failureMessage: null,
  cancelledReason: null,
  createdAt: NOW,
  updatedAt: NOW,
};

const RUN_DETAIL = {
  ...RUN_SUMMARY,
  request: {
    targetType: "website",
    targetName: "Client Booking Site",
    requirements:
      "Build a booking site with real availability windows. Add SMS reminders.",
    constraints: "No payment collection in the first version.",
    brandDirection: "Calm, professional, generous whitespace.",
    appId: APP_ID,
    sourceVersionId: null,
    projectId: null,
    sopRevisionIds: [],
    templateId: TEMPLATE_ID,
  },
  revisions: [],
  events: [
    {
      id: "e1111111-1111-4111-8111-111111111156",
      eventType: "queued",
      status: "queued",
      progress: 0,
      message: "Generation request queued.",
      createdAt: NOW,
    },
  ],
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

async function installTemplateApi(page: Page) {
  let used = false;
  let runCreated = false;
  let usePost: Record<string, unknown> | undefined;
  let runPost: Record<string, unknown> | undefined;

  const json = (route: Route, body: unknown, status = 200) =>
    route.fulfill({
      status,
      contentType: "application/json",
      body: JSON.stringify(body),
    });

  await page.route("**/api/venom/**", async (route: Route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;

    if (path === "/api/venom/build-templates") {
      await json(route, [TEMPLATE_SUMMARY, OTHER_SUMMARY]);
      return;
    }
    if (
      path === `/api/venom/build-templates/${TEMPLATE_ID}/use` &&
      request.method() === "POST"
    ) {
      usePost = request.postDataJSON() as Record<string, unknown>;
      used = true;
      await json(route, USE_RESULT, 201);
      return;
    }
    if (path === `/api/venom/build-templates/${TEMPLATE_ID}`) {
      await json(route, TEMPLATE_DETAIL);
      return;
    }
    if (path === "/api/venom/apps") {
      await json(route, used ? [CREATED_APP] : []);
      return;
    }
    if (path === `/api/venom/apps/${APP_ID}`) {
      await json(route, APP_DETAIL);
      return;
    }
    if (path === "/api/venom/sops") {
      await json(route, []);
      return;
    }
    if (path === "/api/venom/models") {
      await json(route, [
        {
          id: "venom-gpt",
          provider: "openai",
          name: "Venom GPT",
          family: "GPT",
          summary: "Managed model",
          available: true,
          availabilityText: "Ready",
        },
      ]);
      return;
    }
    if (path === "/api/venom/build-runs" && request.method() === "POST") {
      runPost = request.postDataJSON() as Record<string, unknown>;
      runCreated = true;
      await json(route, RUN_SUMMARY, 201);
      return;
    }
    if (path === "/api/venom/build-runs") {
      await json(route, runCreated ? [RUN_SUMMARY] : []);
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
    await json(route, { error: "Not found" }, 404);
  });

  return {
    usePost: () => usePost,
    runPost: () => runPost,
  };
}

test("uses a global template from portfolio into a lineage-stamped build", async ({
  page,
}, testInfo) => {
  test.setTimeout(120_000);
  test.skip(
    testInfo.project.name === "desktop-chromium",
    "The template use flow is covered at the mobile viewport.",
  );

  const api = await installTemplateApi(page);
  await page.goto("/apps?venomUiTest=true");
  await expect(page.getByText("App Portfolio")).toBeVisible();

  // Browse the curated set.
  await page.getByTestId("button-open-templates").click();
  await expect(page.getByText("Start from a Template")).toBeVisible();
  const bookingRow = page.getByTestId("row-template-client-booking-app");
  await expect(bookingRow).toContainText("Client Booking App");
  await expect(
    page.getByTestId("row-template-testimonial-wall-widget"),
  ).toBeVisible();

  // Template detail shows what it produces.
  await bookingRow.click();
  await expect(page.getByTestId("text-template-detail-name")).toHaveText(
    "Client Booking App",
  );
  await expect(page.getByText("What this produces")).toBeVisible();
  await expect(
    page.getByText("A booked slot disappears from availability"),
  ).toBeVisible();
  await expect(
    page.getByText("Includes an example approved package", { exact: false }),
  ).toBeVisible();

  // Use it under a custom app name.
  await page.getByTestId("input-template-app-name").fill("My Booking Studio");
  await page.getByTestId("button-use-template").click();
  await expect.poll(() => api.usePost()).toEqual({ name: "My Booking Studio" });

  // Lands on the Builds tab with the create form pre-filled and editable.
  await expect(page.getByRole("tab", { name: "Builds" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(page.getByText("New Build Package")).toBeVisible();
  await expect(page.getByTestId("banner-template-origin")).toContainText(
    "Client Booking App",
  );
  await expect(page.getByRole("radio", { name: "WEBSITE" })).toHaveAttribute(
    "aria-checked",
    "true",
  );
  await expect(page.getByLabel("Target Name")).toHaveValue(
    "Client Booking Site",
  );
  await expect(page.getByLabel("Requirements")).toHaveValue(
    "Build a booking site with real availability windows.",
  );
  await expect(page.getByLabel("Constraints")).toHaveValue(
    "No payment collection in the first version.",
  );
  await expect(page.getByLabel("Brand Direction")).toHaveValue(
    "Calm, professional, generous whitespace.",
  );
  // The template-born app arrives pre-linked even though it has no source
  // versions yet.
  await expect(
    page.getByRole("radio", { name: "My Booking Studio" }),
  ).toHaveAttribute("aria-checked", "true");
  await expect(
    page.getByText("No source versions yet", { exact: false }),
  ).toBeVisible();

  // Everything stays editable before generating.
  await page
    .getByLabel("Requirements")
    .fill(
      "Build a booking site with real availability windows. Add SMS reminders.",
    );
  const createButton = page.getByRole("button", { name: "Create", exact: true });
  await expect(createButton).toBeEnabled();
  await createButton.click();

  // The submitted run carries template lineage alongside the edits.
  await expect.poll(() => api.runPost()?.templateId).toBe(TEMPLATE_ID);
  expect(api.runPost()).toMatchObject({
    appId: APP_ID,
    targetType: "website",
    requirements:
      "Build a booking site with real availability windows. Add SMS reminders.",
  });
  await expect(page.getByText("Working on it... 0%")).toBeVisible();

  // The app's detail card names its template origin.
  await page.getByRole("tab", { name: "Portfolio" }).click();
  await page
    .getByRole("button", { name: /Open My Booking Studio/ })
    .click();
  await expect(page.getByTestId("text-template-origin")).toContainText(
    "Client Booking App",
  );
});
