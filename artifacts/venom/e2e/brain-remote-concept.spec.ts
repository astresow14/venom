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
  // slimeTier=off: remote concept panels never touch the goo layer.
  await page.goto("/?venomUiTest=true&slimeTier=off");
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

/**
 * The cited conversation behind the first evidence row, as the read-only
 * conversation GET serves it from the cloud snapshot.
 */
const REMOTE_CONVERSATION = {
  conversation: {
    id: "conv_supplier_review",
    title: "Supplier review",
    projectId: "proj_beyond",
    updatedAt: 1700000000000,
    messages: [
      {
        id: "m1",
        role: "user",
        content: "Where did the Acme renewal land?",
        createdAt: 1699999990000,
        status: "sent",
      },
      {
        id: "m2",
        role: "assistant",
        content: "Acme renewal lands in March with a 12% uplift cap.",
        createdAt: 1700000000000,
        status: "sent",
        speakerName: "The Analyst",
      },
    ],
  },
  projectName: "Beyond Ops",
};

async function openRemoteConceptEvidence(page: Page) {
  await openBrainAndSearch(page, "vendor");
  await page.getByTestId(`brain-search-result-${REMOTE_CONCEPT_ID}`).click();
  await expect(page.getByTestId("knowledge-remote-details")).toBeVisible();
}

test("an evidence row opens the cited conversation from the cloud", async ({
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
  await page.route("**/api/venom/conversations/conv_supplier_review", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(REMOTE_CONVERSATION),
    }),
  );

  await openRemoteConceptEvidence(page);
  await page
    .getByTestId("knowledge-remote-source-conv_supplier_review")
    .click();

  const panel = page.getByTestId("knowledge-conversation-details");
  await expect(panel).toBeVisible();
  await expect(panel).toContainText("Supplier review");
  await expect(panel).toContainText("Beyond Ops · read-only");
  await expect(
    panel.getByTestId("knowledge-conversation-message-m1"),
  ).toContainText("Where did the Acme renewal land?");
  await expect(
    panel.getByTestId("knowledge-conversation-message-m2"),
  ).toContainText("The Analyst");
  await expect(
    panel.getByTestId("knowledge-conversation-message-m2"),
  ).toContainText("Acme renewal lands in March with a 12% uplift cap.");

  // Closing the transcript returns to the concept's evidence list, so the
  // trail of proof can be walked row by row.
  await panel.getByTestId("knowledge-conversation-close").click();
  await expect(page.getByTestId("knowledge-conversation-details")).toHaveCount(
    0,
  );
  await expect(page.getByTestId("knowledge-remote-details")).toBeVisible();
});

test("offline, an evidence row degrades to connect-to-view and retry recovers", async ({
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

  let conversationCalls = 0;
  await page.route("**/api/venom/conversations/**", async (route) => {
    conversationCalls += 1;
    if (conversationCalls === 1) {
      await route.abort();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(REMOTE_CONVERSATION),
    });
  });

  await openRemoteConceptEvidence(page);
  await page
    .getByTestId("knowledge-remote-source-conv_supplier_review")
    .click();

  const offline = page.getByTestId("knowledge-conversation-offline");
  await expect(offline).toBeVisible();
  await expect(offline).toContainText("Connect to view this conversation");

  await page.getByTestId("knowledge-conversation-retry").click();
  await expect(
    page.getByTestId("knowledge-conversation-message-m2"),
  ).toContainText("12% uplift cap");
});

test("a cited conversation deleted elsewhere reads as gone, not as an error", async ({
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
  await page.route("**/api/venom/conversations/**", (route) =>
    route.fulfill({
      status: 404,
      contentType: "application/json",
      body: JSON.stringify({ error: "Conversation not found" }),
    }),
  );

  await openRemoteConceptEvidence(page);
  await page
    .getByTestId("knowledge-remote-source-conv_supplier_review")
    .click();

  const missing = page.getByTestId("knowledge-conversation-missing");
  await expect(missing).toBeVisible();
  await expect(missing).toContainText("no longer in your synced workspace");
});

test("an evidence row whose conversation is on this device opens it in Chat", async ({
  page,
}) => {
  await stubOntologySearch(page);
  // The default UI-test workspace seeds conv_default in proj_default, so a
  // concept citing it must jump to Chat instead of the read-only panel.
  const localCiteDetail = {
    ...CONCEPT_DETAIL,
    concept: {
      ...CONCEPT_DETAIL.concept,
      sources: [
        {
          conversationId: "conv_default",
          projectId: "proj_default",
          conversationTitle: "New Session",
          messageIds: [],
          excerpt: "The seeded conversation on this device.",
          updatedAt: 1700000000000,
        },
      ],
    },
  };
  await page.route(
    `**/api/venom/ontology/concepts/${REMOTE_CONCEPT_ID}`,
    (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(localCiteDetail),
      }),
  );

  await openRemoteConceptEvidence(page);
  await page.getByTestId("knowledge-remote-source-conv_default").click();

  await expect(
    page.getByTestId("knowledge-conversation-details"),
  ).toHaveCount(0);
  const chatTab = page.getByRole("tab", { name: "Open Chat workspace" });
  await expect(chatTab).toHaveAttribute("aria-selected", "true");
});
