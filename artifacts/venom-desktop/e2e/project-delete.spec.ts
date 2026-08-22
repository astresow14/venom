import { expect, test, type Page } from '@playwright/test';
import { stubWorkspaceApis } from './support/stubs';

/**
 * Deleting projects from the desktop sidebar.
 *
 * The project switcher's trash control removes the selected project after an
 * explicit confirmation, following the phone's rules: land on the most
 * recently updated remaining project, seed a fresh fallback workspace when
 * the last project goes, and persist the same tombstones so the deletion
 * propagates across devices instead of resurrecting on merge.
 */

const STORAGE_KEY = '@venom_desktop_v1:venom-desktop-ui-test';
const NOW = 1_755_600_000_000; // fixed timestamp keeps the seed deterministic

function project(id: string, name: string, updatedAt: number) {
  return {
    id,
    name,
    description: 'Browser-test project',
    accent: '#e5e5e5',
    sourceCount: 0,
    updatedAt,
  };
}

function conversation(
  id: string,
  projectId: string,
  title: string,
  updatedAt: number,
) {
  return {
    id,
    title,
    projectId,
    updatedAt,
    messages: [
      {
        id: `msg_${id}`,
        role: 'user',
        content: `${title} kickoff`,
        createdAt: updatedAt,
        status: 'sent',
      },
    ],
  };
}

// Alpha is active; beta is the most recently updated of the others.
const THREE_PROJECTS = {
  projects: [
    project('proj_alpha', 'Alpha Ops', NOW - 5_000),
    project('proj_beta', 'Beta Lab', NOW - 2_000),
    project('proj_gamma', 'Gamma Field', NOW - 3_000),
  ],
  conversations: [
    conversation('conv_alpha', 'proj_alpha', 'Alpha planning', NOW - 5_000),
    conversation('conv_beta', 'proj_beta', 'Beta review', NOW - 2_000),
    conversation('conv_gamma', 'proj_gamma', 'Gamma retro', NOW - 3_000),
  ],
  clusters: [],
  sources: [],
  activeProjectId: 'proj_alpha',
  activeConversationId: 'conv_alpha',
};

const LAST_PROJECT = {
  projects: [project('proj_solo', 'Solo Desk', NOW - 1_000)],
  conversations: [
    conversation('conv_solo', 'proj_solo', 'Solo notes', NOW - 1_000),
  ],
  clusters: [],
  sources: [],
  activeProjectId: 'proj_solo',
  activeConversationId: 'conv_solo',
};

async function seedWorkspace(page: Page, state: unknown) {
  await stubWorkspaceApis(page);
  // Seed only when the key is absent so a reload rehydrates whatever the app
  // persisted (deletions included) instead of resetting to the fixture.
  await page.addInitScript(
    ({ key, value }) => {
      if (!window.localStorage.getItem(key)) {
        window.localStorage.setItem(key, value);
      }
    },
    { key: STORAGE_KEY, value: JSON.stringify(state) },
  );
}

function readPersistedState(page: Page) {
  return page.evaluate(
    (key) => JSON.parse(window.localStorage.getItem(key) ?? 'null'),
    STORAGE_KEY,
  );
}

test('deleting the active project lands on the most recently updated remaining project', async ({
  page,
}) => {
  await seedWorkspace(page, THREE_PROJECTS);
  await page.goto('/workspace/chat');

  const select = page.getByTestId('select-project-desktop');
  await expect(select).toHaveValue('proj_alpha');

  await page.getByTestId('button-delete-project-desktop').click();
  const dialog = page.getByRole('alertdialog');
  await expect(dialog).toContainText('Alpha Ops');
  await page.getByTestId('button-confirm-delete-project-desktop').click();

  // Beta is the most recently updated remaining project, so it takes over.
  await expect(select).toHaveValue('proj_beta');
  await expect(select.locator('option')).toHaveCount(2);
  const list = page.getByTestId('list-conversations-desktop');
  await expect(list).toContainText('Beta review');
  await expect(list).not.toContainText('Alpha planning');

  // The persisted mirror carries the tombstones that stop resurrection.
  await expect
    .poll(async () => {
      const persisted = await readPersistedState(page);
      return {
        projects: persisted?.projects
          ?.map((entry: { id: string }) => entry.id)
          .sort(),
        projectTombstone: persisted?.tombstones?.projects?.some(
          (marker: { id: string; deletedAt: number }) =>
            marker.id === 'proj_alpha' && marker.deletedAt > 0,
        ),
        conversationTombstone: persisted?.tombstones?.conversations?.some(
          (marker: { id: string }) => marker.id === 'conv_alpha',
        ),
        messageTombstone: persisted?.tombstones?.messages?.some(
          (marker: { id: string }) => marker.id === 'msg_conv_alpha',
        ),
      };
    })
    .toEqual({
      projects: ['proj_beta', 'proj_gamma'],
      projectTombstone: true,
      conversationTombstone: true,
      messageTombstone: true,
    });

  // The deletion survives a reload: nothing rehydrates the deleted project.
  await page.reload();
  await expect(page.getByTestId('select-project-desktop')).toHaveValue(
    'proj_beta',
  );
  await expect(
    page.getByTestId('select-project-desktop').locator('option'),
  ).toHaveCount(2);
});

