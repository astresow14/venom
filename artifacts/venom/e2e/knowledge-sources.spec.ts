import { expect, test, type Page } from "@playwright/test";

const CITATIONS = [
  {
    id: "cite_repository_overview",
    provider: "github",
    kind: "repository",
    title: "acme/venom",
    url: "https://github.com/acme/venom",
    excerpt: "Mobile intelligence workspace for connected project sources.",
    reference: "acme/venom",
  },
  {
    id: "cite_repository_readme",
    provider: "github",
    kind: "document",
    title: "README.md",
    url: "https://github.com/acme/venom/blob/main/README.md",
    excerpt: "How the workspace is structured and how sources are connected.",
    reference: "acme/venom#readme",
  },
];

const REPOSITORY_SOURCE = {
  id: "source_acme_venom",
  projectId: "proj_default",
  provider: "github",
  name: "acme/venom",
  url: "https://github.com/acme/venom",
  status: "connected",
  syncedAt: new Date().toISOString(),
  summary: "acme/venom • 4 open items • 1 active pull requests",
  context: CITATIONS.map(
    (citation) =>
      `[source:${citation.id}] ${citation.title}. ${citation.excerpt} (${citation.url})`,
  ).join(" "),
  citations: CITATIONS,
  clusters: [
    {
      id: "source_acme_venom_repository",
      label: "acme/venom",
      category: "repository",
      strength: 1,
      citationIds: CITATIONS.map((citation) => citation.id),
    },
    // A weak sub-topic whose label sits below the map's 0.8 strength
    // threshold, so only the map search can surface it out of the crowd.
    {
      id: "source_acme_venom_sync",
      label: "Sync pipeline",
      category: "architecture",
      strength: 0.45,
      citationIds: [CITATIONS[1].id],
    },
  ],
  attestation: "v1.ui-test-attestation",
};

/**
 * Serves the GitHub connect endpoints from fixtures and records the URLs the
 * app asks the platform to open, so citation links can be asserted on.
 */
async function stubConnectedSource(page: Page) {
  await page.addInitScript(() => {
    const opened: string[] = [];
    (window as unknown as { __venomOpenedUrls: string[] }).__venomOpenedUrls =
      opened;
    window.open = ((url?: string | URL) => {
      opened.push(String(url ?? ""));
      return null;
    }) as typeof window.open;
  });

  await page.route("**/api/venom/github/repositories", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify([
        {
          fullName: "acme/venom",
          name: "venom",
          description: "Mobile intelligence workspace",
          url: "https://github.com/acme/venom",
          updatedAt: "2026-08-01T10:00:00.000Z",
        },
      ]),
    }),
  );

  await page.route("**/api/venom/projects/*/sources/github", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(REPOSITORY_SOURCE),
    }),
  );
}

function openedUrls(page: Page) {
  return page.evaluate(
    () =>
      (window as unknown as { __venomOpenedUrls: string[] }).__venomOpenedUrls,
  );
}

test.beforeEach(({}, testInfo) => {
  test.skip(
    testInfo.project.name !== "mobile-chromium",
    "Connected sources are browsed from the mobile settings screen.",
  );
});

/**
 * Connects the stubbed repository and lands on the knowledge screen's sources
 * view, which is the entry point both browse and filter tests start from.
 */
async function openConnectedSources(page: Page) {
  await stubConnectedSource(page);

  await page.goto("/?venomUiTest=true");
  await expect(page.getByTestId("chat-input")).toBeVisible();

  // Connect a repository so the project has a source to browse.
  await page.getByTestId("open-settings").click();
  await page.getByTestId("open-github-source-picker").click();
  await page.getByTestId("connect-github-acme/venom").click();
  await expect(
    page.getByTestId(`remove-source-${REPOSITORY_SOURCE.id}`),
  ).toBeVisible();

  // The settings entry point reaches the knowledge screen on its sources view.
  await page.getByTestId("open-connected-sources").click();
}

test("browses connected sources from settings and opens a citation", async ({
  page,
}) => {
  await openConnectedSources(page);

  const sourceList = page.getByTestId("knowledge-source-list");
  await expect(sourceList).toBeVisible();
  await expect(
    page.getByTestId(`knowledge-source-${REPOSITORY_SOURCE.id}`),
  ).toBeVisible();
  await expect(
    page.getByTestId(`knowledge-source-meta-${REPOSITORY_SOURCE.id}`),
  ).toContainText("2 citations");

  // Every citation of the connected source is listed.
  for (const citation of CITATIONS) {
    await expect(page.getByTestId(`knowledge-citation-${citation.id}`)).toContainText(
      citation.title,
    );
  }

  // Opening a citation hands its URL to the platform.
  await page.getByTestId(`knowledge-citation-${CITATIONS[1].id}`).click();
  await expect.poll(() => openedUrls(page)).toContain(CITATIONS[1].url);

  // The map stays reachable from the same screen.
  await page.getByTestId("knowledge-view-map").click();
  await expect(sourceList).toBeHidden();
});

