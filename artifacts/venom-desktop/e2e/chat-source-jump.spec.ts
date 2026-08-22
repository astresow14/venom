import { expect, test, type Page } from "@playwright/test";
import { mockChatStream } from "./support/chat-stream";
import { stubWorkspaceApis } from "./support/stubs";

/**
 * Following a cited desktop answer back to its evidence.
 *
 * A cited answer offers a chip under the bubble that opens the Brain's
 * sources view scrolled to the cited source — and, when the jump names the
 * exact citation the answer quoted, landed on that row itself, marked
 * "Quoted in your answer". Mirrors the mobile suite
 * (artifacts/venom/e2e/chat-source-jump.spec.ts); the desktop has no
 * source-connect surface of its own, so the four websites arrive through the
 * seeded workspace that UI-test mode reads at startup instead of a connect
 * flow.
 */

const STORAGE_KEY = "@venom_desktop_v1:venom-desktop-ui-test";
const NOW = 1_755_600_000_000;

const WEBSITES = [
  { slug: "handbook", name: "Handbook" },
  { slug: "roadmap", name: "Roadmap" },
  { slug: "runbook", name: "Runbook" },
  { slug: "changelog", name: "Changelog" },
] as const;

/** Enough citations per source that the quoted row sits well below the fold. */
const CITATIONS_PER_SOURCE = 20;

// The answer cites a row deep inside the LAST source, so landing on it
// proves a real scroll happened twice over: past three whole cards, then
// past fourteen rows inside the fourth.
const CITED_WEBSITE = WEBSITES[WEBSITES.length - 1];
const CITED_CITATION_INDEX = 15;
const CITED_SOURCE_ID = `source_${CITED_WEBSITE.slug}`;
const CITED_CITATION_ID = `cite_${CITED_WEBSITE.slug}_${CITED_CITATION_INDEX}`;
const CITED_CITATION_TITLE = `${CITED_WEBSITE.name} page ${CITED_CITATION_INDEX + 1}`;
const FIRST_SOURCE_ID = `source_${WEBSITES[0].slug}`;

/** A source id no workspace snapshot has ever held. */
const RETIRED_SOURCE_ID = "source_retired";

/** The second project a source can be filed under instead. */
const ATLAS_PROJECT_ID = "proj_atlas";
const ATLAS_SOURCE_SLUG = "atlas-notes";
const ATLAS_SOURCE_ID = `source_${ATLAS_SOURCE_SLUG}`;

function websiteSource(slug: string, name: string, projectId: string) {
  const citations = Array.from(
    { length: CITATIONS_PER_SOURCE },
    (_, index) => ({
      id: `cite_${slug}_${index}`,
      provider: "website",
      kind: "website",
      title: `${name} page ${index + 1}`,
      url: `https://example.com/${slug}/${index + 1}`,
      excerpt: `What the ${name.toLowerCase()} says about page ${index + 1}.`,
      reference: `${slug}/${index + 1}`,
    }),
  );
  return {
    id: `source_${slug}`,
    projectId,
    provider: "website",
    name,
    url: `https://example.com/${slug}`,
    status: "connected",
    syncedAt: new Date(NOW - 3_600_000).toISOString(),
    summary: `${name} • public website`,
    context: "Connected by the browser-test fixture.",
    citations,
    clusters: [],
  };
}

const WORKSPACE_STATE = {
  projects: [
    {
      id: "proj_default",
      name: "General",
      description: "Default project",
      accent: "#e5e5e5",
      sourceCount: WEBSITES.length,
      updatedAt: NOW,
    },
    {
      id: ATLAS_PROJECT_ID,
      name: "Atlas",
      description: "Second project",
      accent: "#e5e5e5",
      sourceCount: 1,
      updatedAt: NOW,
    },
  ],
  conversations: [
    {
      id: "conv_main",
      title: "Rollout questions",
      projectId: "proj_default",
      updatedAt: NOW,
      messages: [],
    },
  ],
  clusters: [
    {
      id: "cl_rollout",
      projectId: "proj_default",
      label: "Rollout",
      category: "core",
      strength: 0.7,
      x: 20,
      y: 10,
      links: [],
      description: "Rollout knowledge.",
      summary: "How rollouts happen.",
      mentionCount: 1,
      lastUpdatedAt: NOW,
      sources: [],
    },
  ],
  sources: [
    ...WEBSITES.map((website) =>
      websiteSource(website.slug, website.name, "proj_default"),
    ),
    // Filed under another project: a jump to this one cannot mark it here.
    websiteSource(ATLAS_SOURCE_SLUG, "Atlas Notes", ATLAS_PROJECT_ID),
  ],
  archivedCitations: [],
  activeProjectId: "proj_default",
  activeConversationId: "conv_main",
};

