import { expect, test, type Page, type Route } from "@playwright/test";

const APP_ID = "a0000000-0000-4000-8000-000000000001";
const NOW = "2026-08-20T12:00:00.000Z";

const SUGGESTED_APP = {
  id: APP_ID,
  name: "Field Guide",
  brand: "Venom Labs",
  status: "active",
  description: "Companion site fed by the Atlas project.",
  linkedProjectId: "proj_alpha",
  linkedProjectName: "Atlas Research",
  latestIterationNumber: 1,
  improvementSignal: {
    summary: "Atlas Research absorbed 3 new concepts since package v1.",
    baselineIterationNumber: 1,
    knowledgeChanges: 3,
    sourceChanges: 0,
    computedAt: NOW,
  },
};

async function installFeedApi(page: Page) {
  const state = { dismissed: false, dismissCalls: 0 };

  await page.route("**/api/venom/**", async (route: Route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;

    if (path === "/api/venom/apps" && request.method() === "GET") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(state.dismissed ? [] : [SUGGESTED_APP]),
      });
      return;
    }

    if (
      path === `/api/venom/apps/${APP_ID}/improvement-suggestion/dismiss` &&
      request.method() === "POST"
    ) {
      state.dismissCalls += 1;
      state.dismissed = true;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ ...SUGGESTED_APP, improvementSignal: null }),
      });
      return;
    }

    if (path === "/api/venom/community/briefing") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          community: [],
          agenda: [],
          calendarStatus: "not_connected",
          viewerProfile: null,
          nextCursor: null,
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

  return state;
}

test("dismisses a feed improvement suggestion without leaving the feed", async ({
  page,
}) => {
  const state = await installFeedApi(page);

  await page.goto("/?venomUiTest=true");
  await page.getByRole("tab", { name: "Open Feed workspace" }).click();

  const card = page.getByTestId(`feed-suggestion-${APP_ID}`);
  await expect(card).toBeVisible();
  await expect(card).toContainText("3 new concepts");

  await page.getByTestId(`button-feed-dismiss-${APP_ID}`).click();
  await expect(card).toHaveCount(0);
  expect(state.dismissCalls).toBe(1);

  // Dismissing stays on the feed instead of following the card link.
  await expect(page.getByTestId("workspace-feed")).toBeVisible();
});
