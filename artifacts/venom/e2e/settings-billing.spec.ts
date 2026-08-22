import { expect, test } from "@playwright/test";

/**
 * Subscription billing on mobile: the Settings Billing section (plan card,
 * allowance meter, Stripe-hosted upgrade entry, covered-workspace note) and
 * the chat composer's payer hint.
 *
 * UI-test mode renders the Billing and Usage sections from deterministic
 * fixtures — no unstubbed fetch fires. The composer hint reads the live
 * billing-context endpoint, so that one call is stubbed at the network
 * layer. Enforcement and payer resolution are pinned server-side by the
 * api-server billing suite.
 */

test("settings shows the personal plan, allowance meter, and covered note", async ({
  page,
}, testInfo) => {
  test.skip(
    testInfo.project.name === "desktop-chromium",
    "The settings surface is verified at the mobile viewport.",
  );

  await page.goto("/settings?venomUiTest=true");

  const section = page.getByTestId("settings-billing-section");
  await expect(section).toBeVisible();
  // The section explains the space rule in one line.
  await expect(section).toContainText(
    "Chats in a workspace with an Organization plan bill that workspace",
  );

  // Plan card: name, price/reset line, meter with figures.
  await expect(page.getByTestId("billing-plan-name")).toHaveText("Free");
  await expect(page.getByTestId("billing-renewal")).toContainText(
    "allowance resets September 1, 2026",
  );
  await expect(page.getByTestId("billing-meter")).toBeVisible();
  await expect(page.getByTestId("billing-meter-figures")).toHaveText(
    "$1.86 of $5",
  );

  // Healthy state: no warnings, an upgrade path, and no keyless badge.
  await expect(page.getByTestId("billing-state-approaching")).toHaveCount(0);
  await expect(page.getByTestId("billing-state-exhausted")).toHaveCount(0);
  await expect(page.getByTestId("billing-upgrade")).toContainText(
    "Upgrade to Venom Plus",
  );
  await expect(page.getByTestId("billing-not-configured")).toHaveCount(0);

  // Workspace-covered activity: named, without spend figures.
  const coveredNote = page.getByTestId("usage-covered-note");
  await coveredNote.scrollIntoViewIfNeeded();
  await expect(coveredNote).toContainText("Design Guild");
  await expect(coveredNote).toContainText("doesn\u2019t count against yours");
  const noteText = (await coveredNote.innerText()) ?? "";
  expect(noteText).not.toMatch(/\$\d/);
});

test("the composer shows whose allowance a chat draws on", async ({
  page,
}, testInfo) => {
  test.skip(
    testInfo.project.name === "desktop-chromium",
    "The composer hint is verified at the mobile viewport.",
  );

  await page.route("**/venom/billing/context*", async (route) => {
    if (route.request().method() !== "GET") {
      await route.fallback();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        configured: true,
        enforced: true,
        payer: "personal",
        planName: "Free",
        state: "approaching",
        remainingUsd: 0.9,
      }),
    });
  });

  await page.goto("/?venomUiTest=true");

  const hint = page.getByTestId("composer-payer-hint");
  await expect(hint).toBeVisible();
  await expect(hint).toContainText("Free plan");
  // Approaching the limit is a nudge, not a block.
  await expect(hint).toContainText("running low");
});
