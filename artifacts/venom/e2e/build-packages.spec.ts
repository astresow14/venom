import { expect, test, type Page, type Route } from "@playwright/test";

const RUN_ID = "11111111-1111-4111-8111-111111111111";
const REVISION_ID = "22222222-2222-4222-8222-222222222222";
const EVENT_ID = "33333333-3333-4333-8333-333333333333";
const CORRELATION_ID = "44444444-4444-4444-8444-444444444444";
const NOW = "2026-08-20T12:00:00.000Z";

function summary(status: "queued" | "review_required" | "cancelled") {
  return {
    id: RUN_ID,
    correlationId: CORRELATION_ID,
    appId: null,
    targetType: "website",
    targetName: "Mobile QA",
    status,
    progress: status === "queued" ? 0 : 100,
    currentRevisionNumber: status === "queued" ? 0 : 1,
    approvedRevisionId: null,
    failureMessage: null,
    cancelledReason:
      status === "cancelled" ? "Requirements need another review." : null,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function detail(status: "queued" | "review_required" | "cancelled") {
  return {
    ...summary(status),
    request: {
      targetType: "website",
      targetName: "Mobile QA",
      requirements: "Create a website named Mobile QA",
      constraints: "Do not deploy or publish.",
      brandDirection: "Quiet monochrome.",
      appId: null,
      sourceVersionId: null,
      projectId: "proj_default",
      sopRevisionIds: [],
    },
    revisions:
      status === "queued"
        ? []
        : [
            {
              id: REVISION_ID,
              revisionNumber: 1,
              reason: "Initial generated package",
              checksumSha256: "a".repeat(64),
              createdAt: NOW,
              approvedAt: null,
              package: {
                formatVersion: 1,
                targetType: "website",
                title: "Mobile QA",
                productBrief: {
                  summary: "An accessible review-only website package.",
                  audience: ["Mobile workspace users"],
                  outcomes: ["A validated package ready for human review"],
                },
                functionalScope: ["Keyboard-accessible navigation"],
                brandDirection: ["Quiet monochrome visual language"],
                contentRequirements: ["Plain-language page copy"],
                serviceFlowRequirements: [],
                sourceReferences: [],
                sopReferences: [],
                dataNeeds: ["No customer data is imported"],
                integrationNeeds: ["No integration is executed"],
                permissionRequests: [
                  {
                    capability: "Future provisioning",
                    reason: "Requires a separate human-controlled step",
                    required: false,
                  },
                ],
                acceptanceChecks: ["All controls are keyboard accessible"],
                launchConstraints: [
                  "Human approval is required",
                  "Do not execute, publish, or deploy anything",
                ],
              },
            },
          ],
    events: [
      {
        id: EVENT_ID,
        eventType:
          status === "cancelled"
            ? "rejected"
            : status === "review_required"
              ? "review_required"
              : "queued",
        status,
        progress: status === "queued" ? 0 : 100,
        message:
          status === "cancelled"
            ? "Package rejected after review."
            : status === "review_required"
              ? "Package is ready for review."
              : "Generation request queued.",
        createdAt: NOW,
      },
    ],
    attempt: 1,
    failureCode: null,
    startedAt: status === "queued" ? null : NOW,
    completedAt: status === "queued" ? null : NOW,
  };
}

async function installBuildApi(page: Page) {
  let created = false;
  let status: "queued" | "review_required" | "cancelled" = "queued";
  let detailReads = 0;
  let submittedRequest: Record<string, unknown> | undefined;

  await page.route("**/api/venom/**", async (route: Route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;

    if (path === "/api/venom/apps" || path === "/api/venom/sops") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: "[]",
      });
      return;
    }

    if (path === "/api/venom/models") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify([
          {
            id: "venom-gpt",
            provider: "openai",
            name: "Venom GPT",
            family: "GPT",
            summary: "Managed model",
            available: true,
            availabilityText: "Ready",
          },
        ]),
      });
      return;
    }

    if (path === "/api/venom/build-runs" && request.method() === "POST") {
      submittedRequest = request.postDataJSON() as Record<string, unknown>;
      created = true;
      status = "queued";
      await route.fulfill({
        status: 201,
        contentType: "application/json",
        body: JSON.stringify(summary(status)),
      });
      return;
    }

    if (path === "/api/venom/build-runs") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(created ? [summary(status)] : []),
      });
      return;
    }

    if (
      path === `/api/venom/build-runs/${RUN_ID}/reject` &&
      request.method() === "POST"
    ) {
      status = "cancelled";
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(detail(status)),
      });
      return;
    }

    if (path === `/api/venom/build-runs/${RUN_ID}`) {
      detailReads += 1;
      if (detailReads >= 2 && status === "queued") {
        status = "review_required";
      }
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(detail(status)),
      });
      return;
    }

    await route.fulfill({
      status: 404,
      contentType: "application/json",
      body: JSON.stringify({ error: "Not found" }),
    });
  });

  return {
    submittedRequest: () => submittedRequest,
  };
}

