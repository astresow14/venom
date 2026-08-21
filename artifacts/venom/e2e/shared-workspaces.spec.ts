import { expect, test } from "@playwright/test";

/**
 * Shared workspaces on mobile: the management screen is reachable from
 * Settings and renders its personal/shared picker without a network round
 * trip. Membership data, workspace knowledge, and revocation are enforced
 * server-side (api-server integration suite) and the client eviction path is
 * pinned by the desktop suite; UI-test mode keeps this screen's queries
 * disabled, so the smoke here is the navigation and the default personal
 * tier.
 */

test("settings opens the shared workspaces screen in the personal tier", async ({
  page,
}) => {
  await page.goto("/settings?venomUiTest=true");

  const entry = page.getByTestId("open-shared-workspaces");
  await entry.scrollIntoViewIfNeeded();
  await expect(entry).toBeVisible();
  await entry.click();

  // The screen renders with the personal space selected by default.
  await expect(page.getByTestId("select-space-personal")).toBeVisible();
  await expect(page.getByTestId("input-new-workspace-name")).toBeVisible();
  await expect(page.getByTestId("button-create-workspace")).toBeVisible();

  // No shared space is selected, so member management stays hidden.
  await expect(page.getByTestId("input-new-member-id")).toHaveCount(0);
});
