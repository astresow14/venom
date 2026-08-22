import { expect, test } from "@playwright/test";

/**
 * Cross-project ontology search from the mobile Brain pane.
 *
 * In UI-test mode the app skips the server lookup and answers from the
 * on-device workspace copy, so the whole flow runs without network stubs.
 * The workspace is seeded through the same scoped storage a device keeps
 * (`@venom_state_v2:<userId>`), which hydration restores at startup.
 */

const STORAGE_KEY = "@venom_state_v2:venom-ui-test";
const NOW = 1_755_600_000_000; // fixed timestamp keeps the seed deterministic

type SeedCluster = {
  id: string;
  projectId: string;
  label: string;
  summary: string;
  category: string;
  links?: string[];
  x: number;
  y: number;
};

function cluster({ links = [], ...rest }: SeedCluster) {
  return {
    ...rest,
    links,
    description: rest.summary,
    strength: 0.8,
    mentionCount: 1,
    lastUpdatedAt: NOW,
    sources: [],
  };
}

const WORKSPACE_STATE = {
  projects: [
    {
      id: "proj_alpha",
      name: "Aurora Systems",
      description: "Active research workspace",
      accent: "#73736f",
      sourceCount: 0,
      updatedAt: NOW,
    },
    {
      id: "proj_beta",
      name: "Beacon Ops",
      description: "Field operations workspace",
      accent: "#73736f",
      sourceCount: 0,
      updatedAt: NOW,
    },
  ],
  conversations: [
    {
      id: "conv_alpha",
      title: "Alpha planning",
      projectId: "proj_alpha",
      updatedAt: NOW,
      messages: [],
    },
  ],
  clusters: [
    cluster({
      id: "cl_alpha_tower",
      projectId: "proj_alpha",
      label: "Signal Tower",
      summary: "Radio relay coverage for the northern research sites.",
      category: "core",
      links: ["cl_alpha_launch"],
      x: 50,
      y: 50,
    }),
    cluster({
      id: "cl_alpha_launch",
      projectId: "proj_alpha",
      label: "Launch Notes",
      summary: "Checklist and observations from the field launches.",
      category: "tactical",
      links: ["cl_alpha_tower"],
      x: 140,
      y: -40,
    }),
    cluster({
      id: "cl_alpha_field",
      projectId: "proj_alpha",
      label: "Field Reports",
      summary: "Weekly reports gathered by the survey teams.",
      category: "memory",
      x: -90,
      y: 70,
    }),
    cluster({
      id: "cl_beta_signal",
      projectId: "proj_beta",
      label: "Signal Protocol",
      summary: "How beacon crews encode and rotate their transmissions.",
      category: "core",
      links: ["cl_beta_handbook"],
      x: 60,
      y: 40,
    }),
    cluster({
      id: "cl_beta_handbook",
      projectId: "proj_beta",
      label: "Beacon Handbook",
      summary: "Operating guide for beacon field crews.",
      category: "memory",
      links: ["cl_beta_signal"],
      x: -70,
      y: -60,
    }),
  ],
  sources: [],
  activeProjectId: "proj_alpha",
  activeConversationId: "conv_alpha",
};

test.beforeEach(({}, testInfo) => {
  test.skip(
    testInfo.project.name !== "mobile-chromium",
    "Brain search runs in the mobile workspace pane.",
  );
});

test("finds a concept from another project and lands on it", async ({
  page,
}) => {
  await page.addInitScript(
    ({ key, value }) => window.localStorage.setItem(key, value),
    { key: STORAGE_KEY, value: JSON.stringify(WORKSPACE_STATE) },
  );

  // slimeTier=off: search and evidence panels never touch the goo layer.
  await page.goto("/?venomUiTest=true&slimeTier=off");
  await expect(page.getByTestId("chat-input")).toBeVisible();
  // Hydration finished once the seeded project is the one on screen.
  await expect(page.getByTestId("open-projects")).toContainText(
    "Aurora Systems",
  );

  const brainTab = page.getByRole("tab", { name: "Open Brain workspace" });
  await brainTab.click();
  await expect(brainTab).toHaveAttribute("aria-selected", "true");

  // The map shows the active project only; the other project's concept is
  // not a node yet.
  const map = page.getByTestId("knowledge-map");
  await expect(map).toHaveAttribute(
    "aria-label",
    /Living ontology with 3 selectable/,
  );
  await expect(page.getByTestId("knowledge-cluster-cl_beta_signal")).toHaveCount(
    0,
  );

  const searchInput = page.getByTestId("brain-search-input");
  const results = page.getByTestId("brain-search-results");

  // Below two characters the search does not run at all.
  await searchInput.fill("s");
  await expect(results).toHaveCount(0);

  // A term nothing matches explains itself instead of going blank.
  await searchInput.fill("zephyr");
  await expect(results).toContainText("No concepts match yet.");

  // The device copy answers without the network, listing matches from every
  // project with their project names.
  await searchInput.fill("signal");
  const betaRow = page.getByTestId("brain-search-result-cl_beta_signal");
  await expect(betaRow).toContainText("Signal Protocol");
  await expect(betaRow).toContainText("Beacon Ops");
  await expect(
    page.getByTestId("brain-search-result-cl_alpha_tower"),
  ).toContainText("Aurora Systems");

  await betaRow.click();

  // Selection switches the workspace to the concept's project and opens its
  // detail panel on the now-active map.
  const details = page.getByTestId("knowledge-cluster-details");
  await expect(details).toBeVisible();
  await expect(details).toContainText("Signal Protocol");
  await expect(page.getByTestId("open-projects")).toContainText("Beacon Ops");
  await expect(map).toHaveAttribute(
    "aria-label",
    /Living ontology with 2 selectable/,
  );

  // The jump consumed the query: the field clears and the results close.
  await expect(searchInput).toHaveValue("");
  await expect(results).toHaveCount(0);
});
