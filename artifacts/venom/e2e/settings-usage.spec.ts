import { expect, test } from "@playwright/test";

/**
 * The personal Usage section in mobile Settings.
 *
 * UI-test mode substitutes a deterministic summary fixture (no unstubbed
 * fetch fires), so this spec proves the rendered contract: month spend in
 * dollars, a daily trend, a per-model breakdown under Venom-branded names,
 * and the estimate caveat whenever flagged entries are present.
 */

test("settings shows this month's AI spend from the personal ledger", async ({
  page,
}, testInfo) => {
  test.skip(
    testInfo.project.name === "desktop-chromium",
    "The settings surface is verified at the mobile viewport.",
  );

  await page.goto("/settings?venomUiTest=true");

  const section = page.getByTestId("settings-usage-section");
  await expect(section).toBeVisible();
  await expect(section).toContainText("Only you can see this.");

  // Month headline: dollars plus request and token counts.
  await expect(page.getByTestId("usage-month-total")).toHaveText("$1.86");
  await expect(page.getByTestId("usage-requests-total")).toHaveText(
    "42 requests · 127k tokens",
  );

  // Daily trend: one bar per reported day in the fixture.
  await expect(page.getByTestId("usage-daily-trend")).toBeVisible();
  await expect(page.getByTestId("usage-day-2026-08-14")).toBeAttached();
  await expect(page.getByTestId("usage-day-2026-08-18")).toBeAttached();

  // Per-model breakdown: Venom-branded names and dollars only.
  const gptRow = page.getByTestId("usage-model-row-venom-gpt");
  await expect(gptRow).toContainText("Venom GPT");
  await expect(gptRow).toContainText("$1.24");
  await expect(gptRow).toContainText("26 requests · 70.0k in / 22.0k out");
  await expect(gptRow).not.toContainText("*");

  const claudeRow = page.getByTestId("usage-model-row-venom-claude");
  await expect(claudeRow).toContainText("Venom Claude *");

  const voiceRow = page.getByTestId("usage-model-row-venom-voice");
  await expect(voiceRow).toContainText("Venom Voice");
  await expect(voiceRow).toContainText("$0.05");

  // Flagged entries exist, so the caveat explains the asterisk.
  await expect(page.getByTestId("usage-estimate-note")).toContainText(
    "Some entries are estimates",
  );

  // The section stays in the product's vocabulary — no provider SKUs.
  const sectionText = (await section.innerText()) ?? "";
  expect(sectionText).not.toMatch(/gpt-\d|claude-\d|gemini-\d|grok-\d/i);
});
