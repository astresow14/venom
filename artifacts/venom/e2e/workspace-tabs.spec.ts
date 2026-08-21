import { expect, test, type Page } from "@playwright/test";

const WORKSPACE_TABS = ["Chat", "Feed", "Notifications", "Brain", "To-Do"] as const;

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

async function expectVisibleTabFocus(
  page: Page,
  title: (typeof WORKSPACE_TABS)[number],
) {
  const workspaceTab = tab(page, title);
  await expect(workspaceTab).toBeFocused();

  const focusRing = await workspaceTab.evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      color: style.outlineColor,
      offset: Number.parseFloat(style.outlineOffset),
      style: style.outlineStyle,
      width: Number.parseFloat(style.outlineWidth),
    };
  });

  expect(focusRing.style).toBe("solid");
  expect(focusRing.width).toBeGreaterThanOrEqual(2);
  expect(focusRing.offset).toBeGreaterThanOrEqual(2);
  expect(focusRing.color).not.toBe("rgba(0, 0, 0, 0)");
}

const WORKSPACE_TEST_IDS = {
  Chat: "workspace-chat",
  Feed: "workspace-feed",
  Notifications: "workspace-notifications",
  Brain: "workspace-brain",
  "To-Do": "workspace-todo",
} as const;

async function swipeWorkspaceLeft(
  page: Page,
  from: (typeof WORKSPACE_TABS)[number],
) {
  const workspace = page.getByTestId(WORKSPACE_TEST_IDS[from]);
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

  await swipeWorkspaceLeft(page, "Chat");
  await expectOnlySelected(page, "Feed");

  await swipeWorkspaceLeft(page, "Feed");
  await expectOnlySelected(page, "Notifications");

  await swipeWorkspaceLeft(page, "Notifications");
  await expectOnlySelected(page, "Brain");

  // Brain owns horizontal gestures for its map, so workspace paging stops here.
  await swipeWorkspaceLeft(page, "Brain");
  await expectOnlySelected(page, "Brain");

  await tab(page, "To-Do").click();
  await expectOnlySelected(page, "To-Do");

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
  await expect(tab(page, "Notifications")).toBeFocused();
  await expectTabStops(page, "Notifications");
  await page.keyboard.press(" ");
  await expectOnlySelected(page, "Notifications");

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

test("keeps keyboard focus visible in forced colors without selecting the tab", async ({
  page,
}) => {
  await page.emulateMedia({ forcedColors: "active" });
  await page.goto("/");
  await expect
    .poll(() => page.evaluate(() => matchMedia("(forced-colors: active)").matches))
    .toBe(true);

  await tab(page, "Chat").focus();
  await page.keyboard.press("ArrowRight");
  await expectVisibleTabFocus(page, "Feed");
  await expectOnlySelected(page, "Chat");

  await page.getByTestId("theme-toggle").click();
  await tab(page, "Chat").focus();
  await page.keyboard.press("ArrowRight");
  await expectVisibleTabFocus(page, "Feed");
  await expectOnlySelected(page, "Chat");
});
