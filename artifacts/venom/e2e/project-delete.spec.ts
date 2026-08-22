import { expect, test, type Locator, type Page } from "@playwright/test";

/**
 * Deleting the workspace you are currently in must work straight from the
 * projects screen — no switching away first — and must always land the app
 * somewhere usable: the next most recent project, or a fresh default
 * workspace when nothing else remains.
 *
 * Deletion is permanent and propagates to every synced device, so the delete
 * control never acts on one tap: it opens a confirmation naming the project,
 * and only the dialog's destructive action actually deletes.
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

async function deleteProjectThroughDialog(page: Page, name: string) {
  await page.getByRole("button", { name: `Delete ${name}` }).click();
  await expect(page.getByText(`Delete ${name}?`)).toBeVisible();
  await page.getByTestId("confirm-delete-project").click();
}

// Focus handed back after the dialog closes must actually be visible, same
// bar as e2e/dialog-focus-handoff.spec.ts: a border, outline, or shadow.
async function expectVisibleKeyboardFocus(locator: Locator) {
  await expect(locator).toBeFocused();
  const focusIsVisible = await locator.evaluate((element) => {
    const style = getComputedStyle(element);
    const borderIsVisible = [
      style.borderTopColor,
      style.borderRightColor,
      style.borderBottomColor,
      style.borderLeftColor,
    ].some(
      (color) =>
        color !== "rgba(0, 0, 0, 0)" &&
        color !== "transparent" &&
        style.borderWidth !== "0px",
    );
    const outlineIsVisible =
      style.outlineStyle !== "none" && style.outlineWidth !== "0px";
    return borderIsVisible || outlineIsVisible || style.boxShadow !== "none";
  });
  expect(focusIsVisible).toBe(true);
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

  // The active card carries its own delete control; deleting passes through
  // the confirmation dialog.
  await deleteProjectThroughDialog(page, "Ephemeral");
  await expect(projectCard(page, "Ephemeral")).toHaveCount(0);

  // The app lands on the remaining workspace without manual switching, and
  // keyboard focus lands on that workspace's card rather than vanishing with
  // the deleted one.
  await expect(projectCard(page, "General")).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expectVisibleKeyboardFocus(projectCard(page, "General"));

  await page.getByRole("button", { name: "Go back" }).click();
  await expect(page.getByTestId("chat-input")).toBeVisible();
});

test("undo in the banner window brings the deleted project back", async ({
  page,
}) => {
  await page.goto("/");
  await expect(page.getByTestId("chat-input")).toBeVisible();

  await openProjects(page);
  await createProject(page, "Recoverable");
  await openProjects(page);

  await deleteProjectThroughDialog(page, "Recoverable");
  await expect(projectCard(page, "Recoverable")).toHaveCount(0);

  // The delete has already committed — the undo bar is a second chance on top
  // of the tombstones, not a stay of execution.
  const banner = page.getByTestId("banner-undo-delete-project");
  await expect(banner).toBeVisible();
  await expect(banner).toContainText("“Recoverable” deleted");

  await page.getByTestId("button-undo-delete-project").click();

  // The project is back and active again, the bar is gone, and keyboard focus
  // lands on the always-present create control rather than vanishing with the
  // bar (the same predictable-landing rule the dialogs follow).
  await expect(banner).toHaveCount(0);
  await expect(projectCard(page, "Recoverable")).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(page.getByTestId("create-project")).toBeFocused();

  // The restored workspace is fully usable from the chat surface.
  await page.getByRole("button", { name: "Go back" }).click();
  await expect(page.getByTestId("chat-input")).toBeVisible();
  await expect(page.getByTestId("open-projects")).toContainText("Recoverable");
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
  await expect(projectCard(page, "General")).toHaveCount(1);
  await deleteProjectThroughDialog(page, "General");

  // A replacement default workspace takes its place, already selected, and
  // keyboard focus lands on the replacement card.
  await expect(projectCard(page, "General")).toHaveCount(1);
  await expect(projectCard(page, "General")).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expectVisibleKeyboardFocus(projectCard(page, "General"));

  await page.getByRole("button", { name: "Go back" }).click();
  await expect(page.getByTestId("chat-input")).toBeVisible();

  // The board renders the fresh workspace: usable, and empty of the old tasks.
  await page.getByRole("tab", { name: "Open To-Do workspace" }).click();
  await expect(page.getByTestId("workspace-todo")).toBeVisible();
  await expect(page.getByText("Define data schema")).toHaveCount(0);
});

test("the delete control asks first, and cancelling leaves the project untouched", async ({
  page,
}) => {
  await page.goto("/");
  await expect(page.getByTestId("chat-input")).toBeVisible();

  await openProjects(page);
  await createProject(page, "Keeper");
  await openProjects(page);

  const deleteControl = page.getByRole("button", { name: "Delete Keeper" });
  await deleteControl.click();

  // Nothing is deleted yet: the dialog names the project and spells out what
  // disappears with it.
  const dialog = page.getByTestId("delete-project-dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText("Delete Keeper?")).toBeVisible();
  await expect(
    dialog.getByText(/chats, sources, board tasks, and archived evidence/),
  ).toBeVisible();
  await expect(projectCard(page, "Keeper")).toHaveCount(1);

  // Focus lands inside the dialog on the safe action, and the destructive
  // action is labeled by what it does rather than a bare "OK".
  await expect(page.getByTestId("cancel-delete-project")).toBeFocused();
  await expect(page.getByTestId("confirm-delete-project")).toContainText(
    "Delete project",
  );

  // Cancelling closes without deleting and hands focus back to the delete
  // control that opened the dialog.
  await page.getByTestId("cancel-delete-project").click();
  await expect(dialog).toHaveCount(0);
  await expect(projectCard(page, "Keeper")).toHaveCount(1);
  await expectVisibleKeyboardFocus(deleteControl);

  // Escape closes through onRequestClose and lands the same way.
  await deleteControl.click();
  await expect(page.getByTestId("cancel-delete-project")).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(projectCard(page, "Keeper")).toHaveCount(1);
  await expectVisibleKeyboardFocus(deleteControl);

  // The untouched project still opens normally.
  await projectCard(page, "Keeper").click();
  await expect(page.getByTestId("chat-input")).toBeVisible();
  await expect(page.getByTestId("open-projects")).toContainText("Keeper");
});
