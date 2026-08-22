import { expect, test, type Page } from "@playwright/test";

/**
 * Four connected websites, each carrying enough citations that the sources view
 * has to scroll: the source a chat answer cites is the last one, so a jump that
 * does not scroll leaves it off screen. The quoted page sits deep inside that
 * source's card — more than a viewport below the card's top — so landing on
 * the card alone would still leave the quoted row out of sight.
 */
const WEBSITES = [
  { slug: "handbook", name: "Handbook" },
  { slug: "roadmap", name: "Roadmap" },
  { slug: "runbook", name: "Runbook" },
  { slug: "changelog", name: "Changelog" },
];
const CITATIONS_PER_SOURCE = 20;
const CITED_WEBSITE = WEBSITES[WEBSITES.length - 1];
const CITED_CITATION_INDEX = 15;
const CITED_SOURCE_ID = `source_${CITED_WEBSITE.slug}`;
const CITED_CITATION_ID = `cite_${CITED_WEBSITE.slug}_${CITED_CITATION_INDEX}`;
const CITED_CITATION_TITLE = `${CITED_WEBSITE.name} page ${
  CITED_CITATION_INDEX + 1
}`;
const FIRST_SOURCE_ID = `source_${WEBSITES[0].slug}`;

const STATE_STORAGE_KEY = "@venom_state_v2:venom-ui-test";

function websiteSourcePayload(slug: string, name: string, projectId: string) {
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
    projectId,
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
    // The connect endpoint files the source under the project named in the
    // URL, so the stub echoes it back and a source can belong to whichever
    // project was active when it was connected.
    const projectId = decodeURIComponent(
      new URL(route.request().url()).pathname.match(
        /\/projects\/([^/]+)\/sources\/website$/,
      )?.[1] ?? "proj_default",
    );
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(
        websiteSourcePayload(website.slug, website.name, projectId),
      ),
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

/** Connects websites through the settings screen, which must already be open. */
async function connectWebsites(
  page: Page,
  websites: ReadonlyArray<{ slug: string; name: string }>,
) {
  for (const website of websites) {
    await page
      .getByTestId("website-source-url")
      .fill(`https://example.com/${website.slug}`);
    await page.getByTestId("connect-website-source").click();
    await expect(
      page.getByTestId(`source-sync-status-source_${website.slug}`),
    ).toContainText(`${CITATIONS_PER_SOURCE} citations`);
  }
}

test.beforeEach(({}, testInfo) => {
  test.skip(
    testInfo.project.name !== "mobile-chromium",
    "Citations are followed from the mobile chat screen.",
  );
});

test("jumps from a cited answer to the exact quoted row on the knowledge screen", async ({
  page,
}) => {
  await stubWorkspace(page);

  await page.goto("/?venomUiTest=true");
  await expect(page.getByTestId("chat-input")).toBeVisible();

  // Connect the websites the answer can cite.
  await page.getByTestId("open-settings").click();
  await connectWebsites(page, WEBSITES);
  await page.getByRole("button", { name: "Go back" }).click();

  // Ask a question whose answer quotes one page deep inside the last source.
  await page.getByTestId("chat-input").fill("How does the rollout work?");
  await page.getByTestId("send-message-button").click();
  await expect(
    page.getByRole("link", { name: `Open source: ${CITED_CITATION_TITLE}` }),
  ).toBeVisible();

  // The answer offers the citing source alongside the external citation link.
  const jumpToSource = page.getByTestId(`chat-open-source-${CITED_SOURCE_ID}`);
  await expect(jumpToSource).toContainText(CITED_WEBSITE.name);
  await expect(jumpToSource).toContainText(`${CITATIONS_PER_SOURCE} citations`);

  await jumpToSource.click();

  // The sources view opens on the quoted row itself, marked out from its
  // sibling citations, not merely on the card that carries it: the card's own
  // "Cited in your answer" badge sits a full viewport above the quoted row,
  // so landing on the row leaves it off screen.
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

  // The source card is still marked as the cited one, but the jump landed on
  // the quoted row deep inside it rather than at its top.
  const sourceHighlight = page.getByTestId(
    `knowledge-source-highlight-${CITED_SOURCE_ID}`,
  );
  await expect(sourceHighlight).toBeVisible();
  await expect(sourceHighlight).not.toBeInViewport();
  await expect(
    page.getByTestId(`knowledge-source-${FIRST_SOURCE_ID}`),
  ).not.toBeInViewport();

  // Only the quoted row is singled out.
  await expect(
    page.locator('[data-testid^="knowledge-citation-highlight-"]'),
  ).toHaveCount(1);

  // A jump that found its target needs no explanation.
  await expect(page.getByTestId("knowledge-jump-missing")).toHaveCount(0);

  // The rest of that source's evidence is right there, without leaving Venom.
  for (let index = 0; index < CITATIONS_PER_SOURCE; index += 1) {
    await expect(
      page.getByTestId(`knowledge-citation-cite_${CITED_WEBSITE.slug}_${index}`),
    ).toContainText(`${CITED_WEBSITE.name} page ${index + 1}`);
  }

  // The quoted row still opens externally.
  await page.getByTestId(`knowledge-citation-${CITED_CITATION_ID}`).click();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as unknown as { __venomOpenedUrls: string[] })
            .__venomOpenedUrls,
      ),
    )
    .toContain(
      `https://example.com/${CITED_WEBSITE.slug}/${CITED_CITATION_INDEX + 1}`,
    );
});

