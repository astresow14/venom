import { expect, test, type Locator, type Page } from "@playwright/test";

const CARD_TITLE = "Regression card";
const EDITED_CARD_TITLE = "Regression card edited";

async function openBoard(page: Page) {
  const boardTab = page.getByRole("tab", {
    name: "Open To-Do workspace",
  });
  await expect(boardTab).toBeVisible();
  await boardTab.click();
  await expect(boardTab).toHaveAttribute("aria-selected", "true");
  await expect(page.getByText("Task Board", { exact: true })).toBeVisible();
}

async function addField(
  page: Page,
  type: "Text" | "Number" | "Date" | "Single select" | "Checkbox",
  name: string,
  options?: string,
) {
  await page.getByRole("radio", { name: `${type} field type` }).click();
  await page.getByLabel("New field name").fill(name);
  if (options) {
    await page.getByLabel("New field options").fill(options);
  }
  await page.getByRole("button", { name: "Add field" }).click();
  await expect(page.getByLabel(`Rename field ${name}`)).toBeVisible();
}

async function stageOrder(page: Page) {
  return page
    .getByLabel(/^Rename stage /)
    .evaluateAll((inputs) =>
      inputs.map((input) => (input as HTMLInputElement).value),
    );
}

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

test("Kanban editing stays connected, accessible, and persistent", async ({
  page,
}) => {
  await page.goto("/?venomUiTest=true");
  await openBoard(page);

  await page.getByRole("button", { name: "Add card to To Do" }).click();
  const newTaskInput = page.getByLabel("New task title for To Do");
  await expect(newTaskInput).toBeFocused();
  await newTaskInput.fill(CARD_TITLE);
  await page.getByRole("button", { name: "Add card", exact: true }).click();
  await expect(
    page
      .getByRole("list", { name: "To Do stage" })
      .getByRole("button", { name: `Edit task ${CARD_TITLE}` }),
  ).toBeVisible();

  await page
    .getByRole("button", { name: `Edit task ${CARD_TITLE}` })
    .click();
  const titleInput = page.getByLabel("Task title");
  await expect(titleInput).toBeFocused();
  await titleInput.fill(EDITED_CARD_TITLE);
  await page.getByRole("radio", { name: "Move card to Active" }).click();
  await page.getByTestId("save-card-button").click();
  await expect(
    page
      .getByRole("list", { name: "Active stage" })
      .getByRole("button", { name: `Edit task ${EDITED_CARD_TITLE}` }),
  ).toBeVisible();

  // Saving returns keyboard focus to the edited card, even though the card
  // moved to another stage while the editor was open.
  const keyboardMove = page.getByRole("button", {
    name: `Move ${EDITED_CARD_TITLE} to next stage`,
  });
  await expectVisibleKeyboardFocus(keyboardMove);
  await keyboardMove.press("Enter");
  const doneCard = page
    .getByRole("list", { name: "Done stage" })
    .getByRole("button", { name: `Edit task ${EDITED_CARD_TITLE}` });
  await expect(doneCard).toBeVisible();
  await expect(doneCard.getByText(EDITED_CARD_TITLE, { exact: true })).toHaveCSS(
    "text-decoration-line",
    "line-through",
  );

  const draggableCard = page.getByRole("button", {
    name: `Edit task ${EDITED_CARD_TITLE}`,
  });
  await draggableCard.scrollIntoViewIfNeeded();
  const cardBox = await draggableCard.boundingBox();
  expect(cardBox).not.toBeNull();
  await page.mouse.move(
    cardBox!.x + cardBox!.width / 2,
    cardBox!.y + cardBox!.height / 2,
  );
  await page.mouse.down();
  await page.waitForTimeout(260);
  await page.mouse.move(
    cardBox!.x + cardBox!.width / 2 - 100,
    cardBox!.y + cardBox!.height / 2,
    { steps: 12 },
  );
  await page.mouse.up();
  const activeCard = page
    .getByRole("list", { name: "Active stage" })
    .getByRole("button", { name: `Edit task ${EDITED_CARD_TITLE}` });
  await expect(activeCard).toBeVisible();
  await expect(
    activeCard.getByText(EDITED_CARD_TITLE, { exact: true }),
  ).not.toHaveCSS("text-decoration-line", "line-through");

  await page.getByRole("button", { name: "Open board settings" }).click();
  await page.getByLabel("New stage name").fill("Review");
  await page.getByRole("button", { name: "Add stage" }).click();
  const reviewName = page.getByLabel("Rename stage Review");
  await reviewName.fill("QA");
  const qaName = page.getByLabel("Rename stage QA");
  await qaName.press("Tab");
  await expect(qaName).toBeVisible();

  const beforeReorder = await stageOrder(page);
  await page.getByRole("button", { name: "Move QA left" }).click();
  const afterReorder = await stageOrder(page);
  expect(afterReorder.indexOf("QA")).toBeLessThan(
    beforeReorder.indexOf("QA"),
  );
  const doneToggle = page.getByRole("checkbox", {
    name: "QA is a done stage",
  });
  await doneToggle.click();
  await expect(doneToggle).toBeChecked();

  await page
    .getByRole("button", { name: `Edit task ${EDITED_CARD_TITLE}` })
    .click();
  await page.getByRole("radio", { name: "Move card to QA" }).click();
  await page.getByTestId("save-card-button").click();
  const qaCard = page
    .getByRole("list", { name: "QA stage" })
    .getByRole("button", { name: `Edit task ${EDITED_CARD_TITLE}` });
  await expect(qaCard).toBeVisible();
  await expect(qaCard.getByText(EDITED_CARD_TITLE, { exact: true })).toHaveCSS(
    "text-decoration-line",
    "line-through",
  );

  await page.getByRole("button", { name: "Remove stage QA" }).click();
  await expect(page.getByText("Move its 1 cards to:")).toBeVisible();
  await page.getByRole("radio", { name: "Reassign cards to Active" }).click();
  await page.getByRole("button", { name: "Reassign & remove" }).click();
  await expect(page.getByLabel("Rename stage QA")).toHaveCount(0);
  await expect(
    page
      .getByRole("list", { name: "Active stage" })
      .getByRole("button", { name: `Edit task ${EDITED_CARD_TITLE}` }),
  ).toBeVisible();
  await expect(
    page
      .getByRole("list", { name: "Active stage" })
      .getByText(EDITED_CARD_TITLE, { exact: true }),
  ).not.toHaveCSS("text-decoration-line", "line-through");

  await addField(page, "Number", "Estimate");
  await addField(page, "Date", "Due");
  await addField(page, "Single select", "Priority", "High, Low");
  await addField(page, "Checkbox", "Approved");

  await page
    .getByRole("button", { name: `Edit task ${EDITED_CARD_TITLE}` })
    .click();
  await page.getByLabel("Estimate", { exact: true }).fill("8");
  await page.getByLabel("Due", { exact: true }).fill("2026-08-20");
  await page.getByRole("radio", { name: "Set Priority to High" }).click();
  await page
    .getByRole("checkbox", { name: "Approved", exact: true })
    .click();
  await page.getByTestId("save-card-button").click();

  const compactCard = page.getByRole("button", {
    name: `Edit task ${EDITED_CARD_TITLE}`,
  });
  await expect(compactCard.getByText("Estimate", { exact: true })).toBeVisible();
  await expect(compactCard.getByText("8", { exact: true })).toBeVisible();
  await expect(compactCard.getByText("Due", { exact: true })).toBeVisible();
  await expect(
    compactCard.getByText("2026-08-20", { exact: true }),
  ).toBeVisible();
  await expect(compactCard.getByText("Priority", { exact: true })).toBeVisible();
  await expect(compactCard.getByText("High", { exact: true })).toBeVisible();

  const estimateName = page.getByLabel("Rename field Estimate");
  await estimateName.fill("Points");
  const pointsName = page.getByLabel("Rename field Points");
  await pointsName.press("Tab");
  await expect(pointsName).toBeVisible();
  await expect(compactCard.getByText("Points", { exact: true })).toBeVisible();

  await compactCard.click();
  await page.getByLabel("Points", { exact: true }).fill("13");
  await expect(
    page.getByRole("checkbox", { name: "Approved", exact: true }),
  ).toBeChecked();
  await page.getByTestId("save-card-button").click();
  await expect(compactCard.getByText("13", { exact: true })).toBeVisible();

  await page.getByRole("button", { name: "Remove field Points" }).click();
  await expect(
    page.getByText("Remove Points and its values from every card?"),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Confirm removal of Points" })
    .click();
  await expect(page.getByLabel("Rename field Points")).toHaveCount(0);
  await expect(compactCard.getByText("Points", { exact: true })).toHaveCount(0);
  await expect(compactCard.getByText("13", { exact: true })).toHaveCount(0);

  await compactCard.click();
  await expect(page.getByLabel("Points", { exact: true })).toHaveCount(0);
  await expect(page.getByLabel("Due", { exact: true })).toHaveValue(
    "2026-08-20",
  );
  await expect(
    page.getByRole("radio", { name: "Set Priority to High" }),
  ).toBeChecked();
  await expect(
    page.getByRole("checkbox", { name: "Approved", exact: true }),
  ).toBeChecked();
  await page.getByRole("button", { name: "Close card editor" }).click();

  await page.reload();
  await openBoard(page);
  await expect(
    page
      .getByRole("list", { name: "Active stage" })
      .getByRole("button", { name: `Edit task ${EDITED_CARD_TITLE}` }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Open board settings" }).click();
  await expect(page.getByLabel("Rename stage QA")).toHaveCount(0);
  await expect(page.getByLabel("Rename field Points")).toHaveCount(0);
  await expect(page.getByLabel("Rename field Due")).toBeVisible();
  await expect(page.getByLabel("Rename field Priority")).toBeVisible();
  await expect(page.getByLabel("Rename field Approved")).toBeVisible();
  await compactCard.click();
  await expect(page.getByLabel("Points", { exact: true })).toHaveCount(0);
  await expect(page.getByLabel("Due", { exact: true })).toHaveValue(
    "2026-08-20",
  );
  await expect(
    page.getByRole("radio", { name: "Set Priority to High" }),
  ).toBeChecked();
  await expect(
    page.getByRole("checkbox", { name: "Approved", exact: true }),
  ).toBeChecked();
});

// The seeded workspace starts with "Design onboarding flow" in To Do; the
// two cards added here sit after it, so the deletions below exercise every
// neighbour branch: next card, previous card, then the empty stage.
test("Deleting a card hands keyboard focus to a surviving neighbour", async ({
  page,
}) => {
  await page.goto("/?venomUiTest=true");
  await openBoard(page);

  const toDoStage = page.getByRole("list", { name: "To Do stage" });
  for (const title of ["Delete target", "Delete survivor"]) {
    await page.getByRole("button", { name: "Add card to To Do" }).click();
    await page.getByLabel("New task title for To Do").fill(title);
    await page.getByRole("button", { name: "Add card", exact: true }).click();
    await expect(
      toDoStage.getByRole("button", { name: `Edit task ${title}` }),
    ).toBeVisible();
  }

  const deleteCard = async (title: string) => {
    await page.getByRole("button", { name: `Edit task ${title}` }).click();
    await page.getByRole("button", { name: "Delete card" }).click();
    await expect(
      page.getByText("Delete this card? This cannot be undone."),
    ).toBeVisible();
    await page.getByTestId("confirm-delete-card").click();
    await expect(
      toDoStage.getByRole("button", { name: `Edit task ${title}` }),
    ).toHaveCount(0);
  };

  // Deleting a middle card moves focus to the next card in the same stage.
  await deleteCard("Delete target");
  await expectVisibleKeyboardFocus(
    page.getByRole("button", { name: "Move Delete survivor to next stage" }),
  );

  // Deleting the last card falls back to the card before it.
  await deleteCard("Delete survivor");
  await expectVisibleKeyboardFocus(
    page.getByRole("button", {
      name: "Move Design onboarding flow to next stage",
    }),
  );

  // Deleting the only remaining card focuses the stage's Add card control.
  await deleteCard("Design onboarding flow");
  await expect(page.getByText("No cards in To Do")).toBeVisible();
  await expectVisibleKeyboardFocus(
    page.getByRole("button", { name: "Add card to To Do" }),
  );
});

// Confirming "Reassign & remove" on a stage or "Confirm removal" on a field
// unmounts the settings row that owned the focused confirm button, so board
// settings must hand keyboard focus to the control that takes the removed
// row's place: the next row's rename input, or the section's "New stage/field
// name" input when no row follows.
test("Removing a stage or field hands keyboard focus to a surviving settings control", async ({
  page,
}) => {
  await page.goto("/?venomUiTest=true");
  await openBoard(page);
  await page.getByRole("button", { name: "Open board settings" }).click();

  // The seeded board is To Do / Active / Done. Append a fourth stage so the
  // first removal exercises the bottom-row branch.
  await page.getByLabel("New stage name").fill("Wrap up");
  await page.getByRole("button", { name: "Add stage" }).click();
  await expect(page.getByLabel("Rename stage Wrap up")).toBeVisible();

  // Removing the bottom stage leaves no next row, so focus falls to the
  // "New stage name" input just below it.
  await page.getByRole("button", { name: "Remove stage Wrap up" }).click();
  await page.getByRole("button", { name: "Reassign & remove" }).click();
  await expect(page.getByLabel("Rename stage Wrap up")).toHaveCount(0);
  await expectVisibleKeyboardFocus(page.getByLabel("New stage name"));

  // Removing a middle stage hands focus to the next stage's rename input.
  await page.getByRole("button", { name: "Remove stage Active" }).click();
  await page.getByRole("button", { name: "Reassign & remove" }).click();
  await expect(page.getByLabel("Rename stage Active")).toHaveCount(0);
  await expectVisibleKeyboardFocus(page.getByLabel("Rename stage Done"));

  await addField(page, "Text", "Owner");
  await addField(page, "Number", "Effort");

  // Removing a field with a successor hands focus to that field's rename
  // input.
  await page.getByRole("button", { name: "Remove field Owner" }).click();
  await expect(
    page.getByText("Remove Owner and its values from every card?"),
  ).toBeVisible();
  await page.getByRole("button", { name: "Confirm removal of Owner" }).click();
  await expect(page.getByLabel("Rename field Owner")).toHaveCount(0);
  await expectVisibleKeyboardFocus(page.getByLabel("Rename field Effort"));

  // Removing the last field leaves none, so focus falls to the "New field
  // name" input.
  await page.getByRole("button", { name: "Remove field Effort" }).click();
  await page
    .getByRole("button", { name: "Confirm removal of Effort" })
    .click();
  await expect(page.getByLabel("Rename field Effort")).toHaveCount(0);
  await expectVisibleKeyboardFocus(page.getByLabel("New field name"));
});