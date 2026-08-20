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

async function expectTabStops(
  page: Page,
  title: (typeof WORKSPACE_TABS)[number],
) {
  const expectedIndex = WORKSPACE_TABS.indexOf(title);
  await expect
    .poll(() =>
      page.getByRole("tab").evaluateAll((elements) =>
        elements.map((element) => element.getAttribute("tabindex")),
      ),
    )
    .toEqual(
      WORKSPACE_TABS.map((_, index) => (index === expectedIndex ? "0" : "-1")),
    );
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
}, testInfo) => {
  test.skip(
    testInfo.project.name === "desktop-chromium",
    "Mouse swipes are covered on the mobile web viewport.",
  );

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

test("supports a predictable keyboard tab pattern", async ({ page }) => {
  await page.goto("/");
  await expectTabStops(page, "Chat");
  await tab(page, "Chat").focus();
  await expect(tab(page, "Chat")).toBeFocused();
  await expectOnlySelected(page, "Chat");

  await page.keyboard.press("ArrowRight");
  await expect(tab(page, "Feed")).toBeFocused();
  await expectTabStops(page, "Feed");
  await expectOnlySelected(page, "Chat");

  await page.keyboard.press("Enter");
  await expectOnlySelected(page, "Feed");

  await page.keyboard.press("ArrowRight");
  await expect(tab(page, "Brain")).toBeFocused();
  await expectTabStops(page, "Brain");
  await page.keyboard.press(" ");
  await expectOnlySelected(page, "Brain");

  await page.keyboard.press("End");
  await expect(tab(page, "To-Do")).toBeFocused();
  await expectTabStops(page, "To-Do");
  await expectOnlySelected(page, "Brain");

  await page.keyboard.press("Home");
  await expect(tab(page, "Chat")).toBeFocused();
  await page.keyboard.press("ArrowLeft");
  await expect(tab(page, "To-Do")).toBeFocused();
  await expectOnlySelected(page, "Brain");
});