test("a jump that names only the source still lands on the source card", async ({
  page,
}) => {
  await stubWorkspace(page);

  await page.goto("/?venomUiTest=true");
  await expect(page.getByTestId("chat-input")).toBeVisible();
  await page.getByTestId("open-settings").click();
  await connectWebsites(page, WEBSITES);

  // An older answer (or a shared link) may carry only the source id. The
  // sources view still scrolls to that card and marks it — with no citation
  // row singled out inside it.
  await page.goto(
    `/knowledge?view=sources&source=${CITED_SOURCE_ID}&venomUiTest=true`,
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

test("says why nothing is marked when the jumped-to source was disconnected", async ({
  page,
}) => {
  await stubWorkspace(page);

  await page.goto("/?venomUiTest=true");
  await expect(page.getByTestId("chat-input")).toBeVisible();

  // Connect two websites and follow a cited answer to the second one.
  await page.getByTestId("open-settings").click();
  await connectWebsites(page, [WEBSITES[0], CITED_WEBSITE]);
  await page.getByRole("button", { name: "Go back" }).click();

  await page.getByTestId("chat-input").fill("How does the rollout work?");
  await page.getByTestId("send-message-button").click();
  await page.getByTestId(`chat-open-source-${CITED_SOURCE_ID}`).click();
  await expect(
    page.getByTestId(`knowledge-source-highlight-${CITED_SOURCE_ID}`),
  ).toBeVisible();

  // Back in settings, disconnect the source the answer cited.
  await page.getByRole("button", { name: "Go back" }).click();
  await expect(page.getByTestId("chat-input")).toBeVisible();
  await page.getByTestId("open-settings").click();
  await page.getByTestId(`remove-source-${CITED_SOURCE_ID}`).click();
  // Removal is destructive, so the control stages a confirmation dialog
  // rather than acting on one tap.
  await page.getByTestId("confirm-remove-source").click();
  await expect(
    page.getByTestId(`source-sync-status-${CITED_SOURCE_ID}`),
  ).toHaveCount(0);
  await page.waitForFunction(
    ([storageKey, removedSourceId]) => {
      const raw = window.localStorage.getItem(storageKey);
      if (!raw) return false;
      try {
        const parsed = JSON.parse(raw) as {
          sources?: Array<{ id?: string }>;
        };
        return (parsed.sources ?? []).every(
          (source) => source.id !== removedSourceId,
        );
      } catch {
        return false;
      }
    },
    [STATE_STORAGE_KEY, CITED_SOURCE_ID] as const,
  );

  // Reopening the jump (a refresh of the knowledge URL it wrote) lands on a
  // list that no longer holds the source: no card is marked, and the view
  // says why instead of silently dropping the scroll that never happened.
  await page.goto(
    `/knowledge?view=sources&source=${CITED_SOURCE_ID}&venomUiTest=true`,
  );
  await expect(page.getByTestId("knowledge-source-list")).toBeVisible();
  const notice = page.getByTestId("knowledge-jump-missing");
  await expect(notice).toBeVisible();
  await expect(
    page.getByTestId("knowledge-jump-missing-reason"),
  ).toContainText("no longer connected");
  await expect(
    page.getByTestId(`knowledge-source-highlight-${CITED_SOURCE_ID}`),
  ).toHaveCount(0);
  await expect(
    page.locator('[data-testid^="knowledge-citation-highlight-"]'),
  ).toHaveCount(0);

  // The list stays usable: the remaining source is right there with its
  // citations, and the filter still narrows it.
  await expect(
    page.getByTestId(`knowledge-source-${FIRST_SOURCE_ID}`),
  ).toBeVisible();
  await page.getByTestId("knowledge-source-filter").fill("handbook");
  await expect(
    page.getByTestId(`knowledge-source-${FIRST_SOURCE_ID}`),
  ).toBeVisible();

  // Dismissing the notice retires the jump.
  await page.getByTestId("knowledge-jump-missing-dismiss").click();
  await expect(notice).toHaveCount(0);
  await expect(
    page.getByTestId(`knowledge-source-${FIRST_SOURCE_ID}`),
  ).toBeVisible();
});

test("names the owning project and finishes the jump with a one-tap switch", async ({
  page,
}) => {
  await stubWorkspace(page);

  await page.goto("/?venomUiTest=true");
  await expect(page.getByTestId("chat-input")).toBeVisible();

  // One website belongs to the default project...
  await page.getByTestId("open-settings").click();
  await connectWebsites(page, [WEBSITES[0]]);
  await page.getByRole("button", { name: "Go back" }).click();

  // ...and the cited one to a second project, created and left active while
  // connecting it.
  await page.getByTestId("open-projects").click();
  await page.getByTestId("create-project").click();
  await page.getByTestId("new-project-name").fill("Atlas");
  await page.getByTestId("save-project").click();
  await expect(page.getByTestId("chat-input")).toBeVisible();
  await page.getByTestId("open-settings").click();
  await connectWebsites(page, [CITED_WEBSITE]);
  await page.getByRole("button", { name: "Go back" }).click();

  // Switch back to the default project, which does not hold the cited source.
  await page.getByTestId("open-projects").click();
  await page.getByTestId("select-project-proj_default").click();
  await expect(page.getByTestId("chat-input")).toBeVisible();
  await page.waitForFunction(
    ([storageKey, citedSourceId]) => {
      const raw = window.localStorage.getItem(storageKey);
      if (!raw) return false;
      try {
        const parsed = JSON.parse(raw) as {
          activeProjectId?: string | null;
          sources?: Array<{ id?: string; projectId?: string }>;
        };
        return (
          parsed.activeProjectId === "proj_default" &&
          (parsed.sources ?? []).some(
            (source) =>
              source.id === citedSourceId &&
              source.projectId !== "proj_default",
          )
        );
      } catch {
        return false;
      }
    },
    [STATE_STORAGE_KEY, CITED_SOURCE_ID] as const,
  );

  // A jump to that source now lands in a list that cannot mark it. The notice
  // names the project it is filed under, so the reader knows where to switch.
  // This jump also names the quoted citation, so the parked scroll has a deep
  // row to finish on once the switch mounts the card.
  await page.goto(
    `/knowledge?view=sources&source=${CITED_SOURCE_ID}&citation=${CITED_CITATION_ID}&venomUiTest=true`,
  );
  await expect(page.getByTestId("knowledge-source-list")).toBeVisible();
  await expect(page.getByTestId("knowledge-jump-missing")).toBeVisible();
  const reason = page.getByTestId("knowledge-jump-missing-reason");
  await expect(reason).toContainText(CITED_WEBSITE.name);
  await expect(reason).toContainText("Atlas");
  await expect(
    page.getByTestId(`knowledge-source-highlight-${CITED_SOURCE_ID}`),
  ).toHaveCount(0);
  await expect(
    page.getByTestId(`knowledge-source-${FIRST_SOURCE_ID}`),
  ).toBeVisible();

  // Switching moves the chat session with the project, so nothing switched on
  // its own while the notice sat on screen: the default project's list is
  // still up. The notice offers the switch as an explicit tap instead.
  const switchAction = page.getByTestId("knowledge-jump-switch-project");
  await expect(switchAction).toContainText("Switch to Atlas");

  // The reader may have kept browsing while the notice sat there: a filter
  // that matches the current list but not the cited source would hide the
  // card the switch is about to mount, so the tap must shed it or the parked
  // scroll could never land.
  await page.getByTestId("knowledge-source-filter").fill("handbook");
  await expect(
    page.getByTestId(`knowledge-source-${FIRST_SOURCE_ID}`),
  ).toBeVisible();

  await switchAction.click();
  await expect(page.getByTestId("knowledge-source-filter")).toHaveValue("");

  // The tap alone finishes the parked jump: the owning project's list mounts
  // the cited card, the pending scroll fires off its layout pass, and the
  // quoted row lands in view, marked out — with no re-navigation.
  await expect(page.getByTestId("knowledge-jump-missing")).toHaveCount(0);
  const citationHighlight = page.getByTestId(
    `knowledge-citation-highlight-${CITED_CITATION_ID}`,
  );
  await expect(citationHighlight).toBeVisible();
  await expect(citationHighlight).toBeInViewport();
  await expect(citationHighlight).toContainText("Quoted in your answer");
  await expect(
    page.getByTestId(`knowledge-citation-${CITED_CITATION_ID}`),
  ).toContainText(CITED_CITATION_TITLE);
  await expect(
    page.getByTestId(`knowledge-source-highlight-${CITED_SOURCE_ID}`),
  ).toBeVisible();

  // The list really is the owning project's now — the default project's
  // source left it — and the whole app moved: the persisted active project is
  // the one the cited source is filed under.
  await expect(
    page.getByTestId(`knowledge-source-${FIRST_SOURCE_ID}`),
  ).toHaveCount(0);
  await page.waitForFunction(
    ([storageKey, citedSourceId]) => {
      const raw = window.localStorage.getItem(storageKey);
      if (!raw) return false;
      try {
        const parsed = JSON.parse(raw) as {
          activeProjectId?: string | null;
          sources?: Array<{ id?: string; projectId?: string }>;
        };
        const cited = (parsed.sources ?? []).find(
          (source) => source.id === citedSourceId,
        );
        return (
          Boolean(cited?.projectId) &&
          parsed.activeProjectId === cited?.projectId
        );
      } catch {
        return false;
      }
    },
    [STATE_STORAGE_KEY, CITED_SOURCE_ID] as const,
  );
});
