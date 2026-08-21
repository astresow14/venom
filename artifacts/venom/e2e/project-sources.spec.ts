import { expect, test, type Page } from "@playwright/test";

const CITATION = {
  id: "cite_repository_overview",
  provider: "github",
  kind: "repository",
  title: "acme/venom",
  url: "https://github.com/acme/venom",
  excerpt: "Mobile intelligence workspace for connected project sources.",
  reference: "acme/venom",
};

const REPOSITORY_SOURCE = {
  id: "source_acme_venom",
  projectId: "proj_default",
  provider: "github",
  name: "acme/venom",
  url: "https://github.com/acme/venom",
  status: "connected",
  syncedAt: new Date().toISOString(),
  summary: "acme/venom • 4 open items • 1 active pull requests",
  context: `[source:${CITATION.id}] repository: acme/venom. ${CITATION.excerpt} (${CITATION.url})`,
  citations: [CITATION],
  clusters: [
    {
      id: "source_acme_venom_repository",
      label: "acme/venom",
      category: "repository",
      strength: 1,
      citationIds: [CITATION.id],
    },
  ],
  attestation: "v1.ui-test-attestation",
};

const ASSISTANT_REPLY = [
  `data: ${JSON.stringify({ content: "Active work lives in " })}`,
  "",
  `data: ${JSON.stringify({ content: `[source:${CITATION.id}]` })}`,
  "",
  "data: [DONE]",
  "",
  "",
].join("\n");

type SourceRequests = {
  githubSync: Array<{ url: string; body: unknown }>;
  chat: Array<Record<string, unknown>>;
};

/**
 * Serves the connected-source endpoints from fixtures so the interaction test
 * exercises the app's own state, rendering, and citation handling.
 */
async function stubSourceApi(page: Page): Promise<SourceRequests> {
  const requests: SourceRequests = { githubSync: [], chat: [] };

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

  await page.route("**/api/venom/projects/*/sources/github", (route) => {
    requests.githubSync.push({
      url: new URL(route.request().url()).pathname,
      body: route.request().postDataJSON(),
    });
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(REPOSITORY_SOURCE),
    });
  });

  await page.route("**/api/venom/respond", (route) => {
    requests.chat.push(route.request().postDataJSON());
    return route.fulfill({
      status: 200,
      headers: {
        "content-type": "text/event-stream",
        "cache-control": "no-cache, no-transform",
      },
      body: ASSISTANT_REPLY,
    });
  });

  return requests;
}

/** Connects the fixture repository from the mobile settings screen. */
async function connectRepositorySource(page: Page) {
  await page.getByTestId("open-settings").click();
  await page.getByTestId("open-github-source-picker").click();
  await page.getByTestId("connect-github-acme/venom").click();
  await expect(
    page.getByTestId(`remove-source-${REPOSITORY_SOURCE.id}`),
  ).toBeVisible();
}

async function backToChat(page: Page) {
  await page.getByRole("button", { name: "Go back" }).click();
  await expect(page.getByTestId("chat-input")).toBeVisible();
}

test.beforeEach(({}, testInfo) => {
  test.skip(
    testInfo.project.name !== "mobile-chromium",
    "Connected sources are added from the mobile settings screen.",
  );
});

test("adds a GitHub source and opens the citation it renders in chat", async ({
  page,
}) => {
  const requests = await stubSourceApi(page);

  await page.goto("/?venomUiTest=true");
  await expect(page.getByTestId("chat-input")).toBeVisible();

  // Connect a repository from settings.
  await connectRepositorySource(page);

  expect(requests.githubSync).toEqual([
    {
      url: "/api/venom/projects/proj_default/sources/github",
      body: { repository: "acme/venom" },
    },
  ]);

  // Back to chat, where the connected source becomes citable context.
  await backToChat(page);
  const input = page.getByTestId("chat-input");

  await input.fill("Where is the active work?");
  await page.getByTestId("send-message-button").click();

  const citation = page.getByRole("link", { name: "Open source: acme/venom" });
  await expect(citation).toBeVisible();
  await expect(citation).toHaveText("acme/venom");

  // The chat request carries the connected source as attested context.
  expect(requests.chat).toHaveLength(1);
  expect(requests.chat[0].projectId).toBe("proj_default");
  expect(requests.chat[0].sourceCitationIds).toEqual([CITATION.id]);
  expect(String(requests.chat[0].projectContext)).toContain(
    `[source:${CITATION.id}]`,
  );

  await citation.click();
  await expect
    .poll(() =>
      page.evaluate(
        () => (window as unknown as { __venomOpenedUrls: string[] }).__venomOpenedUrls,
      ),
    )
    .toContain(CITATION.url);
});

