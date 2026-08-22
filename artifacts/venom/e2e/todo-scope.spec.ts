import { expect, test, type Page } from "@playwright/test";

/**
 * The phone To-Do tab shows one unified board (Task #281): every project —
 * personal or shared with a company — contributes, the scope bar is a plain
 * project picker, and the active project's board leads. There is no
 * Personal/business split gating boards anymore; with no projects at all,
 * an empty panel explains how to start.
 */

const STORAGE_KEY = "@venom_state_v2:venom-ui-test";
const NOW = 1_755_600_000_000; // fixed timestamp keeps the seed deterministic

function project({
  id,
  name,
  orgId,
  taskId,
  taskTitle,
}: {
  id: string;
  name: string;
  orgId?: string;
  taskId: string;
  taskTitle: string;
}) {
  return {
    id,
    name,
    description: `${name} workspace`,
    accent: "#73736f",
    sourceCount: 0,
    updatedAt: NOW,
    ...(orgId ? { orgId } : {}),
    tasks: [
      // Legacy status-shaped tasks: normalization maps them onto the
      // project's default stages, same as desktop seeds.
      { id: taskId, title: taskTitle, status: "todo", createdAt: NOW },
    ],
  };
}

function seededState(
  projects: Record<string, unknown>[],
  activeProjectId: string,
) {
  return {
    projects,
    conversations: [
      {
        id: "conv_seed",
        title: "Planning",
        projectId: activeProjectId,
        updatedAt: NOW,
        messages: [],
      },
    ],
    clusters: [],
    sources: [],
    activeProjectId,
    activeConversationId: "conv_seed",
  };
}

async function openSeededTodoTab(
  page: Page,
  state: unknown,
  { hydrationMarker }: { hydrationMarker?: string } = {},
) {
  await page.addInitScript(
    ({ key, value }) => window.localStorage.setItem(key, value),
    { key: STORAGE_KEY, value: JSON.stringify(state) },
  );
  await page.goto("/?venomUiTest=true");
  await expect(page.getByTestId("chat-input")).toBeVisible();
  if (hydrationMarker) {
    // Hydration finished once the seeded active project is the one on screen.
    await expect(page.getByTestId("open-projects")).toContainText(
      hydrationMarker,
    );
  }

  const boardTab = page.getByRole("tab", { name: "Open To-Do workspace" });
  await boardTab.click();
  await expect(boardTab).toHaveAttribute("aria-selected", "true");
}

test("the unified board leads with the active project — company-shared included — and chips switch projects", async ({
  page,
}) => {
  await openSeededTodoTab(
    page,
    seededState(
      [
        project({
          id: "proj_org",
          name: "Client Ops",
          orgId: "org_x",
          taskId: "task_org",
          taskTitle: "Ship client report",
        }),
        project({
          id: "proj_home",
          name: "Home Base",
          taskId: "task_home",
          taskTitle: "Water the plants",
        }),
        project({
          id: "proj_side",
          name: "Side Quest",
          taskId: "task_side",
          taskTitle: "Sketch the zine",
        }),
      ],
      // The active project is the company-shared one: it is a peer on the
      // unified board, so its own board leads instead of being hidden.
      "proj_org",
    ),
    { hydrationMarker: "Client Ops" },
  );

  const scopeBar = page.getByTestId("todo-scope-bar");
  await expect(scopeBar).toBeVisible();
  await expect(scopeBar).toContainText("Projects");

  await expect(page.getByText("Task Board", { exact: true })).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Edit task Ship client report" }),
  ).toBeVisible();

  // Every project gets a chip — the business one included.
  await page.getByTestId("todo-scope-project-proj_side").click();
  await expect(
    page.getByRole("button", { name: "Edit task Sketch the zine" }),
  ).toBeVisible();
  await expect(page.getByText("Ship client report")).toHaveCount(0);

  await page.getByTestId("todo-scope-project-proj_home").click();
  await expect(
    page.getByRole("button", { name: "Edit task Water the plants" }),
  ).toBeVisible();
});

test("no projects at all shows the empty scope panel", async ({ page }) => {
  await openSeededTodoTab(page, seededState([], "proj_gone"));

  const emptyPanel = page.getByTestId("todo-scope-empty");
  await expect(emptyPanel).toBeVisible();
  await expect(emptyPanel).toContainText(
    "No projects yet. Create one from the project switcher to start a list.",
  );
  // No board and no scope bar — there is nothing to pick between.
  await expect(page.getByText("Task Board", { exact: true })).toHaveCount(0);
  await expect(page.getByTestId("todo-scope-bar")).toHaveCount(0);
});
