import { expect, test, type Page, type Route } from "@playwright/test";

const ACTIVE_SOP_ID = "11111111-1111-4111-8111-111111111111";
const DRAFT_SOP_ID = "22222222-2222-4222-8222-222222222222";
const ARCHIVED_SOP_ID = "33333333-3333-4333-8333-333333333333";
const REVISION_ONE_ID = "44444444-4444-4444-8444-444444444444";
const REVISION_TWO_ID = "55555555-5555-4555-8555-555555555555";
const CHECKSUM_ONE = "1".repeat(64);
const CHECKSUM_TWO = "2".repeat(64);
const NOW = "2026-08-20T12:00:00.000Z";

const activeContent = {
  purpose: "Resolve customer escalations with a reviewable response plan.",
  prerequisites: ["Confirm the account and issue scope."],
  inputs: ["Customer message", "Approved service policy"],
  guidance: [
    "Summarize the issue without exposing private customer data.",
    "Draft a response and pause for the required approval.",
  ],
  requiredApprovals: ["Customer support lead approval"],
  acceptanceChecks: ["Response matches the approved service policy."],
};

const activeSop = {
  id: ACTIVE_SOP_ID,
  title: "Customer escalation review",
  lifecycle: "active",
  category: "customer_service",
  tags: ["support", "approval"],
  provenance: "model_assisted",
  content: activeContent,
  activeRevisionId: REVISION_TWO_ID,
  activeRevisionNumber: 2,
  appIds: [],
  createdAt: NOW,
  updatedAt: NOW,
  archivedAt: null,
};

const draftSop = {
  ...activeSop,
  id: DRAFT_SOP_ID,
  title: "Draft launch review",
  lifecycle: "draft",
  provenance: "manual",
  activeRevisionId: null,
  activeRevisionNumber: null,
};

const archivedSop = {
  ...activeSop,
  id: ARCHIVED_SOP_ID,
  title: "Archived incident review",
  lifecycle: "archived",
  provenance: "imported",
  archivedAt: NOW,
};

const revisions = [
  {
    id: REVISION_TWO_ID,
    versionNumber: 2,
    provenance: "model_assisted",
    checksumSha256: CHECKSUM_TWO,
    title: activeSop.title,
    category: activeSop.category,
    tags: activeSop.tags,
    content: activeContent,
    publishedAt: NOW,
  },
  {
    id: REVISION_ONE_ID,
    versionNumber: 1,
    provenance: "model_assisted",
    checksumSha256: CHECKSUM_ONE,
    title: activeSop.title,
    category: activeSop.category,
    tags: activeSop.tags,
    content: {
      ...activeContent,
      purpose: "Resolve customer escalations using the approved policy.",
      guidance: ["Draft a response for human review."],
    },
    publishedAt: "2026-08-19T12:00:00.000Z",
  },
];

function selection() {
  return {
    sopId: ACTIVE_SOP_ID,
    revisionId: REVISION_TWO_ID,
    revisionNumber: 2,
    title: activeSop.title,
    category: activeSop.category,
    purpose: activeContent.purpose,
    selectedAt: NOW,
  };
}