test("removing a source archives its citation and survives a workspace merge", async ({
  page,
}) => {
  await stubSourceApi(page);

  await page.goto("/?venomUiTest=true");
  await expect(page.getByTestId("chat-input")).toBeVisible();

  await connectRepositorySource(page);
  await backToChat(page);

  await page.getByTestId("chat-input").fill("Where is the active work?");
  await page.getByTestId("send-message-button").click();

  const citationLink = page.getByRole("link", {
    name: "Open source: acme/venom",
  });
  await expect(citationLink).toBeVisible();

  // Disconnect the source the answer cited.
  await page.getByTestId("open-settings").click();
  await page.getByTestId(`remove-source-${REPOSITORY_SOURCE.id}`).click();
  await expect(
    page.getByTestId(`remove-source-${REPOSITORY_SOURCE.id}`),
  ).toHaveCount(0);

  // The saved answer keeps its wording and still names the evidence it was
  // based on, marked as archived rather than reading as a generic marker.
  await backToChat(page);
  const answer = page.getByTestId("chat-message-assistant");
  const archivedCitation = page.getByRole("link", {
    name: `Open archived source, no longer connected: ${CITATION.title}`,
  });
  await expect(answer).toContainText("Active work lives in");
  await expect(answer).toContainText(`${CITATION.title} (archived)`);
  await expect(answer).not.toContainText("(archived source)");
  await expect(answer).not.toContainText(`[source:${CITATION.id}]`);
  await expect(citationLink).toHaveCount(0);

  // The archived reference still opens the original URL.
  await archivedCitation.click();
  await expect
    .poll(() =>
      page.evaluate(
        () => (window as unknown as { __venomOpenedUrls: string[] }).__venomOpenedUrls,
      ),
    )
    .toContain(CITATION.url);

  // The public Community Feed must not render this private conversation.
  await page.route("**/api/venom/community/briefing*", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        community: [],
        agenda: [],
        calendarStatus: "not_connected",
        viewerProfile: null,
        nextCursor: null,
      }),
    }),
  );
  await page.getByRole("tab", { name: "Open Feed workspace" }).click();
  const communityBriefing = page.getByTestId("community-briefing");
  await expect(communityBriefing).toContainText("Community Briefing");
  await expect(communityBriefing).toContainText("No threads found.");
  await expect(communityBriefing).not.toContainText("Active work lives in");
  await expect(communityBriefing).not.toContainText("[source:");
  await page.getByRole("tab", { name: "Open Chat workspace" }).click();
  await expect(page.getByTestId("chat-input")).toBeVisible();

  // A workspace merge that still carries the disconnected source must not
  // resurrect it, or the link it used to render.
  await page.evaluate((source) => {
    window.localStorage.setItem(
      "@venom_sources_v1:venom-ui-test",
      JSON.stringify([source]),
    );
  }, REPOSITORY_SOURCE);
  await page.reload();

  await expect(page.getByTestId("chat-message-assistant")).toContainText(
    `${CITATION.title} (archived)`,
  );
  await expect(citationLink).toHaveCount(0);

  await page.getByTestId("open-settings").click();
  await expect(
    page.getByTestId(`remove-source-${REPOSITORY_SOURCE.id}`),
  ).toHaveCount(0);
});

const WEBSITE_SOURCE_ROUTE = "**/api/venom/projects/*/sources/website";
const GITHUB_REPOSITORIES_ROUTE = "**/api/venom/github/repositories";
const GITHUB_SOURCE_ROUTE = "**/api/venom/projects/*/sources/github";

const UNAUTHORIZED_ACCOUNT =
  "Your account is not authorized to use this workspace GitHub connection.";

const WEBSITE_SOURCE = {
  id: "source_example_site",
  projectId: "proj_default",
  provider: "website",
  name: "Example Domain",
  url: "https://example.com/",
  status: "connected",
  syncedAt: new Date().toISOString(),
  summary: "Example Domain • public website",
  context: "[source:cite_example] website: Example Domain.",
  citations: [
    {
      id: "cite_example",
      provider: "website",
      kind: "website",
      title: "Example Domain",
      url: "https://example.com/",
      excerpt: "Illustrative documentation for connected sources.",
      reference: null,
    },
  ],
  clusters: [],
};

