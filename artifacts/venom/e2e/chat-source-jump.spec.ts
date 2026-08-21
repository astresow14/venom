import { expect, test, type Page } from "@playwright/test";

/**
 * Four connected websites, each carrying enough citations that the sources view
 * has to scroll: the source a chat answer cites is the last one, so a jump that
 * does not scroll leaves it off screen.
 */
const WEBSITES = [
  { slug: "handbook", name: "Handbook" },
  { slug: "roadmap", name: "Roadmap" },
  { slug: "runbook", name: "Runbook" },
  { slug: "changelog", name: "Changelog" },
];
const CITATIONS_PER_SOURCE = 6;
const CITED_WEBSITE = WEBSITES[WEBSITES.length - 1];
const CITED_SOURCE_ID = `source_${CITED_WEBSITE.slug}`;
const CITED_CITATION_ID = `cite_${CITED_WEBSITE.slug}_0`;
const FIRST_SOURCE_ID = `source_${WEBSITES[0].slug}`;

function websiteSourcePayload(slug: string, name: string) {
  const citations = Array.from({ length: CITATIONS_PER_SOURCE }, (_, index) => ({
    id: `cite_${slug}_${index}`,
    provider: "website",
    kind: "website",
    title: `${name} page ${index + 1}`,
    url: `https://example.com/${slug}/${index + 1}`,
    excerpt: `What the ${name.toLowerCase()} says about page ${index + 1}.`,
    reference: `${slug}/${index + 1}`,
  }));

  return {
    id: `source_${slug}`,
    projectId: "proj_default",
    provider: "website",
    name,
    url: `https://example.com/${slug}`,
    status: "connected",
    syncedAt: new Date().toISOString(),
    summary: `${name} • public website`,
    context: citations
      .map((citation) => `[source:${citation.id}] ${citation.title}`)
      .join(" "),
    citations,
    clusters: [],
  };
}

const ASSISTANT_REPLY = [
  `data: ${JSON.stringify({ content: "The rollout is described in " })}`,
  "",
  `data: ${JSON.stringify({ content: `[source:${CITED_CITATION_ID}]` })}`,
  "",
  "data: [DONE]",
  "",
  "",
].join("\n");

async function stubWorkspace(page: Page) {
  await page.addInitScript(() => {
    const opened: string[] = [];
    (window as unknown as { __venomOpenedUrls: string[] }).__venomOpenedUrls =
      opened;
    window.open = ((url?: string | URL) => {
      opened.push(String(url ?? ""));
      return null;
    }) as typeof window.open;
  });

  await page.route("**/api/venom/projects/*/sources/website", (route) => {
    const body = route.request().postDataJSON() as { url?: string };
    const website =
      WEBSITES.find((candidate) =>
        (body?.url ?? "").includes(candidate.slug),
      ) ?? WEBSITES[0];
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(websiteSourcePayload(website.slug, website.name)),
    });
  });

  await page.route("**/api/venom/respond", (route) =>
    route.fulfill({
      status: 200,
      headers: {
        "content-type": "text/event-stream",
        "cache-control": "no-cache, no-transform",
      },
      body: ASSISTANT_REPLY,
    }),
  );
}

test.beforeEach(({}, testInfo) => {
  test.skip(
    testInfo.project.name !== "mobile-chromium",
    "Citations are followed from the mobile chat screen.",
  );
});

test("jumps from a cited answer to that source's evidence on the knowledge screen", async ({
  page,
}) => {
  await stubWorkspace(page);

  await page.goto("/?venomUiTest=true");
  await expect(page.getByTestId("chat-input")).toBeVisible();

  // Connect the websites the answer can cite.
  await page.getByTestId("open-settings").click();
  for (const website of WEBSITES) {
    await page
      .getByTestId("website-source-url")
      .fill(`https://example.com/${website.slug}`);
    await page.getByTestId("connect-website-source").click();
    await expect(
      page.getByTestId(`source-sync-status-source_${website.slug}`),
    ).toContainText(`${CITATIONS_PER_SOURCE} citations`);
  }
  await page.getByRole("button", { name: "Go back" }).click();

  // Ask a question whose answer cites the last connected source.
  await page.getByTestId("chat-input").fill("How does the rollout work?");
  await page.getByTestId("send-message-button").click();
  await expect(
    page.getByRole("link", {
      name: `Open source: ${CITED_WEBSITE.name} page 1`,
    }),
  ).toBeVisible();

  // The answer offers the citing source alongside the external citation link.
  const jumpToSource = page.getByTestId(`chat-open-source-${CITED_SOURCE_ID}`);
  await expect(jumpToSource).toContainText(CITED_WEBSITE.name);
  await expect(jumpToSource).toContainText(`${CITATIONS_PER_SOURCE} citations`);

  await jumpToSource.click();

  // The sources view opens scrolled to that source, marked out from the rest.
  await expect(page.getByTestId("knowledge-source-list")).toBeVisible();
  const highlight = page.getByTestId(
    `knowledge-source-highlight-${CITED_SOURCE_ID}`,
  );
  await expect(highlight).toBeVisible();
  await expect(highlight).toBeInViewport();
  await expect(page.getByTestId(`knowledge-source-${FIRST_SOURCE_ID}`))
    .not.toBeInViewport();

  // The rest of that source's evidence is right there, without leaving Venom.
  for (let index = 0; index < CITATIONS_PER_SOURCE; index += 1) {
    await expect(
      page.getByTestId(`knowledge-citation-cite_${CITED_WEBSITE.slug}_${index}`),
    ).toContainText(`${CITED_WEBSITE.name} page ${index + 1}`);
  }

  // Its citations still open externally.
  await page
    .getByTestId(`knowledge-citation-${CITED_CITATION_ID}`)
    .click();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as unknown as { __venomOpenedUrls: string[] })
            .__venomOpenedUrls,
      ),
    )
    .toContain(`https://example.com/${CITED_WEBSITE.slug}/1`);
});
