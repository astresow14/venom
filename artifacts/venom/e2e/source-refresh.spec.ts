import { expect, test, type Page } from "@playwright/test";

const WEBSITE_SOURCE_ROUTE = "**/venom/projects/*/sources/website";
const SOURCE_ID = "source_refresh_ui_test";

function websiteSourcePayload({
  syncedAt,
  citationCount,
  excerpt,
}: {
  syncedAt: string;
  citationCount: number;
  excerpt: string;
}) {
  return {
    id: SOURCE_ID,
    projectId: "proj_default",
    provider: "website",
    name: "Example Domain",
    url: "https://example.com/",
    status: "connected",
    syncedAt,
    summary: "Example Domain • public website",
    context: `[source:cite_${citationCount}] website: Example Domain. ${excerpt}`,
    citations: Array.from({ length: citationCount }, (_, index) => ({
      id: `cite_${citationCount}_${index}`,
      provider: "website",
      kind: "website",
      title: "Example Domain",
      url: "https://example.com/",
      excerpt,
      reference: null,
    })),
    clusters: [],
  };
}

const CHANGELOG_CITATION = {
  id: "cite_changelog_entry",
  provider: "website",
  kind: "website",
  title: "Changelog",
  url: "https://example.com/changelog",
  excerpt: "Shipped the drawer fix.",
  reference: null,
};

const REPLACEMENT_CITATION = {
  id: "cite_whats_new_entry",
  provider: "website",
  kind: "website",
  title: "What's new",
  url: "https://example.com/whats-new",
  excerpt: "Shipped the safe-area fix.",
  reference: null,
};

/** A website source payload carrying an explicit citation set. */
function websiteSourceWithCitations(citations: unknown[], syncedAt: string) {
  return {
    id: SOURCE_ID,
    projectId: "proj_default",
    provider: "website",
    name: "Example Domain",
    url: "https://example.com/",
    status: "connected",
    syncedAt,
    summary: "Example Domain • public website",
    context: citations
      .map((citation) => `[source:${(citation as { id: string }).id}]`)
      .join(" "),
    citations,
    clusters: [],
  };
}

const ASSISTANT_REPLY = [
  `data: ${JSON.stringify({ content: "The drawer fix is described in " })}`,
  "",
  `data: ${JSON.stringify({ content: `[source:${CHANGELOG_CITATION.id}]` })}`,
  "",
  "data: [DONE]",
  "",
  "",
].join("\n");

async function openSettings(page: Page) {
  await expect(page.getByTestId("open-settings")).toBeVisible();
  await page.getByTestId("open-settings").click();
  await expect(page.getByText("Cloud backup", { exact: true })).toBeVisible();
}

test("refreshes a connected source in place and reports its progress", async ({
  page,
}) => {
  const requests: string[] = [];
  await page.route(WEBSITE_SOURCE_ROUTE, async (route) => {
    const body = route.request().postDataJSON() as { url?: string };
    requests.push(body?.url ?? "");

    if (requests.length === 1) {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(
          websiteSourcePayload({
            syncedAt: new Date(
              Date.now() - (3 * 86_400_000 + 10 * 60_000),
            ).toISOString(),
            citationCount: 1,
            excerpt: "Stale copy",
          }),
        ),
      });
      return;
    }

    // Hold the refresh open long enough to observe the in-progress state.
    await new Promise((resolve) => setTimeout(resolve, 900));
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(
        websiteSourcePayload({
          syncedAt: new Date().toISOString(),
          citationCount: 2,
          excerpt: "Fresh copy",
        }),
      ),
    });
  });

  await page.goto("/?venomUiTest=true");
  await openSettings(page);

  await page.getByTestId("website-source-url").fill("https://example.com");
  await page.getByTestId("connect-website-source").click();

  const status = page.getByTestId(`source-sync-status-${SOURCE_ID}`);
  await expect(status).toHaveText("1 citations · Last synced 3d ago");

  await page
    .getByRole("button", { name: "Refresh Example Domain" })
    .click();
  await expect(status).toHaveText("Refreshing…");

  await expect(status).toHaveText("2 citations · Last synced just now");
  expect(requests).toEqual(["https://example.com", "https://example.com/"]);
  await expect(page.getByTestId(`remove-source-${SOURCE_ID}`)).toHaveCount(1);
});

