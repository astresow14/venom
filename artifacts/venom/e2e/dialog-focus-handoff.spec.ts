import {
  expect,
  test,
  type Locator,
  type Page,
  type Route,
} from "@playwright/test";

/**
 * The project picker and the app-creation dialog share the card editor's
 * dismissal pattern (see BoardWorkspace in app/index.tsx): no modal animation
 * on web — a fading modal keeps its focus trap alive and strands keyboard
 * focus when its opener has been replaced — plus an explicit focus handoff to
 * a visible control related to what the user just did.
 */

const APP_ID = "b0000000-0000-4000-8000-000000000042";
const NOW = "2026-08-21T09:00:00.000Z";

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

test("project dialog dismissal keeps keyboard focus on a related control", async ({
  page,
}) => {
  await page.goto("/?venomUiTest=true");
  await expect(page.getByTestId("chat-input")).toBeVisible();

  await page.getByTestId("open-projects").click();
  const createButton = page.getByTestId("create-project");
  await expect(createButton).toBeVisible();

  // Cancelling stays on the projects screen: focus returns to the button
  // that opened the dialog.
  await createButton.click();
  await expect(page.getByTestId("new-project-name")).toBeFocused();
  await page.getByRole("button", { name: "Cancel" }).click();
  await expectVisibleKeyboardFocus(createButton);

  // Escape closes through onRequestClose and lands the same way.
  await createButton.click();
  await expect(page.getByTestId("new-project-name")).toBeFocused();
  await page.keyboard.press("Escape");
  await expectVisibleKeyboardFocus(createButton);

  // Creating pops back to the workspace: focus lands on the project
  // switcher, which now names the project that was just created.
  await createButton.click();
  await page.getByTestId("new-project-name").fill("Handoff Target");
  await page.getByTestId("save-project").click();
  await expect(page.getByTestId("chat-input")).toBeVisible();
  await expect(page.getByTestId("open-projects")).toContainText(
    "Handoff Target",
  );
  await expectVisibleKeyboardFocus(page.getByTestId("open-projects"));
});

function appPayload() {
  return {
    id: APP_ID,
    name: "Handoff Product",
    purpose: "Prove dialog dismissal focuses the created card.",
    brand: "Venom Labs",
    status: "draft",
    detectedStack: [],
    sourceType: "none",
    sourceVersion: 0,
    deploymentUrl: null,
    importStatus: null,
    sourceUpdatedAt: null,
    linkedProjectId: null,
    linkedProjectName: null,
    latestIterationNumber: 0,
    improvementSignal: null,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

// CI has no API server, so every portfolio endpoint the screen touches is
// stubbed: the list is empty until the POST "creates" the app, after which
// the refreshed list (and the detail poll) return it.
async function installPortfolioApi(page: Page) {
  const state = { created: false };
  await page.route("**/api/venom/**", async (route: Route) => {
    const request = route.request();
    const pathname = new URL(request.url()).pathname;

    if (pathname === "/api/venom/apps" && request.method() === "GET") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(state.created ? [appPayload()] : []),
      });
      return;
    }
    if (pathname === "/api/venom/apps" && request.method() === "POST") {
      state.created = true;
      await route.fulfill({
        status: 201,
        contentType: "application/json",
        body: JSON.stringify(appPayload()),
      });
      return;
    }
    if (
      pathname === `/api/venom/apps/${APP_ID}` &&
      request.method() === "GET"
    ) {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          app: appPayload(),
          versions: [],
          importJobs: [],
          deploymentLinks: [],
          provisioningReleases: [],
          iterations: [],
          timeline: [],
          timelineTotal: 0,
          timelineTruncated: false,
        }),
      });
      return;
    }
    await route.fulfill({
      status: 404,
      contentType: "application/json",
      body: JSON.stringify({ error: "Not found" }),
    });
  });
}

test("app creation dialog hands focus to the created card, cancel to its opener", async ({
  page,
}) => {
  await installPortfolioApi(page);
  await page.goto("/apps?venomUiTest=true");

  const createButton = page.getByRole("button", {
    name: "Create app record",
  });
  await expect(createButton).toBeVisible();

  // Cancelling: focus returns to the button that opened the dialog.
  await createButton.click();
  await expect(page.getByLabel("Product name")).toBeFocused();
  await page.getByRole("button", { name: "Cancel" }).click();
  await expectVisibleKeyboardFocus(createButton);

  // Escape closes this dialog too (onRequestClose), with the same handoff.
  await createButton.click();
  await expect(page.getByLabel("Product name")).toBeFocused();
  await page.keyboard.press("Escape");
  await expectVisibleKeyboardFocus(createButton);

  // Creating: the dialog stays up until the refreshed list contains the new
  // app, then focus lands on that app's card.
  await createButton.click();
  await page.getByLabel("Product name").fill("Handoff Product");
  await page
    .getByLabel("Purpose")
    .fill("Prove dialog dismissal focuses the created card.");
  await page.getByLabel("Brand").fill("Venom Labs");
  await page.getByRole("button", { name: "Create", exact: true }).click();
  const appCard = page.getByRole("button", {
    name: /^Open Handoff Product/,
  });
  await expect(appCard).toBeVisible();
  await expectVisibleKeyboardFocus(appCard);
});