async function openSettings(page: Page) {
  await expect(page.getByTestId("open-settings")).toBeVisible();
  await page.getByTestId("open-settings").click();
  await expect(page.getByText("Cloud backup", { exact: true })).toBeVisible();
}

test("explains why a website was refused and keeps the address for a retry", async ({
  page,
}) => {
  const attempted: string[] = [];

  await page.route(WEBSITE_SOURCE_ROUTE, (route) => {
    const body = route.request().postDataJSON() as { url?: string };
    const url = body?.url ?? "";
    attempted.push(url);

    if (url.includes("intranet.local")) {
      return route.fulfill({
        status: 422,
        contentType: "application/json",
        body: JSON.stringify({
          error: "Venom can only read public websites.",
        }),
      });
    }

    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(WEBSITE_SOURCE),
    });
  });

  await page.goto("/?venomUiTest=true");
  await openSettings(page);

  const input = page.getByTestId("website-source-url");
  await input.fill("https://intranet.local/handbook");
  await page.getByTestId("connect-website-source").click();

  // The server's own refusal reaches the person who asked for the source.
  const sourceError = page.getByTestId("source-error");
  await expect(sourceError).toBeVisible();
  await expect(sourceError).toHaveText("Venom can only read public websites.");

  // Nothing was connected, and the address survives so it can be corrected.
  await expect(page.getByTestId(`remove-source-${WEBSITE_SOURCE.id}`)).toHaveCount(
    0,
  );
  await expect(input).toHaveValue("https://intranet.local/handbook");

  // Correcting the address clears the refusal and connects the source.
  await input.fill("https://example.com");
  await page.getByTestId("connect-website-source").click();

  await expect(
    page.getByTestId(`remove-source-${WEBSITE_SOURCE.id}`),
  ).toBeVisible();
  await expect(sourceError).toHaveCount(0);
  await expect(input).toHaveValue("");
  expect(attempted).toEqual([
    "https://intranet.local/handbook",
    "https://example.com",
  ]);
});

test("tells an unauthorized account why GitHub repositories cannot be connected", async ({
  page,
}) => {
  await page.route(GITHUB_REPOSITORIES_ROUTE, (route) =>
    route.fulfill({
      status: 403,
      contentType: "application/json",
      body: JSON.stringify({ error: UNAUTHORIZED_ACCOUNT }),
    }),
  );

  await page.goto("/?venomUiTest=true");
  await openSettings(page);

  await page.getByTestId("open-github-source-picker").click();

  // The picker explains that this account was refused instead of rendering an
  // empty panel or a "try again" that can never succeed. React Query retries
  // first, so allow for its backoff before the error state settles.
  const listError = page.getByTestId("github-repositories-error");
  await expect(listError).toBeVisible({ timeout: 30_000 });
  await expect(listError).toHaveText(UNAUTHORIZED_ACCOUNT);
  await expect(
    page.getByTestId("connect-github-acme/venom"),
  ).toHaveCount(0);
});

test("surfaces an unauthorized workspace account when connecting a repository", async ({
  page,
}) => {
  const requests: unknown[] = [];

  await page.route(GITHUB_REPOSITORIES_ROUTE, (route) =>
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

  await page.route(GITHUB_SOURCE_ROUTE, (route) => {
    requests.push(route.request().postDataJSON());
    return route.fulfill({
      status: 403,
      contentType: "application/json",
      body: JSON.stringify({ error: UNAUTHORIZED_ACCOUNT }),
    });
  });

  await page.goto("/?venomUiTest=true");
  await openSettings(page);

  await page.getByTestId("open-github-source-picker").click();
  await page.getByTestId("connect-github-acme/venom").click();

  const sourceError = page.getByTestId("source-error");
  await expect(sourceError).toBeVisible();
  await expect(sourceError).toHaveText(UNAUTHORIZED_ACCOUNT);

  // The picker stays open on the repository that was refused, so the person
  // can switch accounts and try the same row again.
  await expect(page.getByTestId("connect-github-acme/venom")).toBeVisible();
  await expect(page.getByTestId("remove-source-source_acme_venom")).toHaveCount(
    0,
  );
  expect(requests).toEqual([{ repository: "acme/venom" }]);
});
