import { expect, test, type Page } from '@playwright/test';
import { stubWorkspaceApis } from './support/stubs';

/**
 * Keyboard focus after deleting a task on the To-Do board.
 *
 * The delete button unmounts with its row, which used to drop focus back to
 * the page body and force keyboard and screen-reader users to tab in from the
 * top after every deletion. Deleting now hands focus to the closest surviving
 * neighbour in the same column — the row below, or the row above when the
 * bottom row went — and to the column's empty state once the deletion emptied
 * the column. Mirrors the phone board's behaviour.
 */

const STORAGE_KEY = '@venom_desktop_v1:venom-desktop-ui-test';
const NOW = 1_755_600_000_000; // fixed timestamp keeps the seed deterministic

// Columns render newest-first, so Pending shows Alpha, Beta, Gamma top to
// bottom; Resolved holds a single row whose deletion empties the column.
const SEEDED_STATE = {
  projects: [
    {
      id: 'proj_board',
      name: 'Board Ops',
      description: 'Browser-test project',
      accent: '#e5e5e5',
      sourceCount: 0,
      updatedAt: NOW - 1_000,
      tasks: [
        {
          id: 'task_alpha',
          title: 'Alpha objective',
          status: 'todo',
          createdAt: NOW - 1_000,
        },
        {
          id: 'task_beta',
          title: 'Beta objective',
          status: 'todo',
          createdAt: NOW - 2_000,
        },
        {
          id: 'task_gamma',
          title: 'Gamma objective',
          status: 'todo',
          createdAt: NOW - 3_000,
        },
        {
          id: 'task_solo',
          title: 'Solo resolved',
          status: 'done',
          createdAt: NOW - 4_000,
        },
      ],
    },
  ],
  conversations: [
    {
      id: 'conv_board',
      title: 'Board planning',
      projectId: 'proj_board',
      updatedAt: NOW - 1_000,
      messages: [],
    },
  ],
  clusters: [],
  sources: [],
  activeProjectId: 'proj_board',
  activeConversationId: 'conv_board',
};

async function openSeededBoard(page: Page) {
  await stubWorkspaceApis(page);
  // Seed only when the key is absent so reloads rehydrate what the app
  // persisted instead of resetting to the fixture.
  await page.addInitScript(
    ({ key, value }) => {
      if (!window.localStorage.getItem(key)) {
        window.localStorage.setItem(key, value);
      }
    },
    { key: STORAGE_KEY, value: JSON.stringify(SEEDED_STATE) },
  );
  // Every deletion confirms through window.confirm.
  page.on('dialog', (dialog) => void dialog.accept());
  await page.goto('/workspace/tasks');
  await expect(page.getByRole('heading', { name: 'To-Do' })).toBeVisible();
}

function deleteButton(page: Page, title: string) {
  return page.getByRole('button', { name: `Delete "${title}"` });
}

test('deleting a row hands keyboard focus to a surviving neighbour', async ({
  page,
}) => {
  await openSeededBoard(page);

  // Delete the middle Pending row from the keyboard.
  await deleteButton(page, 'Beta objective').focus();
  await page.keyboard.press('Enter');

  await expect(
    page.getByRole('listitem').filter({ hasText: 'Beta objective' }),
  ).toHaveCount(0);
  // Focus lands on the next row down instead of falling to the page body.
  await expect(deleteButton(page, 'Gamma objective')).toBeFocused();

  // Gamma is now the bottom row, so deleting it falls back to the row above.
  // Focus is already on its delete button — the keyboard user just continues.
  await page.keyboard.press('Enter');

  await expect(
    page.getByRole('listitem').filter({ hasText: 'Gamma objective' }),
  ).toHaveCount(0);
  await expect(deleteButton(page, 'Alpha objective')).toBeFocused();
});

test('emptying a column hands focus to its empty state', async ({ page }) => {
  await openSeededBoard(page);

  await deleteButton(page, 'Solo resolved').focus();
  await page.keyboard.press('Enter');

  await expect(
    page.getByRole('listitem').filter({ hasText: 'Solo resolved' }),
  ).toHaveCount(0);
  const emptyState = page.getByTestId('empty-column-done');
  await expect(emptyState).toBeVisible();
  await expect(emptyState).toBeFocused();
});
