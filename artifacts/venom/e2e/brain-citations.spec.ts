import { expect, test, type Page } from "@playwright/test";

const READ_ME_CITATION = {
  id: "cite_repository_readme",
  provider: "github",
  kind: "document",
  title: "README.md",
  url: "https://github.com/acme/venom/blob/main/README.md",
  excerpt: "How the workspace is structured and how sources are connected.",
  reference: "acme/venom#readme",
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
  context: `[source:${READ_ME_CITATION.id}] ${READ_ME_CITATION.title}. ${READ_ME_CITATION.excerpt} (${READ_ME_CITATION.url})`,
  citations: [READ_ME_CITATION],
  clusters: [
    {
      id: "source_acme_venom_repository",
      label: "acme/venom",
      category: "repository",
      strength: 1,
      citationIds: [READ_ME_CITATION.id],
    },
  ],
  attestation: "v1.ui-test-attestation",
};

async function stubConnectedSource(page: Page) {
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

async function openTab(page: Page, name: "Brain") {
  const tab = page.getByRole("tab", { name: `Open ${name} workspace` });
  await tab.click();
  await expect(tab).toHaveAttribute("aria-selected", "true");
}

async function openCitedClusterDetails(page: Page) {
  await openTab(page, "Brain");
  await page.getByTestId("knowledge-cluster-1").click();
  const details = page.getByTestId("knowledge-cluster-details");
  await expect(details).toBeVisible();
  return details;
}

test.beforeEach(({}, testInfo) => {
  test.skip(
    testInfo.project.name !== "mobile-chromium",
    "Brain notes are read from the mobile workspace.",
  );
});

test("Brain notes name their sources instead of raw markers", async ({
  page,
}) => {
  await stubConnectedSource(page);

  // The fixture note was written from an answer that cited a source which is
  // no longer connected, so it must read as an archived reference.
  await page.goto("/?venomUiTest=true&brainFixture=cited");
  await expect(page.getByTestId("chat-input")).toBeVisible();

  let details = await openCitedClusterDetails(page);
  await expect(details).toContainText("(archived source)");
  await expect(details).not.toContainText("[source:");

  // Connecting the source the note cited makes it read as that source.
  await page.getByTestId("open-settings").click();
  await page.getByTestId("open-github-source-picker").click();
  await page.getByTestId("connect-github-acme/venom").click();
  await expect(
    page.getByTestId(`remove-source-${REPOSITORY_SOURCE.id}`),
  ).toBeVisible();
  await page.goBack();

  details = await openCitedClusterDetails(page);
  await expect(details).toContainText(
    `Structure follows ${READ_ME_CITATION.title} for the mobile release.`,
  );
  await expect(details).toContainText(
    `The layout is described in ${READ_ME_CITATION.title}.`,
  );
  await expect(details).not.toContainText("[source:");
});