test("searches the map and opens a matched cluster", async ({ page }) => {
  await openConnectedSources(page);

  const [repoCluster, syncCluster] = REPOSITORY_SOURCE.clusters;

  // The connected source's weak cluster starts as an unlabelled dot.
  await page.getByTestId("knowledge-view-map").click();
  const syncNode = page.getByTestId(`knowledge-map-node-${syncCluster.id}`);
  await expect(syncNode).toBeVisible();
  await expect(
    page.getByTestId(`knowledge-map-label-${syncCluster.id}`),
  ).toHaveCount(0);

  // Searching by label surfaces the weak cluster's label and dims the rest
  // without removing them from the map.
  const mapSearch = page.getByTestId("knowledge-map-search");
  await mapSearch.fill("pipeline");
  await expect(
    page.getByTestId(`knowledge-map-label-${syncCluster.id}`),
  ).toHaveText(syncCluster.label);
  await expect(page.getByTestId("knowledge-map-match-count")).toContainText(
    /1 of \d+ clusters match/,
  );
  const repoNode = page.getByTestId(`knowledge-map-node-${repoCluster.id}`);
  await expect(repoNode).toBeVisible();
  await expect(repoNode).toHaveCSS("opacity", "0.25");
  await expect(syncNode).toHaveCSS("opacity", "1");

  // The category is searchable too, and finds the same cluster.
  await mapSearch.fill("architecture");
  await expect(
    page.getByTestId(`knowledge-map-label-${syncCluster.id}`),
  ).toBeVisible();

  // Selecting the match opens the existing cluster detail panel.
  await syncNode.click();
  const detail = page.getByTestId("knowledge-map-detail");
  await expect(detail).toBeVisible();
  await expect(detail).toContainText(syncCluster.label);
  await expect(detail).toContainText(syncCluster.category);
  await expect(
    detail.getByTestId(`knowledge-citation-${CITATIONS[1].id}`),
  ).toBeVisible();

  // Clearing the search restores every node to full presence.
  await page.getByTestId("knowledge-map-search-clear").click();
  await expect(page.getByTestId("knowledge-map-match-count")).toHaveCount(0);
  await expect(repoNode).toHaveCSS("opacity", "1");
});

test("filters the sources view down to a single citation and opens it", async ({
  page,
}) => {
  await openConnectedSources(page);

  const [overview, readme] = CITATIONS;
  await expect(page.getByTestId(`knowledge-citation-${overview.id}`)).toBeVisible();

  // Filtering by a citation title narrows the source to that one citation.
  const filterInput = page.getByTestId("knowledge-source-filter");
  await filterInput.fill("README");
  await expect(page.getByTestId(`knowledge-citation-${readme.id}`)).toBeVisible();
  await expect(page.getByTestId(`knowledge-citation-${overview.id}`)).toBeHidden();
  await expect(
    page.getByTestId(`knowledge-source-meta-${REPOSITORY_SOURCE.id}`),
  ).toContainText("1 of 2 citations");

  // The surviving citation still opens its URL.
  await page.getByTestId(`knowledge-citation-${readme.id}`).click();
  await expect.poll(() => openedUrls(page)).toContain(readme.url);

  // Excerpt text is searchable too, and a filter with no matches explains itself
  // while keeping the connected sources one click away.
  await filterInput.fill("structured");
  await expect(page.getByTestId(`knowledge-citation-${readme.id}`)).toBeVisible();

  await filterInput.fill("nothing matches this");
  const emptyState = page.getByTestId("knowledge-filter-empty");
  await expect(emptyState).toContainText("1 connected source");
  await expect(
    page.getByTestId(`knowledge-source-${REPOSITORY_SOURCE.id}`),
  ).toBeHidden();
  await expect(page.getByTestId("knowledge-sources-empty")).toBeHidden();

  // Clearing the filter brings every source and citation back.
  await page.getByTestId("knowledge-filter-empty-clear").click();
  await expect(emptyState).toBeHidden();
  for (const citation of CITATIONS) {
    await expect(page.getByTestId(`knowledge-citation-${citation.id}`)).toBeVisible();
  }
});
