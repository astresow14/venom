import { expect, test } from "@playwright/test";

/**
 * Compiles the Expo web bundle before any real spec runs.
 *
 * The dev server builds the bundle on the first page request. On a loaded
 * machine that first compile can outlive a single test's 120s budget, which
 * used to fail whichever spec ran first (alphabetically brain-camera) with a
 * timeout at an assertion that had nothing to do with the slowdown. Paying
 * the compile here, under a dedicated generous budget, keeps every real
 * test's timing about the test itself.
 */
test("expo web bundle is compiled", async ({ page }) => {
  await page.goto("/?venomUiTest=true", { waitUntil: "domcontentloaded" });
  await expect(page.getByTestId("chat-input")).toBeVisible({
    timeout: 220_000,
  });
});