test("surfaces a failed refresh without discarding the connected source", async ({
  page,
}) => {
  let attempts = 0;
  await page.route(WEBSITE_SOURCE_ROUTE, async (route) => {
    attempts += 1;
    if (attempts === 1) {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(
          websiteSourcePayload({
            syncedAt: new Date(Date.now() - 90 * 60_000).toISOString(),
            citationCount: 1,
            excerpt: "Stale copy",
          }),
        ),
      });
      return;
    }

    await route.fulfill({
      status: 502,
      contentType: "application/json",
      body: JSON.stringify({ error: "Venom could not read this website." }),
    });
  });

  await page.goto("/?venomUiTest=true");
  await openSettings(page);

  await page.getByTestId("website-source-url").fill("https://example.com");
  await page.getByTestId("connect-website-source").click();

  const status = page.getByTestId(`source-sync-status-${SOURCE_ID}`);
  await expect(status).toHaveText("1 citations · Last synced 1h ago");

  await page.getByRole("button", { name: "Refresh Example Domain" }).click();
  await expect(
    page.getByTestId(`source-refresh-error-${SOURCE_ID}`),
  ).toBeVisible();
  await expect(status).toHaveText("1 citations · Last synced 1h ago");
});

test("keeps the title of a citation the refresh retired", async ({
  page,
}, testInfo) => {
  test.skip(
    testInfo.project.name !== "mobile-chromium",
    "Sources are connected and refreshed from the mobile settings screen.",
  );

  await page.addInitScript(() => {
    const opened: string[] = [];
    (window as unknown as { __venomOpenedUrls: string[] }).__venomOpenedUrls =
      opened;
    window.open = ((url?: string | URL) => {
      opened.push(String(url ?? ""));
      return null;
    }) as typeof window.open;
  });

  let attempts = 0;
  await page.route(WEBSITE_SOURCE_ROUTE, async (route) => {
    attempts += 1;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(
        attempts === 1
          ? websiteSourceWithCitations(
              [CHANGELOG_CITATION],
              new Date(Date.now() - 90 * 60_000).toISOString(),
            )
          : websiteSourceWithCitations(
              [REPLACEMENT_CITATION],
              new Date().toISOString(),
            ),
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

  await page.goto("/?venomUiTest=true");
  await openSettings(page);
  await page.getByTestId("website-source-url").fill("https://example.com");
  await page.getByTestId("connect-website-source").click();
  await expect(page.getByTestId(`source-sync-status-${SOURCE_ID}`)).toHaveText(
    "1 citations · Last synced 1h ago",
  );

  // Save an answer that cites the page the refresh is about to retire.
  await page.getByRole("button", { name: "Go back" }).click();
  await page.getByTestId("chat-input").fill("What changed in the drawer?");
  await page.getByTestId("send-message-button").click();
  await expect(
    page.getByRole("link", { name: "Open source: Changelog" }),
  ).toBeVisible();

  // The refreshed source no longer covers that page.
  await page.getByTestId("open-settings").click();
  await page.getByRole("button", { name: "Refresh Example Domain" }).click();
  await expect(page.getByTestId(`source-sync-status-${SOURCE_ID}`)).toHaveText(
    "1 citations · Last synced just now",
  );

  // The saved answer still names the evidence, marked as archived.
  await page.getByRole("button", { name: "Go back" }).click();
  const archived = page.getByRole("link", {
    name: "Open archived source, no longer connected: Changelog",
  });
  await expect(archived).toHaveText("Changelog (archived)");
  await expect(page.getByTestId("chat-message-assistant")).not.toContainText(
    "(archived source)",
  );

  await archived.click();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as unknown as { __venomOpenedUrls: string[] })
            .__venomOpenedUrls,
      ),
    )
    .toContain(CHANGELOG_CITATION.url);
});

const EVIDENCE_URL = "https://example.com/";
const EVIDENCE_V1 = {
  sourceId: "source_evidence_v1",
  citationId: "cite_evidence_v1",
  title: "Example Domain",
  citationUrl: EVIDENCE_URL,
  excerpt: "Active work is tracked on the overview page.",
  reference: "docs/overview",
};

/**
 * A connected website source whose ids come from the sync, exactly like the
 * real connect endpoint: a re-sync that yields a new source id also yields new
 * citation ids, so answers saved earlier cite ids that no longer exist.
 */