test('undo inside the toast window brings the project back under a fresh id', async ({
  page,
}) => {
  await seedWorkspace(page, THREE_PROJECTS);
  await page.goto('/workspace/chat');

  const select = page.getByTestId('select-project-desktop');
  await expect(select).toHaveValue('proj_alpha');

  await page.getByTestId('button-delete-project-desktop').click();
  // The confirmation itself promises the undo beat.
  await expect(page.getByRole('alertdialog')).toContainText(
    /a few seconds to undo/i,
  );
  await page.getByTestId('button-confirm-delete-project-desktop').click();

  // The delete really commits before any undo: beta takes over immediately.
  await expect(select).toHaveValue('proj_beta');

  await page.getByTestId('button-undo-delete-project').click();
  // Exact match: the aria-live announcer also repeats the toast title.
  await expect(page.getByText('Project restored', { exact: true })).toBeVisible();

  // The restored copy is active again with its chats back…
  await expect(select.locator('option')).toHaveCount(3);
  await expect(select.locator('option:checked')).toHaveText('Alpha Ops');
  await expect(page.getByTestId('list-conversations-desktop')).toContainText(
    'Alpha planning',
  );

  // …but under a fresh id: the tombstoned ids stay dead, so synced devices
  // drop the old copy while the restored one arrives as ordinary new work.
  await expect
    .poll(async () => {
      const persisted = await readPersistedState(page);
      const restored = persisted?.projects?.find(
        (entry: { id: string; name: string }) => entry.name === 'Alpha Ops',
      );
      return {
        projectCount: persisted?.projects?.length,
        restoredUnderFreshId: Boolean(restored?.id) && restored.id !== 'proj_alpha',
        activeIsRestored:
          Boolean(restored?.id) && persisted?.activeProjectId === restored.id,
        projectTombstoneIntact: persisted?.tombstones?.projects?.some(
          (marker: { id: string }) => marker.id === 'proj_alpha',
        ),
        conversationTombstoneIntact: persisted?.tombstones?.conversations?.some(
          (marker: { id: string }) => marker.id === 'conv_alpha',
        ),
        restoredConversationIsFresh:
          persisted?.conversations?.some(
            (entry: { id: string; projectId: string | null }) =>
              entry.projectId === restored?.id && entry.id !== 'conv_alpha',
          ) &&
          !persisted?.conversations?.some(
            (entry: { id: string }) => entry.id === 'conv_alpha',
          ),
      };
    })
    .toEqual({
      projectCount: 3,
      restoredUnderFreshId: true,
      activeIsRestored: true,
      projectTombstoneIntact: true,
      conversationTombstoneIntact: true,
      restoredConversationIsFresh: true,
    });

  // The restore is persisted state, not toast-deep UI: it survives a reload.
  await page.reload();
  await expect(
    page.getByTestId('select-project-desktop').locator('option'),
  ).toHaveCount(3);
  await expect(
    page.getByTestId('select-project-desktop').locator('option:checked'),
  ).toHaveText('Alpha Ops');
  await expect(page.getByTestId('list-conversations-desktop')).toContainText(
    'Alpha planning',
  );
});

test('cancelling the confirmation keeps the project', async ({ page }) => {
  await seedWorkspace(page, THREE_PROJECTS);
  await page.goto('/workspace/chat');

  await page.getByTestId('button-delete-project-desktop').click();
  await page.getByRole('button', { name: 'Cancel' }).click();

  const select = page.getByTestId('select-project-desktop');
  await expect(select).toHaveValue('proj_alpha');
  await expect(select.locator('option')).toHaveCount(3);
});

test('deleting the last project leaves a usable fresh workspace', async ({
  page,
}) => {
  await seedWorkspace(page, LAST_PROJECT);
  await page.goto('/workspace/chat');

  await page.getByTestId('button-delete-project-desktop').click();
  await page.getByTestId('button-confirm-delete-project-desktop').click();

  const select = page.getByTestId('select-project-desktop');
  await expect(select.locator('option')).toHaveCount(1);
  await expect(select.locator('option')).toHaveText('General');
  expect(await select.inputValue()).not.toBe('proj_solo');

  // The fallback workspace is immediately usable: a new chat opens in it.
  await page.getByTestId('button-new-chat-desktop').click();
  await expect(page.getByTestId('list-conversations-desktop')).toContainText(
    'New Session',
  );

  await expect
    .poll(async () => {
      const persisted = await readPersistedState(page);
      const fallback = persisted?.projects?.[0];
      return {
        count: persisted?.projects?.length,
        name: fallback?.name,
        freshId: Boolean(fallback?.id) && fallback.id !== 'proj_solo',
        tombstoned: persisted?.tombstones?.projects?.some(
          (marker: { id: string }) => marker.id === 'proj_solo',
        ),
      };
    })
    .toEqual({
      count: 1,
      name: 'General',
      freshId: true,
      tombstoned: true,
    });
});
