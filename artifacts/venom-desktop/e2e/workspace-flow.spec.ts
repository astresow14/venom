import { expect, test, type Page } from '@playwright/test';

/**
 * Core workspace regression for Venom Desktop.
 *
 * Covers the shell (drawer navigation, sync indicator, thread list) and the
 * task board, which together are the flow every desktop session goes through.
 * Chat streaming is deliberately out of scope: it needs a signed-in Clerk user
 * and the live model service, neither of which exist in the UI test build.
 */

/**
 * The workspace shell is backend-independent, but the Apps section reads the
 * portfolio API. CI runs the desktop bundle without an API server, so the list
 * endpoint is stubbed to keep the regression hermetic and deterministic.
 */
test.beforeEach(async ({ page }) => {
  await page.route('**/venom/apps', async (route) => {
    if (route.request().method() !== 'GET') {
      await route.fallback();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: '[]',
    });
  });
});

async function openDrawer(page: Page) {
  await page.getByRole('button', { name: 'Open navigation' }).click();
  const drawer = page.getByRole('dialog', { name: 'Navigation Menu' });
  await expect(drawer).toBeVisible();
  return drawer;
}

test('routes into the workspace and moves between sections from the drawer', async ({
  page,
}) => {
  await page.goto('/workspace');

  await expect(page).toHaveURL(/\/workspace\/chat$/);
  await expect(
    page.getByRole('heading', { name: 'How can I help?' }),
  ).toBeVisible();

  const header = page.getByRole('banner');
  await expect(header.getByText('Global Workspace')).toBeVisible();
  await expect(header.getByLabel('Synced')).toBeVisible();

  const sections: { link: string; assert: () => Promise<void> }[] = [
    {
      link: 'Feed',
      assert: async () => {
        await expect(page).toHaveURL(/\/workspace\/feed$/);
        await expect(page.getByRole('heading', { name: 'Feed' })).toBeVisible();
      },
    },
    {
      link: 'Brain',
      assert: async () => {
        await expect(page).toHaveURL(/\/workspace\/brain$/);
        await expect(
          page.getByRole('region', { name: /Knowledge map with \d+ nodes/ }),
        ).toBeVisible();
      },
    },
    {
      link: 'To-Do',
      assert: async () => {
        await expect(page).toHaveURL(/\/workspace\/tasks$/);
        await expect(
          page.getByRole('heading', { name: 'Task Board' }),
        ).toBeVisible();
      },
    },
    {
      link: 'Apps',
      assert: async () => {
        await expect(page).toHaveURL(/\/workspace\/apps$/);
        await expect(
          page.getByRole('heading', { name: 'App Portfolio' }),
        ).toBeVisible();
        await expect(
          page.getByRole('heading', { name: 'No apps registered' }),
        ).toBeVisible();
      },
    },
    {
      link: 'Chats',
      assert: async () => {
        await expect(page).toHaveURL(/\/workspace\/chat$/);
        await expect(
          page.getByRole('heading', { name: 'How can I help?' }),
        ).toBeVisible();
      },
    },
  ];

  for (const section of sections) {
    const drawer = await openDrawer(page);
    await drawer.getByRole('link', { name: section.link, exact: true }).click();
    await section.assert();
    // The drawer closes itself on navigation; the next iteration reopens it.
    await expect(
      page.getByRole('dialog', { name: 'Navigation Menu' }),
    ).toBeHidden();
  }
});

test('creates a task, advances it across the board, and deletes it', async ({
  page,
}) => {
  await page.goto('/workspace/tasks');

  await expect(page.getByRole('heading', { name: 'Task Board' })).toBeVisible();
  const seeded = await page.getByRole('listitem').count();
  expect(seeded).toBeGreaterThan(0);

  const title = 'Wire the desktop regression';
  const objectiveInput = page.getByLabel('Identify new objective');
  await objectiveInput.fill(title);
  await objectiveInput.press('Enter');

  const card = page.getByRole('listitem').filter({ hasText: title });
  await expect(card).toHaveCount(1);
  await expect(page.getByRole('listitem')).toHaveCount(seeded + 1);
  // The input clears so the next objective can be typed straight away.
  await expect(objectiveInput).toHaveValue('');

  // A new task starts in Pending, so only the forward moves are offered.
  await expect(
    page.getByRole('button', { name: `Move "${title}" to Pending` }),
  ).toHaveCount(0);
  await page
    .getByRole('button', { name: `Move "${title}" to Executing` })
    .click();

  // Once executing, Pending becomes reachable again and Executing disappears.
  await expect(
    page.getByRole('button', { name: `Move "${title}" to Pending` }),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: `Move "${title}" to Executing` }),
  ).toHaveCount(0);

  await page
    .getByRole('button', { name: `Move "${title}" to Resolved` })
    .click();
  await expect(
    page.getByRole('button', { name: `Move "${title}" to Resolved` }),
  ).toHaveCount(0);
  await expect(
    page.getByRole('button', { name: `Move "${title}" to Executing` }),
  ).toBeVisible();

  page.once('dialog', (dialog) => {
    expect(dialog.message()).toContain(title);
    void dialog.accept();
  });
  await page.getByRole('button', { name: `Delete "${title}"` }).click();

  await expect(card).toHaveCount(0);
  await expect(page.getByRole('listitem')).toHaveCount(seeded);
});

test('starts a new thread from the drawer and keeps it in recent threads', async ({
  page,
}) => {
  await page.goto('/workspace/chat');
  await expect(
    page.getByRole('heading', { name: 'How can I help?' }),
  ).toBeVisible();

  const firstDrawer = await openDrawer(page);
  const threads = firstDrawer
    .getByRole('button')
    .filter({ hasText: 'New Session' });
  await expect(threads).toHaveCount(1);

  await firstDrawer
    .getByRole('button', { name: 'New chat', exact: true })
    .last()
    .click();

  await expect(page).toHaveURL(/\/workspace\/chat$/);
  await expect(
    page.getByRole('dialog', { name: 'Navigation Menu' }),
  ).toBeHidden();
  await expect(
    page.getByRole('heading', { name: 'How can I help?' }),
  ).toBeVisible();

  const secondDrawer = await openDrawer(page);
  await expect(
    secondDrawer.getByRole('button').filter({ hasText: 'New Session' }),
  ).toHaveCount(2);
  // The freshly created thread is the selected one.
  await expect(
    secondDrawer.locator('button[aria-current="page"]'),
  ).toHaveCount(1);
});

// ci guard verification: desktop-scoped change