async function seedWorkspace(page: Page) {
  await page.addInitScript(
    ({ key, value }) => window.localStorage.setItem(key, value),
    { key: STORAGE_KEY, value: JSON.stringify(WORKSPACE_STATE) },
  );
}

test.beforeEach(async ({ page }) => {
  await stubWorkspaceApis(page);
  await seedWorkspace(page);
});

test("jumps from a cited answer to the exact quoted row in the sources view", async ({
  page,
}) => {
  await mockChatStream(page, [
    "The rollout is described in ",
    `[source:${CITED_CITATION_ID}]`,
    ".",
  ]);

  await page.goto("/workspace/chat");
  await page.getByTestId("input-message").fill("How does the rollout work?");
  await page.getByTestId("button-send").click();

  // The marker resolves to the citation's document link…
  await expect(
    page.getByTestId(`citation-link-${CITED_CITATION_ID}`),
  ).toHaveText(CITED_CITATION_TITLE);

  // …and the answer offers the citing source alongside it.
  const jumpToSource = page.getByTestId(`chat-open-source-${CITED_SOURCE_ID}`);
  await expect(jumpToSource).toContainText(CITED_WEBSITE.name);
  await expect(jumpToSource).toContainText(
    `${CITATIONS_PER_SOURCE} citations`,
  );

  await jumpToSource.click();

  // The Brain opens on the sources view, landed on the quoted row itself —
  // marked as the exact citation the answer used.
  await expect(page.getByTestId("knowledge-source-list")).toBeVisible();
  const citationHighlight = page.getByTestId(
    `knowledge-citation-highlight-${CITED_CITATION_ID}`,
  );
  await expect(citationHighlight).toBeVisible();
  await expect(citationHighlight).toBeInViewport();
  await expect(citationHighlight).toContainText("Quoted in your answer");
  await expect(
    page.getByTestId(`knowledge-citation-${CITED_CITATION_ID}`),
  ).toContainText(CITED_CITATION_TITLE);

  // The card is marked too, but the scroll went past its header (fourteen
  // rows deep) — and far past the first source's card.
  const sourceHighlight = page.getByTestId(
    `knowledge-source-highlight-${CITED_SOURCE_ID}`,
  );
  await expect(sourceHighlight).toBeVisible();
  await expect(sourceHighlight).not.toBeInViewport();
  await expect(
    page.getByTestId(`knowledge-source-${FIRST_SOURCE_ID}`),
  ).not.toBeInViewport();

  // Exactly one row is singled out, and nothing suggests a failed jump.
  await expect(
    page.locator('[data-testid^="knowledge-citation-highlight-"]'),
  ).toHaveCount(1);
  await expect(page.getByTestId("knowledge-jump-missing")).toHaveCount(0);

  // The rest of that source's evidence is right there, without leaving Venom.
  for (let index = 0; index < CITATIONS_PER_SOURCE; index += 1) {
    await expect(
      page.getByTestId(`knowledge-citation-cite_${CITED_WEBSITE.slug}_${index}`),
    ).toContainText(`${CITED_WEBSITE.name} page ${index + 1}`);
  }

  // The quoted row still opens the cited document itself, externally.
  const quotedRow = page.getByTestId(`knowledge-citation-${CITED_CITATION_ID}`);
  await expect(quotedRow).toHaveAttribute(
    "href",
    `https://example.com/${CITED_WEBSITE.slug}/${CITED_CITATION_INDEX + 1}`,
  );
  await expect(quotedRow).toHaveAttribute("target", "_blank");
});

