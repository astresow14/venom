import { expect, test, type Page } from "@playwright/test";

const WORKSPACE_TABS = ["Chat", "Feed", "Brain", "To-Do"] as const;

function tab(page: Page, title: (typeof WORKSPACE_TABS)[number]) {
  return page.getByRole("tab", { name: `Open ${title} workspace` });
}

async function expectOnlySelected(
  page: Page,
  title: (typeof WORKSPACE_TABS)[number],
) {
  const tabs = page.getByRole("tab");
  await expect(tabs).toHaveCount(WORKSPACE_TABS.length);

  await expect
    .poll(async () => {
      const selectedValues = await tabs.evaluateAll((elements) =>
        elements.map((element) => element.getAttribute("aria-selected")),
      );

      return {
        selectedCount: selectedValues.filter((value) => value === "true")
          .length,
        selectedTitle: await tab(page, title).getAttribute("aria-selected"),
      };
    })
    .toEqual({ selectedCount: 1, selectedTitle: "true" });
}

async function swipeWorkspaceLeft(page: Page) {
  const workspace = page.getByTestId("workspace-chat");
  const bounds = await workspace.boundingBox();
  expect(bounds).not.toBeNull();
  if (!bounds) return;

  const y = bounds.y + Math.min(bounds.height / 2, 260);
  await page.mouse.move(bounds.x + bounds.width - 70, y);
  await page.mouse.down();
  await page.mouse.move(bounds.x + 70, y, { steps: 12 });
  await page.mouse.up();
}

test("keeps exactly one workspace tab selected after clicks, a swipe, and refresh", async ({
  page,
}) => {
  await page.goto("/");
  await expectOnlySelected(page, "Chat");

  for (const title of WORKSPACE_TABS.slice(1)) {
    await tab(page, title).click();
    await expectOnlySelected(page, title);
  }

  await tab(page, "Chat").click();
  await expectOnlySelected(page, "Chat");

  await swipeWorkspaceLeft(page);
  await expectOnlySelected(page, "Feed");

  await page.reload();
  await expectOnlySelected(page, "Chat");
});
