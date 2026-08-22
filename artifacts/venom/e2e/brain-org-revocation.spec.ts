import { expect, test, type Page } from "@playwright/test";

/**
 * Revocation must land on an already-open phone immediately. The Brain tab
 * renders company concepts from memory, so if an admin removes a member the
 * 25s directory poll is a real disclosure window — the membership event
 * stream closes it. This spec proves the push path end to end in the UI.
 *
 * `page.route` fulfills atomically, so the event stream is produced inside
 * the page by wrapping `window.fetch` (the app reads it through `expo/fetch`,
 * which is `globalThis.fetch` on web); pushing an event is exposed to the
 * test as `window.__pushOrgEvent`.
 */

const ORG_ID = "org_acme";
const COMPANY_CONCEPT_ID = "org_concept_pricing";
const COMPANY_CONCEPT_LABEL = "Pricing Playbook";

const DIRECTORY = {
  orgs: [
    {
      id: ORG_ID,
      name: "Acme Co",
      role: "member",
      memberCount: 3,
      createdAt: 1700000000000,
    },
  ],
  invites: [],
};

const EMPTY_DIRECTORY = { orgs: [], invites: [] };

const ORG_BRAIN = {
  orgId: ORG_ID,
  orgName: "Acme Co",
  concepts: [
    {
      id: COMPANY_CONCEPT_ID,
      projectId: "org_shared",
      label: COMPANY_CONCEPT_LABEL,
      category: "topic",
      strength: 1,
      x: 0,
      y: 0,
      links: [],
      sources: [
        {
          conversationId: "org_conv_pricing",
          projectId: "org_shared",
          conversationTitle: "Enterprise pricing sync",
          messageIds: ["m1"],
          excerpt: "Enterprise deals anchor at $50k with a 20% services attach.",
          updatedAt: 1700000000000,
          capturedByUserId: null,
          capturedAt: null,
        },
      ],
      summary: "How Acme prices enterprise deals.",
      mentionCount: 4,
      lastUpdatedAt: 1700000000000,
    },
  ],
  audit: [],
};

async function stubOrgEventsStream(page: Page) {
  await page.addInitScript(() => {
    const sinks: Array<(chunk: string) => void> = [];
    (window as unknown as Record<string, unknown>).__pushOrgEvent = (
      payload: unknown,
    ) => {
      for (const sink of sinks) {
        sink(`data: ${JSON.stringify(payload)}\n\n`);
      }
    };
    const originalFetch = window.fetch.bind(window);
    window.fetch = (async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ): Promise<Response> => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : input.url;
      if (!url.includes("/api/venom/orgs/events")) {
        return originalFetch(input as RequestInfo, init);
      }
      const encoder = new TextEncoder();
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode('data: {"type":"connected"}\n\n'));
          sinks.push((chunk) => controller.enqueue(encoder.encode(chunk)));
        },
      });
      return new Response(stream, {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      });
    }) as typeof window.fetch;
  });
}

test.beforeEach(({}, testInfo) => {
  test.skip(
    testInfo.project.name !== "mobile-chromium",
    "Company-layer revocation is exercised at the mobile viewport.",
  );
});

test("removal event clears the open company layer before any poll", async ({
  page,
}) => {
  let removed = false;
  await page.route("**/api/venom/orgs", async (route) => {
    if (route.request().method() !== "GET") {
      await route.fallback();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(removed ? EMPTY_DIRECTORY : DIRECTORY),
    });
  });
  await page.route(`**/api/venom/orgs/${ORG_ID}/projects`, (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ projects: [] }),
    }),
  );
  await page.route(`**/api/venom/orgs/${ORG_ID}/brain`, (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(ORG_BRAIN),
    }),
  );
  await stubOrgEventsStream(page);

  // slimeTier=off: the company layer never touches the goo layer.
  await page.goto("/?venomUiTest=true&venomUiTestOrgs=1&slimeTier=off");

  const brainTab = page.getByRole("tab", { name: "Open Brain workspace" });
  await brainTab.click();
  await expect(brainTab).toHaveAttribute("aria-selected", "true");

  // The member opens the company layer and sees shared knowledge.
  const switcher = page.getByTestId("brain-layer-switcher");
  await expect(switcher).toBeVisible();
  await page.getByTestId(`brain-layer-${ORG_ID}`).click();
  const companyCluster = page.getByTestId(
    `knowledge-cluster-${COMPANY_CONCEPT_ID}`,
  );
  await expect(companyCluster).toBeVisible();

  // Open the details sheet: label, summary, provenance, and the evidence
  // excerpt render from the org snapshot held in memory — exactly the
  // state that must not survive removal.
  await companyCluster.click();
  const details = page.getByTestId("knowledge-cluster-details");
  await expect(details).toBeVisible();
  await expect(details).toContainText(COMPANY_CONCEPT_LABEL);
  await expect(details).toContainText("Enterprise deals anchor");

  // Search is also answering from the company pool.
  const searchInput = page.getByTestId("brain-search-input");
  await searchInput.fill("Pricing");
  const searchHit = page.getByTestId(
    `brain-search-result-${COMPANY_CONCEPT_ID}`,
  );
  await expect(searchHit).toBeVisible();

  // An admin removes the member; the server pushes membership-changed to
  // the open stream. From here on the directory says "no companies".
  removed = true;
  await page.evaluate(() => {
    (
      window as unknown as {
        __pushOrgEvent: (payload: unknown) => void;
      }
    ).__pushOrgEvent({ type: "membership-changed", orgId: "org_acme" });
  });

  // Immediately — no 25s poll, no clock games — every trace of company
  // content is gone in one commit: the map node, the open details sheet
  // with its label and evidence, and the search results. Short timeouts
  // keep this inside any poll interval.
  await expect(companyCluster).toHaveCount(0, { timeout: 4000 });
  await expect(details).toHaveCount(0, { timeout: 4000 });
  // The switcher itself stays — the Venom network layer is available to
  // every account — but the org pill is gone.
  await expect(page.getByTestId(`brain-layer-${ORG_ID}`)).toHaveCount(0, {
    timeout: 4000,
  });
  await expect(switcher).toBeVisible();
  await expect(searchHit).toHaveCount(0);
  await expect(searchInput).toHaveValue("");
  await expect(page.getByText("Enterprise deals anchor")).toHaveCount(0);
});
