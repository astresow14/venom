import { expect, test, type Page } from '@playwright/test';
import { stubWorkspaceApis } from './support/stubs';

/**
 * The To-Do board is unified (Task #281): with no global scope switcher,
 * every project — personal or shared with a company — contributes its
 * to-dos to one board. The active project narrows the board; without one,
 * all projects aggregate and each card names its project.
 */

const STORAGE_KEY = '@venom_desktop_v1:venom-desktop-ui-test';
const NOW = 1_755_600_000_000; // fixed timestamp keeps the seed deterministic

function seededState({ activeProjectId }: { activeProjectId: string }) {
  return {
    projects: [
      {
        id: 'proj_home',
        name: 'Home Base',
        description: 'Personal project',
        accent: '#e5e5e5',
        sourceCount: 0,
        updatedAt: NOW - 1_000,
        tasks: [
          {
            id: 'task_home',
            title: 'Water the plants',
            status: 'todo',
            createdAt: NOW - 1_000,
          },
        ],
      },
      {
        id: 'proj_side',
        name: 'Side Quest',
        description: 'Second personal project',
        accent: '#e5e5e5',
        sourceCount: 0,
        updatedAt: NOW - 2_000,
        tasks: [
          {
            id: 'task_side',
            title: 'Sketch the zine',
            status: 'todo',
            createdAt: NOW - 2_000,
          },
        ],
      },
      {
        id: 'proj_org',
        name: 'Client Ops',
        description: 'Shared with the company',
        accent: '#e5e5e5',
        sourceCount: 0,
        updatedAt: NOW - 3_000,
        orgId: 'org_x',
        tasks: [
          {
            id: 'task_org',
            title: 'Ship client report',
            status: 'todo',
            createdAt: NOW - 3_000,
          },
        ],
      },
    ],
    conversations: [
      {
        id: 'conv_seed',
        title: 'Planning',
        projectId: 'proj_home',
        updatedAt: NOW - 1_000,
        messages: [],
      },
    ],
    clusters: [],
    sources: [],
    activeProjectId,
    activeConversationId: 'conv_seed',
  };
}

async function openSeededBoard(page: Page, state: unknown) {
  await stubWorkspaceApis(page);
  await page.addInitScript(
    ({ key, value }) => {
      if (!window.localStorage.getItem(key)) {
        window.localStorage.setItem(key, value);
      }
    },
    { key: STORAGE_KEY, value: JSON.stringify(state) },
  );
  await page.goto('/workspace/tasks');
  await expect(page.getByRole('heading', { name: 'To-Do' })).toBeVisible();
}

test('the active project narrows the board to its own to-dos', async ({
  page,
}) => {
  await openSeededBoard(page, seededState({ activeProjectId: 'proj_home' }));

  await expect(page.getByTestId('text-todo-scope')).toHaveText(
    'Project: Home Base',
  );
  await expect(page.getByText('Water the plants')).toBeVisible();
  await expect(page.getByText('Sketch the zine')).toHaveCount(0);
  await expect(page.getByText('Ship client report')).toHaveCount(0);

  // A single project on the board does not repeat its name on each card.
  await expect(page.getByTestId('text-task-meta-task_home')).not.toContainText(
    '·',
  );
});

test('without an active project every project contributes — company-shared included', async ({
  page,
}) => {
  // The seeded active project no longer exists: the board falls back to
  // aggregating everything, and the business project is a peer — there is
  // no Personal/business switcher hiding its to-dos anymore.
  await openSeededBoard(page, seededState({ activeProjectId: 'proj_gone' }));

  await expect(page.getByTestId('text-todo-scope')).toHaveText('All projects');
  await expect(page.getByText('Water the plants')).toBeVisible();
  await expect(page.getByText('Sketch the zine')).toBeVisible();
  await expect(page.getByText('Ship client report')).toBeVisible();

  // Several projects share the board, so each card names its project —
  // including the company-shared one.
  await expect(page.getByTestId('text-task-meta-task_home')).toContainText(
    'Home Base ·',
  );
  await expect(page.getByTestId('text-task-meta-task_side')).toContainText(
    'Side Quest ·',
  );
  await expect(page.getByTestId('text-task-meta-task_org')).toContainText(
    'Client Ops ·',
  );

  // The chat-space selector does not filter the cross-project board.
  await expect(page.getByTestId('select-shared-space-desktop')).toBeVisible();
});