function evidenceSourcePayload({
  sourceId,
  citationId,
  title,
  citationUrl,
  excerpt,
  syncedAt,
  reference = null,
}: {
  sourceId: string;
  citationId: string;
  title: string;
  citationUrl: string;
  excerpt: string;
  syncedAt: string;
  reference?: string | null;
}) {
  return {
    id: sourceId,
    projectId: "proj_default",
    provider: "website",
    name: "Example Domain",
    url: EVIDENCE_URL,
    status: "connected",
    syncedAt,
    summary: "Example Domain • public website",
    context: `[source:${citationId}] website: ${title}. ${excerpt}`,
    citations: [
      {
        id: citationId,
        provider: "website",
        kind: "website",
        title,
        url: citationUrl,
        excerpt,
        reference,
      },
    ],
    clusters: [],
  };
}

/**
 * A connected website source carrying several cited pages at once, the shape a
 * re-sync of a multi-page website produces.
 */
function evidenceSourceWithCitations({
  sourceId,
  syncedAt,
  citations,
}: {
  sourceId: string;
  syncedAt: string;
  citations: {
    id: string;
    title: string;
    url: string;
    excerpt: string;
    reference?: string | null;
  }[];
}) {
  return {
    id: sourceId,
    projectId: "proj_default",
    provider: "website",
    name: "Example Domain",
    url: EVIDENCE_URL,
    status: "connected",
    syncedAt,
    summary: "Example Domain • public website",
    context: citations
      .map(
        (citation) =>
          `[source:${citation.id}] website: ${citation.title}. ${citation.excerpt}`,
      )
      .join("\n"),
    citations: citations.map((citation) => ({
      provider: "website",
      kind: "website",
      reference: null,
      ...citation,
    })),
    clusters: [],
  };
}

type EvidenceSourceSync =
  | ReturnType<typeof evidenceSourcePayload>
  | ReturnType<typeof evidenceSourceWithCitations>;

const EVIDENCE_REPLY = [
  `data: ${JSON.stringify({ content: "Active work lives in " })}`,
  "",
  `data: ${JSON.stringify({ content: `[source:${EVIDENCE_V1.citationId}]` })}`,
  "",
  `data: ${JSON.stringify({ content: "." })}`,
  "",
  "data: [DONE]",
  "",
  "",
].join("\n");

/**
 * Serves the website connect endpoint with a scripted sequence of syncs — the
 * initial connect, then one payload per refresh. The last payload repeats if
 * the page refreshes more often than the script covers.
 */
async function stubEvidenceSourceSyncs(page: Page, syncs: EvidenceSourceSync[]) {
  await page.addInitScript(() => {
    const opened: string[] = [];
    (window as unknown as { __venomOpenedUrls: string[] }).__venomOpenedUrls =
      opened;
    window.open = ((url?: string | URL) => {
      opened.push(String(url ?? ""));
      return null;
    }) as typeof window.open;
  });

  let attempt = 0;
  await page.route(WEBSITE_SOURCE_ROUTE, async (route) => {
    const payload = syncs[Math.min(attempt, syncs.length - 1)];
    attempt += 1;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(payload),
    });
  });

  await page.route("**/api/venom/respond", (route) =>
    route.fulfill({
      status: 200,
      headers: {
        "content-type": "text/event-stream",
        "cache-control": "no-cache, no-transform",
      },
      body: EVIDENCE_REPLY,
    }),
  );
}

/**
 * Serves the website connect endpoint twice: the initial connect, then the
 * refresh, which returns whichever refreshed payload the test supplies.
 */
async function stubEvidenceSource(
  page: Page,
  refreshed: ReturnType<typeof evidenceSourcePayload>,
) {
  await stubEvidenceSourceSyncs(page, [
    evidenceSourcePayload({
      ...EVIDENCE_V1,
      syncedAt: new Date(Date.now() - 90 * 60_000).toISOString(),
    }),
    refreshed,
  ]);
}

async function backToChat(page: Page) {
  await page.getByRole("button", { name: "Go back" }).click();
  await expect(page.getByTestId("chat-input")).toBeVisible();
}

