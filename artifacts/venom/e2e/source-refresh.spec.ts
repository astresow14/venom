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
