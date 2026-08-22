import { expect, test, type Page } from "@playwright/test";

/**
 * The phone Brain filter (Task #281): unsorted holdings stay off the Brain
 * tab's personal graph and deep-link into the Brain page's Unsorted layer,
 * where they can be kept personal; automatic filings into a workspace show
 * up there as notices with a one-tap undo.
 */

const STORAGE_KEY = "@venom_state_v2:venom-ui-test";
const NOW = 1_755_600_000_000;

function cluster(overrides: Record<string, unknown>) {
  return {
    projectId: "proj_default",
    category: "core",
    strength: 0.7,
    x: 45,
    y: 40,
    links: [],
    mentionCount: 1,
    lastUpdatedAt: NOW,
    sources: [],
    ...overrides,
  };
}

const SEEDED_STATE = {
  projects: [
    {
      id: "proj_default",
      name: "General",
      description: "Uncategorized intelligence",
      accent: "#73736f",
      sourceCount: 0,
      updatedAt: NOW,
    },
  ],
  conversations: [
    {
      id: "conv_seed",
      title: "Planning",
      projectId: "proj_default",
      updatedAt: NOW,
      messages: [],
    },
  ],
  clusters: [
    cluster({
      id: "cl_sorted",
      label: "Pricing Notes",
      description: "Sorted personal knowledge.",
      summary: "Pricing structure Venom is sure belongs to the author.",
    }),
    cluster({
      id: "cl_unsorted",
      label: "Vendor Rates",
      x: 65,
      y: 60,
      description: "Extraction Venom was not confident about.",
      summary: "Quoted rates that could be personal or company knowledge.",
      unsorted: true,
    }),
  ],
  sources: [],
  activeProjectId: "proj_default",
  activeConversationId: "conv_seed",
};

async function seedState(page: Page) {
  await page.addInitScript(
    ({ key, value }) => window.localStorage.setItem(key, value),
    { key: STORAGE_KEY, value: JSON.stringify(SEEDED_STATE) },
  );
}

async function stubMoves(
  page: Page,
  body: { notices: unknown[]; suggestions: unknown[] } = {
    notices: [],
    suggestions: [],
  },
) {
  await page.route("**/api/venom/knowledge/moves", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(body),
    }),
  );
}

test.beforeEach(({}, testInfo) => {
  test.skip(
    testInfo.project.name !== "mobile-chromium",
    "The Brain filter is read from the mobile workspace.",
  );
});

test("unsorted holdings stay off the Brain tab and deep-link into review", async ({
  page,
}) => {
  await seedState(page);
  await stubMoves(page);

  await page.goto("/?venomUiTest=true&slimeTier=off");
  await expect(page.getByTestId("chat-input")).toBeVisible();

  const brainTab = page.getByRole("tab", { name: "Open Brain workspace" });
  await brainTab.click();
  await expect(brainTab).toHaveAttribute("aria-selected", "true");

  // The tab graph shows sorted knowledge only; the held-back item is a pill,
  // not a node.
  await expect(page.getByTestId("knowledge-cluster-cl_sorted")).toBeVisible();
  await expect(page.getByTestId("knowledge-cluster-cl_unsorted")).toHaveCount(
    0,
  );
  const pill = page.getByTestId("brain-unsorted-pill");
  await expect(pill).toContainText("Unsorted 1");

  // The pill lands straight in the Brain page's Unsorted layer.
  await pill.click();
  await expect(page.getByTestId("badge-unsorted-count")).toHaveText("1");
  await expect(page.getByTestId("knowledge-map-node-cl_unsorted")).toBeVisible();
  await expect(page.getByTestId("knowledge-map-node-cl_sorted")).toHaveCount(0);
});

test("keeping an unsorted item personal empties the holding area", async ({
  page,
}) => {
  await seedState(page);
  await stubMoves(page);

  await page.goto("/knowledge?venomUiTest=true&scope=unsorted");
  await expect(page.getByTestId("knowledge-map-node-cl_unsorted")).toBeVisible();

  await page.getByTestId("knowledge-map-node-cl_unsorted").click();
  const review = page.getByTestId("panel-unsorted-review");
  await expect(review).toBeVisible();
  await expect(page.getByTestId("badge-unsorted-concept")).toBeVisible();

  await page.getByTestId("button-keep-personal").click();

  // The holding area empties; the concept is ordinary personal knowledge now.
  await expect(page.getByTestId("brain-unsorted-empty")).toBeVisible();
  await expect(page.getByTestId("badge-unsorted-count")).toHaveCount(0);
  await page.getByTestId("brain-layer-personal").click();
  await expect(page.getByTestId("knowledge-map-node-cl_unsorted")).toBeVisible();
});

test("an automatic filing into a workspace can be undone in one tap", async ({
  page,
}) => {
  await seedState(page);

  let undone = false;
  await page.route("**/api/venom/knowledge/moves", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        notices: undone
          ? []
          : [
              {
                id: "mv_1",
                kind: "auto_file",
                status: "active",
                direction: "unsorted_to_workspace",
                workspaceId: "7d9f3c60-2222-4a4a-9c9c-3c3c3c3c3c3c",
                workspaceName: "Symbiote Ops",
                labels: ["Vendor Rates"],
                createdAt: new Date(NOW).toISOString(),
              },
            ],
        suggestions: [],
      }),
    }),
  );
  await page.route("**/api/venom/knowledge/moves/mv_1/undo", (route) => {
    undone = true;
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ restored: [] }),
    });
  });

  await page.goto("/knowledge?venomUiTest=true");

  const notice = page.getByTestId("move-notice-mv_1");
  await expect(page.getByTestId("brain-move-activity")).toBeVisible();
  await expect(notice).toContainText("Vendor Rates");
  await expect(notice).toContainText("Symbiote Ops");

  const undoRequest = page.waitForRequest(
    (request) =>
      request.url().includes("/api/venom/knowledge/moves/mv_1/undo") &&
      request.method() === "POST",
  );
  await page.getByTestId("button-undo-move-mv_1").click();
  await undoRequest;

  await expect(notice).toHaveCount(0);
  await expect(page.getByTestId("brain-moves-message")).toBeVisible();
});