/** Connects the website source and records an answer that cites it. */
async function recordCitedAnswer(page: Page, url = "/?venomUiTest=true") {
  await page.goto(url);
  await expect(page.getByTestId("chat-input")).toBeVisible();

  await openSettings(page);
  await page.getByTestId("website-source-url").fill("https://example.com");
  await page.getByTestId("connect-website-source").click();
  await expect(
    page.getByTestId(`remove-source-${EVIDENCE_V1.sourceId}`),
  ).toBeVisible();

  await backToChat(page);
  await page.getByTestId("chat-input").fill("Where is the active work?");
  await page.getByTestId("send-message-button").click();

  await expect(page.getByTestId("chat-message-assistant")).toContainText(
    "Active work lives in",
  );
  await expect(
    page.getByRole("link", { name: `Open source: ${EVIDENCE_V1.title}` }),
  ).toBeVisible();
}

/** Refreshes the connected source from settings and returns to the answer. */
async function refreshFromSettings(
  page: Page,
  refreshedSourceId: string,
  previousSourceId = EVIDENCE_V1.sourceId,
) {
  await page.getByTestId("open-settings").click();
  await page.getByTestId(`refresh-source-${previousSourceId}`).click();

  // The refresh replaced the card in place, under its new source id.
  await expect(
    page.getByTestId(`remove-source-${refreshedSourceId}`),
  ).toBeVisible();
  await expect(
    page.getByTestId(`remove-source-${previousSourceId}`),
  ).toHaveCount(0);

  await backToChat(page);
}

/**
 * The saved assistant answers, read back out of persisted workspace state.
 * Scoped to stored messages so a marker that only appears in a source's
 * context blob cannot stand in for a conversation that was actually rewritten.
 */
function savedAssistantAnswers(page: Page) {
  return page.evaluate(() => {
    const raw = window.localStorage.getItem("@venom_state_v2:venom-ui-test");
    if (!raw) return [] as string[];

    const answers: string[] = [];
    const visit = (value: unknown) => {
      if (Array.isArray(value)) {
        for (const entry of value) visit(entry);
        return;
      }
      if (!value || typeof value !== "object") return;
      const record = value as Record<string, unknown>;
      if (record.role === "assistant" && typeof record.content === "string") {
        answers.push(record.content);
      }
      for (const entry of Object.values(record)) visit(entry);
    };
    visit(JSON.parse(raw));
    return answers;
  });
}

/**
 * The workspace archive of retired citations, read back out of persisted
 * state, so a test can prove an entry was really written — and really dropped
 * — rather than inferring either from what the answer happens to render.
 */
function savedArchivedCitations(page: Page) {
  return page.evaluate(() => {
    const raw = window.localStorage.getItem("@venom_state_v2:venom-ui-test");
    if (!raw) return null;
    const state = JSON.parse(raw) as {
      archivedCitations?: { id: string; title: string; url: string }[];
    };
    return state.archivedCitations ?? [];
  });
}

/**
 * The signed-in variant of the UI test mode: workspace saves and restores go
 * through the sync harness's fake cloud, which outlives a reload the way the
 * real cloud does.
 */
const SYNC_TEST_URL = "/?venomUiTest=true&venomWorkspaceSyncTest=true";
const SYNC_TEST_USER_ID = "venom-ui-test";

type SyncHarnessWindow = Window & {
  __venomWorkspaceSyncTest?: {
    snapshots: Record<
      string,
      {
        state: {
          sources: { id: string }[];
          tombstones?: { sources?: { id: string }[] };
        };
      }
    >;
    seedSnapshot: (userId: string, state: unknown) => void;
  };
};

function cloudState(page: Page) {
  return page.evaluate(
    (userId) =>
      (window as SyncHarnessWindow).__venomWorkspaceSyncTest?.snapshots[userId]
        ?.state ?? null,
    SYNC_TEST_USER_ID,
  );
}

async function cloudSourceIds(page: Page) {
  const state = await cloudState(page);
  return state?.sources.map((source) => source.id) ?? null;
}

async function cloudSourceTombstoneIds(page: Page) {
  const state = await cloudState(page);
  return state?.tombstones?.sources?.map((marker) => marker.id) ?? [];
}

/** Waits until the refreshed source has actually reached the fake cloud. */
async function waitForCloudSave(page: Page, refreshedSourceId: string) {
  await expect
    .poll(() => cloudSourceIds(page), { timeout: 15_000 })
    .toEqual([refreshedSourceId]);
}

