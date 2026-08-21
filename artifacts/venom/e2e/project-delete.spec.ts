import { expect, test, type Page } from "@playwright/test";

/**
 * Deleting the workspace you are currently in must work straight from the
 * projects screen — no switching away first — and must always land the app
 * somewhere usable: the next most recent project, or a fresh default
 * workspace when nothing else remains.
 */

async function openProjects(page: Page) {
  await page.getByTestId("open-projects").click();
  await expect(page.getByTestId("create-project")).toBeVisible();
}

async function createProject(page: Page, name: string) {
  await page.getByTestId("create-project").click();
  await page.getByTestId("new-project-name").fill(name);
  await page.getByTestId("save-project").click();
  await expect(page.getByTestId("chat-input")).toBeVisible();
}

function projectCard(page: Page, name: string) {
  return page.getByRole("button", { name: `Switch to ${name}` });
}

test("deletes the active project and lands on the next workspace", async ({
  page,
}) => {
  await page.goto("/");
  await expect(page.getByTestId("chat-input")).toBeVisible();

  await openProjects(page);
  await createProject(page, "Ephemeral");

  await openProjects(page);
  await expect(projectCard(page, "Ephemeral")).toHaveAttribute(
    "aria-selected",
    "true",
  );

  // The active card now carries its own delete control.
  await page.getByRole("button", { name: "Delete Ephemeral" }).click();
  await expect(projectCard(page, "Ephemeral")).toHaveCount(0);

  // The app lands on the remaining workspace without manual switching.
  await expect(projectCard(page, "Global Workspace")).toHaveAttribute(
    "aria-selected",
    "true",
  );

  await page.getByRole("button", { name: "Go back" }).click();
  await expect(page.getByTestId("chat-input")).toBeVisible();
});

test("deleting the last project leaves a fresh usable workspace", async ({
  page,
}) => {
  await page.goto("/");
  await expect(page.getByTestId("chat-input")).toBeVisible();

  // The seeded workspace ships sample tasks; their absence later proves the
  // replacement workspace is fresh rather than the deleted one resurfacing.
  await page.getByRole("tab", { name: "Open To-Do workspace" }).click();
  await expect(page.getByText("Define data schema")).toBeVisible();
  await page.getByRole("tab", { name: "Open Chat workspace" }).click();

  await openProjects(page);
  await expect(projectCard(page, "Global Workspace")).toHaveCount(1);
  await page
    .getByRole("button", { name: "Delete Global Workspace" })
    .click();

  // A replacement default workspace takes its place, already selected.
  await expect(projectCard(page, "Global Workspace")).toHaveCount(1);
  await expect(projectCard(page, "Global Workspace")).toHaveAttribute(
    "aria-selected",
    "true",
  );

  await page.getByRole("button", { name: "Go back" }).click();
  await expect(page.getByTestId("chat-input")).toBeVisible();

  // The board renders the fresh workspace: usable, and empty of the old tasks.
  await page.getByRole("tab", { name: "Open To-Do workspace" }).click();
  await expect(page.getByTestId("workspace-todo")).toBeVisible();
  await expect(page.getByText("Define data schema")).toHaveCount(0);
});
