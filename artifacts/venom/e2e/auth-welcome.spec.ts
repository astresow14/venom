import { expect, test, type Page } from "@playwright/test";

/**
 * Signed-out welcome / sign-in coverage.
 *
 * Every other spec runs in UI-test mode, which bypasses auth entirely, so
 * this is the one place the Strike-first welcome screen is exercised. It
 * opts back into the real Clerk-gated flow with `?venomUiTest=false`
 * (see context/VenomContext.tsx) and needs no credentials: sign-in attempts
 * never reach Clerk because POST /v1/client/sign_ins is stubbed with the
 * deterministic 422 a wrong password would produce. Clerk's script/
 * environment/client loads stay live — ClerkLoaded gates the whole app, so
 * the entire suite already depends on them on every page load.
 */

// Copy from the retired card design. If either string reappears on the
// welcome state, the Strike-first redesign has regressed.
const LEGACY_EYEBROW_COPY = "Welcome back";
const LEGACY_TITLE_COPY = "Resume your workspace";

async function installSignedOutStubs(page: Page) {
  const state = { signInAttempts: 0 };

  // No API server runs in CI (see e2e/README.md). The signed-out app should
  // not call it at all; a fast 404 keeps any accidental call from hanging.
  await page.route("**/api/venom/**", (route) =>
    route.fulfill({
      status: 404,
      contentType: "application/json",
      body: JSON.stringify({ error: "Not found" }),
    }),
  );

  // Credentials never reach Clerk: creating a sign-in attempt resolves to
  // the same 422 Clerk returns for a wrong password. Non-POST traffic (if
  // any) falls through untouched.
  await page.route("**/v1/client/sign_ins**", async (route) => {
    if (route.request().method() !== "POST") {
      await route.fallback();
      return;
    }
    state.signInAttempts += 1;
    await route.fulfill({
      status: 422,
      contentType: "application/json",
      body: JSON.stringify({
        errors: [
          {
            message: "Password is incorrect. Try again, or use another method.",
            long_message:
              "Password is incorrect. Try again, or use another method.",
            code: "form_password_incorrect",
            meta: { param_name: "password" },
          },
        ],
        clerk_trace_id: "e2e-auth-welcome-stub",
      }),
    });
  });

  return state;
}

test("signed-out welcome survives the email round trip and links to sign-up", async ({
  page,
}) => {
  const state = await installSignedOutStubs(page);

  // Land on the root like a real signed-out visit: the auth gate should
  // redirect to the welcome state. First paint waits on live Clerk init,
  // so give it headroom beyond the 10s expect default.
  await page.goto("/?venomUiTest=false");
  await expect(
    page.getByRole("heading", { name: "Strike first" }),
  ).toBeVisible({ timeout: 30_000 });

  // Welcome state: the two pills, no credentials, no card-era copy.
  await expect(page.getByTestId("google-sign-in")).toBeVisible();
  await expect(page.getByTestId("continue-with-email")).toBeVisible();
  await expect(page.getByText(LEGACY_EYEBROW_COPY)).toHaveCount(0);
  await expect(page.getByText(LEGACY_TITLE_COPY)).toHaveCount(0);
  await expect(page.getByTestId("sign-in-email")).toHaveCount(0);
  await expect(page.getByTestId("sign-in-error")).toHaveCount(0);

  // "Continue with email" reveals the credentials step.
  await page.getByTestId("continue-with-email").click();
  await expect(page.getByTestId("sign-in-email")).toBeVisible();
  await expect(page.getByTestId("sign-in-password")).toBeVisible();
  await expect(page.getByTestId("submit-sign-in")).toBeVisible();

  // A failed attempt surfaces its error on the credentials step…
  await page.getByTestId("sign-in-email").fill("venom@example.com");
  await page.getByTestId("sign-in-password").fill("wrong-password-123");
  await page.getByTestId("submit-sign-in").click();
  await expect(page.getByTestId("sign-in-error")).toBeVisible();
  expect(state.signInAttempts).toBeGreaterThanOrEqual(1);

  // …and backing out returns a clean welcome: the stale credential error
  // must not leak onto the welcome state (the regression that motivated
  // this spec).
  await page
    .getByRole("button", { name: "Back to all sign-in options" })
    .click();
  await expect(page.getByTestId("continue-with-email")).toBeVisible();
  await expect(page.getByTestId("google-sign-in")).toBeVisible();
  await expect(page.getByTestId("sign-in-error")).toHaveCount(0);
  await expect(page.getByTestId("sign-in-email")).toHaveCount(0);

  // The sign-up cross-link lands on account creation.
  await page.getByRole("link", { name: "Create an account" }).click();
  await expect(
    page.getByRole("heading", { name: "Create your account" }),
  ).toBeVisible();
  await expect(page.getByTestId("sign-up-email")).toBeVisible();
});
