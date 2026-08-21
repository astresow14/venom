import { expect, test } from '@playwright/test';
import { stubWorkspaceApis } from './support/stubs';

test.use({ timezoneId: 'America/Los_Angeles' });

test.beforeEach(async ({ page }) => {
  await stubWorkspaceApis(page);
});

test('keeps a date-only agenda item on its calendar day west of UTC', async ({
  page,
}) => {
  await page.route('**/venom/community/briefing*', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        community: [],
        agenda: [
          {
            id: 'agenda_due_date',
            source: 'todo',
            privacy: 'personal',
            title: 'Publish the community briefing',
            detail: null,
            startsAt: null,
            dueDate: '2026-06-15',
            state: 'open',
            projectName: 'Venom',
          },
        ],
        calendarStatus: 'not_connected',
        viewerProfile: null,
        nextCursor: null,
      }),
    }),
  );

  await page.goto('/workspace/feed');

  await expect(page.getByText('Due Jun 15', { exact: true })).toBeVisible();
  await expect(page.getByText('Due Jun 14', { exact: true })).toHaveCount(0);
});