test("a jump that names only the source still lands on the source card", async ({
  page,
}) => {
  // An older answer (or a shared link) may carry only the source id. The
  // sources view still scrolls to that card and marks it — with no citation
  // row singled out inside it.
  await page.goto(
    `/workspace/brain?view=sources&source=${CITED_SOURCE_ID}`,
  );
  await expect(page.getByTestId("knowledge-source-list")).toBeVisible();

  const sourceHighlight = page.getByTestId(
    `knowledge-source-highlight-${CITED_SOURCE_ID}`,
  );
  await expect(sourceHighlight).toBeVisible();
  await expect(sourceHighlight).toBeInViewport();
  await expect(sourceHighlight).toContainText("Cited in your answer");
  await expect(
    page.getByTestId(`knowledge-source-${FIRST_SOURCE_ID}`),
  ).not.toBeInViewport();
  await expect(
    page.locator('[data-testid^="knowledge-citation-highlight-"]'),
  ).toHaveCount(0);

  // A jump that found its card needs no explanation either.
  await expect(page.getByTestId("knowledge-jump-missing")).toHaveCount(0);
});

test("says why nothing is marked when the jumped-to source is no longer connected", async ({
  page,
}) => {
  // The cited source was disconnected on another device after the answer
  // linked to it: the id in the stale URL no longer exists anywhere in the
  // workspace (the desktop has no disconnect surface of its own).
  await page.goto(
    `/workspace/brain?view=sources&source=${RETIRED_SOURCE_ID}&citation=cite_retired_3`,
  );
  await expect(page.getByTestId("knowledge-source-list")).toBeVisible();

  const notice = page.getByTestId("knowledge-jump-missing");
  await expect(notice).toBeVisible();
  await expect(
    page.getByTestId("knowledge-jump-missing-reason"),
  ).toContainText("no longer connected");
  await expect(
    page.locator('[data-testid^="knowledge-source-highlight-"]'),
  ).toHaveCount(0);
  await expect(
    page.locator('[data-testid^="knowledge-citation-highlight-"]'),
  ).toHaveCount(0);

  // The list stays usable under the notice: the sources are right there and
  // the filter still narrows them.
  await expect(
    page.getByTestId(`knowledge-source-${FIRST_SOURCE_ID}`),
  ).toBeVisible();
  await page.getByTestId("knowledge-source-filter").fill("handbook");
  await expect(
    page.getByTestId(`knowledge-source-${FIRST_SOURCE_ID}`),
  ).toBeVisible();
  await expect(
    page.getByTestId(`knowledge-source-${CITED_SOURCE_ID}`),
  ).toHaveCount(0);

  // Dismissing the notice retires the jump for good.
  await page.getByTestId("knowledge-jump-missing-dismiss").click();
  await expect(notice).toHaveCount(0);
  await expect(
    page.getByTestId(`knowledge-source-${FIRST_SOURCE_ID}`),
  ).toBeVisible();
});

test("names the project a jumped-to source is filed under when it is not the active one", async ({
  page,
}) => {
  // The source exists, but under the Atlas project — nothing in the active
  // project's list can be marked, and the notice says where it went.
  await page.goto(
    `/workspace/brain?view=sources&source=${ATLAS_SOURCE_ID}`,
  );
  await expect(page.getByTestId("knowledge-source-list")).toBeVisible();

  await expect(page.getByTestId("knowledge-jump-missing")).toBeVisible();
  const reason = page.getByTestId("knowledge-jump-missing-reason");
  await expect(reason).toContainText("Atlas Notes");
  await expect(reason).toContainText("the “Atlas” project");
  await expect(reason).toContainText("Switch projects");
  await expect(
    page.locator('[data-testid^="knowledge-source-highlight-"]'),
  ).toHaveCount(0);
  await expect(
    page.locator('[data-testid^="knowledge-citation-highlight-"]'),
  ).toHaveCount(0);

  // The active project's own sources are still browsable underneath.
  await expect(
    page.getByTestId(`knowledge-source-${FIRST_SOURCE_ID}`),
  ).toBeVisible();
});
