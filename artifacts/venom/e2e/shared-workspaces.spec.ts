import { expect, test } from "@playwright/test";

/**
 * Shared workspaces on mobile are management-only (Task #281): the screen
 * reachable from Settings creates workspaces and manages members, and no
 * longer offers a personal/shared chat scope — knowledge files itself by
 * topic and the Brain screen carries the per-page filter. Membership data
 * and revocation are enforced server-side (api-server integration suite);
 * UI-test mode keeps this screen's queries disabled, so the smoke here is
 * the navigation and the management-only layout.
 */

test("settings opens the management-only shared workspaces screen", async ({
  page,
}) => {
  await page.goto("/settings?venomUiTest=true");

  const entry = page.getByTestId("open-shared-workspaces");
  await entry.scrollIntoViewIfNeeded();
  await expect(entry).toBeVisible();
  await entry.click();

  // Management surface: the create form plus the (empty) membership list.
  await expect(page.getByTestId("input-new-workspace-name")).toBeVisible();
  await expect(page.getByTestId("button-create-workspace")).toBeVisible();
  await expect(page.getByTestId("workspace-list-empty")).toBeVisible();

  // No personal/shared scope picker anymore, and no member management until
  // a workspace is picked for managing.
  await expect(page.getByTestId("select-space-personal")).toHaveCount(0);
  await expect(page.getByTestId("input-new-member-id")).toHaveCount(0);
});