async function installSopApi(page: Page) {
  let selected = true;
  await page.route("**/api/venom/**", async (route: Route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;

    if (path === "/api/venom/projects/proj_default/sops") {
      if (request.method() === "PUT") {
        const body = request.postDataJSON() as { sopIds: string[] };
        selected = body.sopIds.includes(ACTIVE_SOP_ID);
      }
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(selected ? [selection()] : []),
      });
      return;
    }

    if (path === `/api/venom/sops/${ACTIVE_SOP_ID}`) {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          sop: activeSop,
          revisions,
          assignments: [],
        }),
      });
      return;
    }

    if (path === `/api/venom/sops/${DRAFT_SOP_ID}`) {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          sop: draftSop,
          revisions: [],
          assignments: [],
        }),
      });
      return;
    }

    if (path === `/api/venom/sops/${ARCHIVED_SOP_ID}`) {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          sop: archivedSop,
          revisions: [revisions[0]],
          assignments: [],
        }),
      });
      return;
    }

    if (path === "/api/venom/sops") {
      const lifecycle = url.searchParams.get("lifecycle");
      const query = (url.searchParams.get("query") ?? "").toLowerCase();
      const byLifecycle =
        lifecycle === "draft"
          ? [draftSop]
          : lifecycle === "archived"
            ? [archivedSop]
            : lifecycle === "active"
              ? [activeSop]
              : [activeSop, draftSop, archivedSop];
      const matches = byLifecycle.filter((sop) =>
        sop.title.toLowerCase().includes(query),
      );
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(matches),
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

test("mobile procedures stay read-only, revision-pinned, and selectable", async ({
  page,
}, testInfo) => {
  test.setTimeout(300_000);
  test.skip(
    testInfo.project.name === "desktop-chromium",
    "The compact procedures flow is covered at the mobile viewport.",
  );
  await installSopApi(page);
  await page.goto("/sops?venomUiTest=true");

  await expect(page.getByTestId("sops-screen")).toBeVisible();
  await expect(page.getByText("Procedures", { exact: true })).toBeVisible();
  await expect(page.getByTestId("security-notice")).toContainText(
    "Do not enter credentials or regulated data",
  );
  await expect(page.getByLabel("Search procedures")).toBeVisible();
  await expect(
    page.getByRole("tab", { name: "Filter by Active" }),
  ).toHaveAttribute("aria-selected", "true");

  await page.getByLabel("Search procedures").fill("Customer escalation");
  const activeItem = page.getByTestId(`sop-list-item-${ACTIVE_SOP_ID}`);
  await expect(activeItem).toBeVisible();
  await expect(activeItem).toHaveAccessibleName(
    /Customer escalation review, Active, Customer Service, active for this project, imported or model-assisted/,
  );
  await page.screenshot({
    path: testInfo.outputPath("mobile-sop-list.png"),
    fullPage: true,
  });

  await activeItem.click();
  await expect(page.getByTestId("sop-detail-title")).toHaveText(
    activeSop.title,
  );
  await expect(page.getByText(activeContent.purpose)).toBeVisible();
  await expect(
    page.getByText("Customer support lead approval"),
  ).toBeVisible();
  await expect(
    page.getByText("Response matches the approved service policy."),
  ).toBeVisible();
  await expect(page.getByTestId("untrusted-banner-title")).toHaveText(
    "Untrusted Reference Material",
  );
  await expect(page.getByRole("textbox")).toHaveCount(1);
  await expect(
    page.getByRole("button", { name: /save|publish|archive|duplicate/i }),
  ).toHaveCount(0);

  await page.getByTestId("sop-revisions-toggle").click();
  const revisionOne = page.getByTestId(`sop-revision-${REVISION_ONE_ID}`);
  await expect(revisionOne).toHaveAttribute("aria-expanded", "false");
  await revisionOne.click();
  await expect(revisionOne).toHaveAttribute("aria-expanded", "true");
  await expect(
    page.getByText(`IMMUTABLE REVISION · ${REVISION_ONE_ID}`),
  ).toBeVisible();
  await expect(
    page.getByTestId(`sop-revision-checksum-${REVISION_ONE_ID}`),
  ).toHaveText(`SHA-256 · ${CHECKSUM_ONE}`);
  await expect(
    page.getByText("Resolve customer escalations using the approved policy."),
  ).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath("mobile-sop-revision.png"),
    fullPage: true,
  });

  const remove = page.getByRole("checkbox", {
    name: `Remove ${activeSop.title} from the active project`,
  });
  await expect(remove).toHaveAttribute("aria-checked", "true");
  await remove.click();
  const add = page.getByRole("checkbox", {
    name: `Add ${activeSop.title} to the active project`,
  });
  await expect(add).toHaveAttribute("aria-checked", "false");
  await add.click();
  await expect(
    page.getByRole("checkbox", {
      name: `Remove ${activeSop.title} from the active project`,
    }),
  ).toHaveAttribute("aria-checked", "true");

  await page.getByTestId("sop-detail-close").click();
  await page.getByLabel("Search procedures").clear();
  await page.getByRole("tab", { name: "Filter by Draft" }).click();
  const draftItem = page.getByTestId(`sop-list-item-${DRAFT_SOP_ID}`);
  await expect(draftItem).toHaveAccessibleName(
    /Draft launch review, Draft, Customer Service/,
  );
  await draftItem.click();
  await expect(
    page.getByText("Only active SOPs can be selected for a project."),
  ).toBeVisible();
  await expect(
    page.getByRole("checkbox", { name: /Draft launch review/ }),
  ).toHaveCount(0);

  await page.getByTestId("sop-detail-close").click();
  await page.getByRole("tab", { name: "Filter by Archived" }).click();
  const archivedItem = page.getByTestId(`sop-list-item-${ARCHIVED_SOP_ID}`);
  await expect(archivedItem).toHaveAccessibleName(
    /Archived incident review, Archived, Customer Service, imported or model-assisted/,
  );
  await archivedItem.click();
  await expect(
    page.getByText("Only active SOPs can be selected for a project."),
  ).toBeVisible();
  await expect(
    page.getByRole("checkbox", { name: /Archived incident review/ }),
  ).toHaveCount(0);
});