/**
 * Rewrites the cloud snapshot the way a device that never saw the refresh
 * would: the retired source is still connected, and nothing in the cloud
 * tombstones records that it was replaced.
 */
async function seedCloudSnapshot(page: Page, retiredSource: unknown) {
  await page.evaluate(
    ([userId, retired]) => {
      const harness = (window as SyncHarnessWindow).__venomWorkspaceSyncTest;
      if (!harness) throw new Error("Workspace sync test harness is missing.");

      const snapshot = harness.snapshots[userId as string];
      if (!snapshot) throw new Error("No cloud snapshot has been saved yet.");

      const state = JSON.parse(JSON.stringify(snapshot.state));
      state.sources = [...state.sources, retired];
      state.tombstones = { ...state.tombstones, sources: [] };
      harness.seedSnapshot(userId as string, state);
    },
    [SYNC_TEST_USER_ID, retiredSource] as const,
  );
}

test.describe("refreshed answers keep their evidence links", () => {
  test.beforeEach(({}, testInfo) => {
    test.skip(
      testInfo.project.name !== "mobile-chromium",
      "Sources are connected and refreshed from the mobile settings screen.",
    );
  });

  test("remaps an older answer onto the refreshed citation", async ({
    page,
  }) => {
    // The refreshed sync still covers the same page, but the new source id
    // means a new citation id the saved answer has never seen.
    await stubEvidenceSource(
      page,
      evidenceSourcePayload({
        sourceId: "source_evidence_v2",
        citationId: "cite_evidence_v2",
        title: "Example Domain — August update",
        citationUrl: EVIDENCE_URL,
        excerpt: "Active work moved to the August board.",
        syncedAt: new Date().toISOString(),
        reference: EVIDENCE_V1.reference,
      }),
    );

    await recordCitedAnswer(page);
    await refreshFromSettings(page, "source_evidence_v2");

    // The earlier answer keeps its wording and still links to live evidence,
    // now under the refreshed citation.
    const answer = page.getByTestId("chat-message-assistant");
    await expect(answer).toContainText("Active work lives in");
    await expect(answer).not.toContainText("(archived");
    await expect(answer).not.toContainText("[source:");

    const citation = page.getByRole("link", {
      name: "Open source: Example Domain — August update",
    });
    await expect(citation).toBeVisible();
    await expect(citation).toHaveText("Example Domain — August update");

    await citation.click();
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            (window as unknown as { __venomOpenedUrls: string[] })
              .__venomOpenedUrls,
        ),
      )
      .toContain(EVIDENCE_URL);

    // The stored answer itself was rewritten, so this is a real remap rather
    // than display-time patching over a retired id that is still persisted.
    await expect
      .poll(() => savedAssistantAnswers(page))
      .toEqual([expect.stringContaining("[source:cite_evidence_v2]")]);
    expect(await savedAssistantAnswers(page)).toEqual([
      expect.not.stringContaining(EVIDENCE_V1.citationId),
    ]);
  });

  test("keeps the link when the refresh renames the cited item's reference", async ({
    page,
  }) => {
    // Same page, renamed reference: the provider moved the doc path, so the
    // reference the answer was written against no longer exists.
    await stubEvidenceSource(
      page,
      evidenceSourcePayload({
        sourceId: "source_evidence_v4",
        citationId: "cite_evidence_v4",
        title: "Example Domain — renamed path",
        citationUrl: EVIDENCE_URL,
        excerpt: "Active work is still tracked on the overview page.",
        syncedAt: new Date().toISOString(),
        reference: "docs/overview-2026",
      }),
    );

    await recordCitedAnswer(page);
    await refreshFromSettings(page, "source_evidence_v4");

    const answer = page.getByTestId("chat-message-assistant");
    await expect(answer).toContainText("Active work lives in");
    await expect(answer).not.toContainText("(archived");

    const citation = page.getByRole("link", {
      name: "Open source: Example Domain — renamed path",
    });
    await expect(citation).toBeVisible();

    await expect
      .poll(() => savedAssistantAnswers(page))
      .toEqual([expect.stringContaining("[source:cite_evidence_v4]")]);
  });

  test("keeps the link when the refresh moves the cited page to a new address", async ({
    page,
  }) => {
    // The site restructured: neither the reference nor the URL the answer was
    // written against survives, but the page kept its title and nothing else
    // in the refreshed sync carries that name.
    const movedUrl = "https://example.com/overview-2026";
    await stubEvidenceSource(
      page,
      evidenceSourcePayload({
        sourceId: "source_evidence_v7",
        citationId: "cite_evidence_v7",
        title: EVIDENCE_V1.title,
        citationUrl: movedUrl,
        excerpt: "Active work moved with the page.",
        syncedAt: new Date().toISOString(),
        reference: "docs/overview-2026",
      }),
    );

    await recordCitedAnswer(page);
    await refreshFromSettings(page, "source_evidence_v7");

    const answer = page.getByTestId("chat-message-assistant");
    await expect(answer).toContainText("Active work lives in");
    await expect(answer).not.toContainText("(archived");
    await expect(answer).not.toContainText("[source:");

    // The citation still reads as live evidence and opens the new address.
    const citation = page.getByRole("link", {
      name: `Open source: ${EVIDENCE_V1.title}`,
    });
    await expect(citation).toBeVisible();
    await citation.click();
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            (window as unknown as { __venomOpenedUrls: string[] })
              .__venomOpenedUrls,
        ),
      )
      .toContain(movedUrl);

    // The stored answer was rewritten onto the refreshed citation id.
    await expect
      .poll(() => savedAssistantAnswers(page))
      .toEqual([expect.stringContaining("[source:cite_evidence_v7]")]);
    expect(await savedAssistantAnswers(page)).toEqual([
      expect.not.stringContaining(EVIDENCE_V1.citationId),
    ]);
  });

  test("keeps a retired source out of a merge from another device", async ({
    page,
  }) => {
    // The refresh moves the same page onto a new source id, so the source the
    // other device still holds is the one the refresh retired.
    const refreshed = evidenceSourcePayload({
      sourceId: "source_evidence_v5",
      citationId: "cite_evidence_v5",
      title: "Example Domain — merged update",
      citationUrl: EVIDENCE_URL,
      excerpt: "Active work moved to the merged board.",
      syncedAt: new Date().toISOString(),
      reference: EVIDENCE_V1.reference,
    });
    await stubEvidenceSource(page, refreshed);

    await recordCitedAnswer(page);
    await refreshFromSettings(page, "source_evidence_v5");

    const refreshedCitation = page.getByRole("link", {
      name: "Open source: Example Domain — merged update",
    });
    await expect(refreshedCitation).toBeVisible();

    // A second device that never saw the refresh syncs the retired source back
    // in. Its snapshot predates the refresh, so the tombstone must win.
    await page.evaluate((retired) => {
      window.localStorage.setItem(
        "@venom_sources_v1:venom-ui-test",
        JSON.stringify([retired]),
      );
    }, evidenceSourcePayload({
      ...EVIDENCE_V1,
      syncedAt: new Date(Date.now() - 90 * 60_000).toISOString(),
    }));
    await page.reload();
    await expect(page.getByTestId("chat-input")).toBeVisible();

    // The answer still points at the refreshed evidence rather than reverting
    // to the citation the refresh retired.
    const answer = page.getByTestId("chat-message-assistant");
    await expect(answer).toContainText("Active work lives in");
    await expect(answer).not.toContainText("(archived");
    await expect(answer).not.toContainText("[source:");
    await expect(refreshedCitation).toBeVisible();
    await expect(
      page.getByRole("link", {
        name: `Open source: ${EVIDENCE_V1.title}`,
        exact: true,
      }),
    ).toHaveCount(0);

    await refreshedCitation.click();
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            (window as unknown as { __venomOpenedUrls: string[] })
              .__venomOpenedUrls,
        ),
      )
      .toContain(EVIDENCE_URL);

    // Settings shows the refreshed card only: no second card for the same
    // website, and no way to interact with the retired source again.
    await page.getByTestId("open-settings").click();
    await expect(
      page.getByTestId("remove-source-source_evidence_v5"),
    ).toBeVisible();
    await expect(
      page.getByTestId(`remove-source-${EVIDENCE_V1.sourceId}`),
    ).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: "Remove Example Domain" }),
    ).toHaveCount(1);
  });

  test("keeps a retired source out of a signed-in cloud restore", async ({
    page,
  }) => {
    // Same shape as the local-merge case, but the retired source comes back
    // through the signed-in restore: the cloud snapshot is merged with local
    // state and its own tombstone set on every sign-in.
    const refreshed = evidenceSourcePayload({
      sourceId: "source_evidence_v6",
      citationId: "cite_evidence_v6",
      title: "Example Domain — restored update",
      citationUrl: EVIDENCE_URL,
      excerpt: "Active work moved to the restored board.",
      syncedAt: new Date().toISOString(),
      reference: EVIDENCE_V1.reference,
    });
    await stubEvidenceSource(page, refreshed);

    await recordCitedAnswer(page, SYNC_TEST_URL);
    await refreshFromSettings(page, refreshed.id);

    const refreshedCitation = page.getByRole("link", {
      name: "Open source: Example Domain — restored update",
    });
    await expect(refreshedCitation).toBeVisible();

    // Wait for the refresh to reach the cloud, so the snapshot the restore
    // reads is the one this device actually saved.
    await waitForCloudSave(page, refreshed.id);

    // A second device that never saw the refresh writes the cloud snapshot:
    // it still carries the source the refresh retired, and its tombstone set
    // knows nothing about the refresh. Only the local tombstone can stop it.
    await seedCloudSnapshot(
      page,
      evidenceSourcePayload({
        ...EVIDENCE_V1,
        syncedAt: new Date(Date.now() - 90 * 60_000).toISOString(),
      }),
    );

    await page.reload();
    await expect(page.getByTestId("chat-input")).toBeVisible();

    // The restore did not resurrect the retired evidence: the saved answer
    // still resolves to the refreshed citation.
    const answer = page.getByTestId("chat-message-assistant");
    await expect(answer).toContainText("Active work lives in");
    await expect(answer).not.toContainText("(archived");
    await expect(answer).not.toContainText("[source:");
    await expect(refreshedCitation).toBeVisible();
    await expect(
      page.getByRole("link", {
        name: `Open source: ${EVIDENCE_V1.title}`,
        exact: true,
      }),
    ).toHaveCount(0);

    await refreshedCitation.click();
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            (window as unknown as { __venomOpenedUrls: string[] })
              .__venomOpenedUrls,
        ),
      )
      .toContain(EVIDENCE_URL);

    // Settings shows the refreshed card only, with no second card for the same
    // website the restore brought back.
    await page.getByTestId("open-settings").click();
    await expect(
      page.getByTestId(`remove-source-${refreshed.id}`),
    ).toBeVisible();
    await expect(
      page.getByTestId(`remove-source-${EVIDENCE_V1.sourceId}`),
    ).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: "Remove Example Domain" }),
    ).toHaveCount(1);

    // The restore also repairs the cloud, so the next device to sign in does
    // not have to filter the retired source out all over again.
    await expect
      .poll(() => cloudSourceIds(page))
      .toEqual([refreshed.id]);
    expect(await cloudSourceTombstoneIds(page)).toContain(
      EVIDENCE_V1.sourceId,
    );
  });

  test("renders an archived reference when the refresh drops the cited page", async ({
    page,
  }) => {
    // Nothing in the refreshed sync covers the cited page, so the answer's
    // citation has no equivalent to be remapped onto.
    await stubEvidenceSource(
      page,
      evidenceSourcePayload({
        sourceId: "source_evidence_v3",
        citationId: "cite_evidence_v3",
        title: "Example Domain changelog",
        citationUrl: "https://example.com/changelog",
        excerpt: "Release notes for the current build.",
        syncedAt: new Date().toISOString(),
      }),
    );

    await recordCitedAnswer(page);
    await refreshFromSettings(page, "source_evidence_v3");

    const answer = page.getByTestId("chat-message-assistant");
    await expect(answer).toContainText("Active work lives in");
    await expect(
      page.getByRole("link", {
        name: `Open archived source, no longer connected: ${EVIDENCE_V1.title}`,
      }),
    ).toHaveText(`${EVIDENCE_V1.title} (archived)`);

    // A retired marker must read as an archived reference, never as raw text.
    await expect(answer).not.toContainText("[source:");
    await expect(answer).not.toContainText(EVIDENCE_V1.citationId);
    await expect(
      page.getByRole("link", { name: `Open source: ${EVIDENCE_V1.title}` }),
    ).toHaveCount(0);

    // The dead id stays in storage; only the rendering changes.
    expect(await savedAssistantAnswers(page)).toEqual([
      expect.stringContaining(`[source:${EVIDENCE_V1.citationId}]`),
    ]);
  });

  test("relinks the answer and empties the archive when a refresh restores the dropped page", async ({
    page,
  }) => {
    // First refresh: nothing in the sync covers the cited page any more, so
    // the answer's citation retires into the workspace archive. Second
    // refresh: the page is back — under fresh ids, the way a re-sync always
    // mints them — so the answer must link live evidence again and the
    // archived entry must leave the archive rather than linger as dead weight
    // in the synced payload.
    const dropped = evidenceSourcePayload({
      sourceId: "source_evidence_v7",
      citationId: "cite_evidence_v7",
      title: "Example Domain changelog",
      citationUrl: "https://example.com/changelog",
      excerpt: "Release notes for the current build.",
      syncedAt: new Date().toISOString(),
      reference: "docs/changelog",
    });
    const restored = evidenceSourceWithCitations({
      sourceId: "source_evidence_v8",
      syncedAt: new Date().toISOString(),
      citations: [
        {
          id: "cite_evidence_v8",
          title: "Example Domain — restored overview",
          url: EVIDENCE_URL,
          excerpt: "Active work is tracked on the overview page again.",
          reference: EVIDENCE_V1.reference,
        },
        {
          // The changelog page carries over from the interim sync; its remap
          // onto the fresh id keeps it out of the archive, so the archive can
          // be asserted empty at the end.
          id: "cite_evidence_v8_changelog",
          title: "Example Domain changelog",
          url: "https://example.com/changelog",
          excerpt: "Release notes for the current build.",
          reference: "docs/changelog",
        },
      ],
    });
    await stubEvidenceSourceSyncs(page, [
      evidenceSourcePayload({
        ...EVIDENCE_V1,
        syncedAt: new Date(Date.now() - 90 * 60_000).toISOString(),
      }),
      dropped,
      restored,
    ]);

    await recordCitedAnswer(page);

    // The first refresh drops the cited page: the answer falls back to an
    // archived reference, and the retired citation really reaches the
    // persisted archive (so the final emptiness check cannot pass vacuously).
    await refreshFromSettings(page, dropped.id);
    await expect(
      page.getByRole("link", {
        name: `Open archived source, no longer connected: ${EVIDENCE_V1.title}`,
      }),
    ).toHaveText(`${EVIDENCE_V1.title} (archived)`);
    await expect
      .poll(() => savedArchivedCitations(page))
      .toEqual([
        expect.objectContaining({
          id: EVIDENCE_V1.citationId,
          url: EVIDENCE_URL,
        }),
      ]);

    // The second refresh restores the page under a new citation id.
    await refreshFromSettings(page, restored.id, dropped.id);

    // The answer links live evidence again — no archived reference, no raw
    // marker left behind.
    const answer = page.getByTestId("chat-message-assistant");
    await expect(answer).toContainText("Active work lives in");
    const citation = page.getByRole("link", {
      name: "Open source: Example Domain — restored overview",
    });
    await expect(citation).toBeVisible();
    await expect(citation).toHaveText("Example Domain — restored overview");
    await expect(answer).not.toContainText("(archived");
    await expect(answer).not.toContainText("[source:");
    await expect(
      page.getByRole("link", { name: /Open archived source/ }),
    ).toHaveCount(0);

    await citation.click();
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            (window as unknown as { __venomOpenedUrls: string[] })
              .__venomOpenedUrls,
        ),
      )
      .toContain(EVIDENCE_URL);

    // The stored answer was rewritten onto the restored citation, so the live
    // link is a real remap rather than display-time patching.
    await expect
      .poll(() => savedAssistantAnswers(page))
      .toEqual([expect.stringContaining("[source:cite_evidence_v8]")]);
    expect(await savedAssistantAnswers(page)).toEqual([
      expect.not.stringContaining(EVIDENCE_V1.citationId),
    ]);

    // And the restored entry really left the workspace archive: nothing may
    // stay behind once the evidence is live again.
    await expect.poll(() => savedArchivedCitations(page)).toEqual([]);
  });
});