test("mobile chat opens a safe build-package review flow", async ({
  page,
}, testInfo) => {
  test.setTimeout(120_000);
  test.skip(
    testInfo.project.name === "desktop-chromium",
    "The compact package flow is covered at the mobile viewport.",
  );

  const api = await installBuildApi(page);
  await page.goto("/?venomUiTest=true");
  await page.getByTestId("chat-input").fill("Create a website named Mobile QA");
  await page.getByTestId("send-message-button").click();

  await expect(page).toHaveURL(/\/apps\?/);
  await expect(page.getByText("Control Plane")).toBeVisible();
  await expect(page.getByRole("tab", { name: "Builds" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(page.getByText("New Build Package")).toBeVisible();
  await expect(page.getByRole("radio", { name: "WEBSITE" })).toHaveAttribute(
    "aria-checked",
    "true",
  );
  await expect(page.getByRole("radio")).toHaveCount(4);
  await expect(page.getByLabel("Target Name")).toHaveValue("Mobile QA");
  await expect(page.getByLabel("Requirements")).toHaveValue(
    "Create a website named Mobile QA",
  );

  await page.getByLabel("Constraints").fill("Do not deploy or publish.");
  await page.getByLabel("Brand Direction").fill("Quiet monochrome.");
  await page.getByRole("button", { name: "Create", exact: true }).click();

  await expect
    .poll(() => api.submittedRequest()?.targetType)
    .toBe("website");
  await expect
    .poll(() => api.submittedRequest()?.targetName)
    .toBe("Mobile QA");
  await expect(page.getByText("Working on it... 0%")).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Cancel this build run" }),
  ).toBeVisible();

  await expect(page.getByText("PACKAGE CONTENTS (REV 1)")).toBeVisible({
    timeout: 15_000,
  });
  await expect(page.getByText("Keyboard-accessible navigation")).toBeVisible();
  await expect(page.getByText("All controls are keyboard accessible")).toBeVisible();
  await expect(
    page.getByText("Do not execute, publish, or deploy anything"),
  ).toBeVisible();
  await expect(page.getByText("HISTORY")).toBeVisible();

  await page
    .getByRole("button", { name: "Approve this build package revision" })
    .click();
  const approvalDialog = page.getByRole("alert");
  await expect(approvalDialog).toContainText("Approve Revision 1");
  await expect(approvalDialog).toContainText(
    "It does not execute, publish, or deploy anything.",
  );
  await approvalDialog.getByRole("button", { name: "Cancel" }).click();

  await page
    .getByRole("button", { name: "Reject this build package" })
    .click();
  await page
    .getByLabel("Rejection Reason")
    .fill("Requirements need another review.");
  await page.getByRole("alert").getByRole("button", { name: "Reject" }).click();
  await expect(
    page.getByText("Cancelled: Requirements need another review."),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Retry cancelled build" }),
  ).toBeVisible();
});