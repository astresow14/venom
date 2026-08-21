import { expect, test } from '@playwright/test';
import { stubWorkspaceApis } from './support/stubs';

const APP_ID = 'a0000000-0000-4000-8000-000000000001';

const SUGGESTED_APP = {
  id: APP_ID,
  name: 'Field Guide',
  brand: 'Venom Labs',
  status: 'active',
  description: 'Companion site fed by the Atlas project.',
  linkedProjectId: 'proj_alpha',
  linkedProjectName: 'Atlas Research',
  latestIterationNumber: 1,
  improvementSignal: {
    summary: 'Atlas Research absorbed 3 new concepts since package v1.',
    baselineIterationNumber: 1,
    knowledgeChanges: 3,
    sourceChanges: 0,
    computedAt: '2026-08-20T12:00:00.000Z',
  },
};

test.beforeEach(async ({ page }) => {
  await stubWorkspaceApis(page);
});

test('dismisses an improvement suggestion from the feed without leaving it', async ({
  page,
}) => {
  let dismissed = false;
  let dismissCalls = 0;

  await page.route('**/venom/apps', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(dismissed ? [] : [SUGGESTED_APP]),
    }),
  );
  await page.route(
    `**/venom/apps/${APP_ID}/improvement-suggestion/dismiss`,
    (route) => {
      dismissCalls += 1;
      dismissed = true;
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ ...SUGGESTED_APP, improvementSignal: null }),
      });
    },
  );

  await page.goto('/workspace/feed');

  // The review-first suggestion surfaces on the feed.
  const card = page.getByTestId(`card-suggestion-${APP_ID}`);
  await expect(card).toBeVisible();
  await expect(card).toContainText('Field Guide');
  await expect(card).toContainText('3 new concepts');

  // Dismissing works inline: it hits the dismiss endpoint, removes the card,
  // and does not navigate into the app record.
  await page.getByTestId(`button-feed-dismiss-${APP_ID}`).click();
  await expect(card).toHaveCount(0);
  await expect(page).toHaveURL(/\/workspace\/feed$/);
  expect(dismissCalls).toBe(1);
  await expect(
    page.getByRole('heading', { name: 'Improvement suggestions' }),
  ).toHaveCount(0);
});
