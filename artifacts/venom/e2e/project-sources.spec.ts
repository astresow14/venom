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
  await page.getByTestId("open-settings").click();
  await page.getByTestId("open-github-source-picker").click();
  await page.getByTestId("connect-github-acme/venom").click();

  await expect(page.getByTestId("remove-source-source_acme_venom")).toBeVisible();
  expect(requests.githubSync).toEqual([
    {
      url: "/api/venom/projects/proj_default/sources/github",
      body: { repository: "acme/venom" },
    },
  ]);

  // Back to chat, where the connected source becomes citable context.
  await page.getByRole("button", { name: "Go back" }).click();
  const input = page.getByTestId("chat-input");
  await expect(input).toBeVisible();

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
