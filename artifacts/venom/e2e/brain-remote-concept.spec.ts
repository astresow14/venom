import { expect, test, type Page } from "@playwright/test";

/**
 * Brain search covers the whole server-side ontology, which can hold more
 * concepts than the device keeps locally. A hit the device has not cached
 * must still open — summary, evidence, linked concepts — served on demand,
 * and it must degrade to a clear "connect to view evidence" state offline.
 */

const REMOTE_CONCEPT_ID = "concept_vendor_contracts";

const SEARCH_RESULTS = {
  results: [
    {
      id: REMOTE_CONCEPT_ID,
      projectId: "proj_beyond",
      label: "Vendor Contracts",
      category: "external",
      summary: "Contract terms negotiated with suppliers.",
      strength: 0.8,
      mentionCount: 6,
      lastUpdatedAt: 1700000000000,
      evidenceCount: 2,
    },
  ],
};

const CONCEPT_DETAIL = {
  concept: {
    id: REMOTE_CONCEPT_ID,
    projectId: "proj_beyond",
    label: "Vendor Contracts",
    category: "external",
    strength: 0.8,
    x: 0,
    y: 0,
    links: [],
    description: "Contract terms negotiated with suppliers.",
    summary: "Contract terms negotiated with suppliers over the last quarter.",
    mentionCount: 6,
    lastUpdatedAt: 1700000000000,
    sources: [
      {
        conversationId: "conv_supplier_review",
        projectId: "proj_beyond",
        conversationTitle: "Supplier review",
        messageIds: ["m1"],
        excerpt: "Acme renewal lands in March with a 12% uplift cap.",
        updatedAt: 1700000000000,
      },
      {
        conversationId: "conv_pricing_sync",
        projectId: "proj_beyond",
        conversationTitle: "Pricing sync",
        messageIds: ["m2"],
        excerpt: "Volume discount only applies beyond 10k seats.",
        updatedAt: 1700000000000,
      },
    ],
  },
  neighbors: [
    {
      id: "1",
      projectId: "proj_default",
      label: "Core Intelligence",
      category: "core",
      summary: "System design and structural patterns for the workspace.",
      strength: 1,
      mentionCount: 1,
      lastUpdatedAt: 0,
      evidenceCount: 0,
    },
    {
      id: "concept_renewal_risks",
      projectId: "proj_beyond",
      label: "Renewal Risks",
      category: "tactical",
      summary: "Contracts approaching renewal with open questions.",
      strength: 0.6,
      mentionCount: 3,
      lastUpdatedAt: 1700000000000,
      evidenceCount: 1,
    },
  ],
};

async function stubOntologySearch(page: Page) {
  await page.route("**/api/venom/ontology/search**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(SEARCH_RESULTS),
    }),
  );
}

async function openBrainAndSearch(page: Page, term: string) {
  await page.goto("/?venomUiTest=true");
  await expect(page.getByTestId("chat-input")).toBeVisible();
  const tab = page.getByRole("tab", { name: "Open Brain workspace" });
  await tab.click();
  await expect(tab).toHaveAttribute("aria-selected", "true");
  await page.getByTestId("brain-search-input").fill(term);
}

test.beforeEach(({}, testInfo) => {
  test.skip(
    testInfo.project.name !== "mobile-chromium",
    "Brain search is read from the mobile workspace.",
  );
});

test("a hit the device has not cached opens server-backed evidence", async ({
  page,
}) => {
  await stubOntologySearch(page);
  await page.route(
    `**/api/venom/ontology/concepts/${REMOTE_CONCEPT_ID}`,
    (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(CONCEPT_DETAIL),
      }),
  );

  await openBrainAndSearch(page, "vendor");
  await page.getByTestId(`brain-search-result-${REMOTE_CONCEPT_ID}`).click();

  const details = page.getByTestId("knowledge-remote-details");
  await expect(details).toBeVisible();
  await expect(details).toContainText(
    "Contract terms negotiated with suppliers over the last quarter.",
  );
  await expect(details).toContainText("Evidence · 2");
  await expect(
    details.getByTestId("knowledge-remote-source-conv_supplier_review"),
  ).toContainText("Acme renewal lands in March with a 12% uplift cap.");
  await expect(
    details.getByTestId("knowledge-remote-source-conv_pricing_sync"),
  ).toContainText("Volume discount only applies beyond 10k seats.");

  // A linked concept that lives on this device jumps to the local map view.
  await details.getByTestId("knowledge-remote-neighbor-1").click();
  await expect(page.getByTestId("knowledge-remote-details")).toHaveCount(0);
  await expect(page.getByTestId("knowledge-cluster-details")).toBeVisible();
  await expect(page.getByTestId("knowledge-cluster-details")).toContainText(
    "Core Intelligence",
  );
});

test("offline shows a connect-to-view state and retry recovers", async ({
  page,
}) => {
  await stubOntologySearch(page);

  let conceptCalls = 0;
  await page.route("**/api/venom/ontology/concepts/**", async (route) => {
    conceptCalls += 1;
    if (conceptCalls === 1) {
      await route.abort();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(CONCEPT_DETAIL),
    });
  });

  await openBrainAndSearch(page, "vendor");
  await page.getByTestId(`brain-search-result-${REMOTE_CONCEPT_ID}`).click();

  const offline = page.getByTestId("knowledge-remote-offline");
  await expect(offline).toBeVisible();
  await expect(offline).toContainText("Connect to view evidence");

  await page.getByTestId("knowledge-remote-retry").click();
  await expect(page.getByTestId("knowledge-remote-details")).toContainText(
    "Evidence · 2",
  );
});

test("a concept deleted elsewhere reads as gone, not as an error", async ({
  page,
}) => {
  await stubOntologySearch(page);
  await page.route("**/api/venom/ontology/concepts/**", (route) =>
    route.fulfill({
      status: 404,
      contentType: "application/json",
      body: JSON.stringify({ message: "Concept not found" }),
    }),
  );

  await openBrainAndSearch(page, "vendor");
  await page.getByTestId(`brain-search-result-${REMOTE_CONCEPT_ID}`).click();

  const missing = page.getByTestId("knowledge-remote-missing");
  await expect(missing).toBeVisible();
  await expect(missing).toContainText("no longer in your knowledge base");
});
