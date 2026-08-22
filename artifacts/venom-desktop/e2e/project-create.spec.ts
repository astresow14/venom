import { expect, test, type Page } from '@playwright/test';
import { stubWorkspaceApis } from './support/stubs';

/**
 * Creating projects from the desktop sidebar.
 *
 * The project switcher's plus control opens a small dialog. Creating mirrors
 * the phone's addProject semantics — fresh id, updatedAt stamp, default board
 * stages seeded under the new id — and switches straight into the new
 * project with no session selected, so the first message starts its first
 * chat.
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

const ONE_PROJECT = {
  projects: [project('proj_alpha', 'Alpha Ops', NOW - 5_000)],
  conversations: [
    conversation('conv_alpha', 'proj_alpha', 'Alpha planning', NOW - 5_000),
  ],
  clusters: [],
  sources: [],
  activeProjectId: 'proj_alpha',
  activeConversationId: 'conv_alpha',
};

async function seedWorkspace(page: Page, state: unknown) {
  await stubWorkspaceApis(page);
  // Seed only when the key is absent so a reload rehydrates whatever the app
  // persisted (creations included) instead of resetting to the fixture.
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

test('creating a project switches into it, ready for a first chat', async ({
  page,
}) => {
  await seedWorkspace(page, ONE_PROJECT);
  await page.goto('/workspace/chat');

  const select = page.getByTestId('select-project-desktop');
  await expect(select).toHaveValue('proj_alpha');

  await page.getByTestId('button-new-project-desktop').click();
  await page
    .getByTestId('input-new-project-name-desktop')
    .fill('Falcon Research');
  await page
    .getByTestId('input-new-project-description-desktop')
    .fill('Tracking the falcon rollout');
  await page.getByTestId('button-create-project-desktop').click();

  // The new project takes over the switcher…
  await expect(select.locator('option')).toHaveCount(2);
  await expect(select.locator('option:checked')).toHaveText('Falcon Research');

  // …with an empty chat surface: the old project's sessions stay behind.
  const list = page.getByTestId('list-conversations-desktop');
  await expect(list).toContainText('No chats yet');
  await expect(list).not.toContainText('Alpha planning');

  // Ready for a first chat: a new session opens under the new project.
  await page.getByTestId('button-new-chat-desktop').click();
  await expect(list).toContainText('New Session');

  // The persisted mirror carries mobile's addProject semantics: fresh id,
  // updatedAt stamp, default board stages, empty fields and tasks.
  await expect
    .poll(async () => {
      const persisted = await readPersistedState(page);
      const created = persisted?.projects?.find(
        (entry: { name?: string }) => entry.name === 'Falcon Research',
      );
      return {
        projectCount: persisted?.projects?.length,
        freshId:
          Boolean(created?.id?.startsWith('proj_')) &&
          created?.id !== 'proj_alpha',
        active:
          Boolean(created?.id) && persisted?.activeProjectId === created?.id,
        description: created?.description,
        sourceCount: created?.sourceCount,
        stamped: typeof created?.updatedAt === 'number' && created.updatedAt > 0,
        stageNames: created?.boardStages?.map(
          (stage: { name: string }) => stage.name,
        ),
        stagesStamped: created?.boardStages?.every(
          (stage: { updatedAt: number }) =>
            stage.updatedAt === created?.updatedAt,
        ),
        fieldDefinitions: created?.fieldDefinitions,
        tasks: created?.tasks,
      };
    })
    .toEqual({
      projectCount: 2,
      freshId: true,
      active: true,
      description: 'Tracking the falcon rollout',
      sourceCount: 0,
      stamped: true,
      stageNames: ['To Do', 'Active', 'Done'],
      stagesStamped: true,
      fieldDefinitions: [],
      tasks: [],
    });

  // The creation survives a reload: the app still lands in the new project.
  await page.reload();
  await expect(
    page.getByTestId('select-project-desktop').locator('option:checked'),
  ).toHaveText('Falcon Research');
  await expect(page.getByTestId('list-conversations-desktop')).toContainText(
    'New Session',
  );
});

test('the dialog requires a name, resets on cancel, and defaults the description', async ({
  page,
}) => {
  await seedWorkspace(page, ONE_PROJECT);
  await page.goto('/workspace/chat');

  await page.getByTestId('button-new-project-desktop').click();
  const createButton = page.getByTestId('button-create-project-desktop');
  await expect(createButton).toBeDisabled();

  // A whitespace-only name is still no name.
  await page.getByTestId('input-new-project-name-desktop').fill('   ');
  await expect(createButton).toBeDisabled();

  // Backing out creates nothing and clears the draft. Wait for the dialog to
  // finish its exit animation before reopening: clicking the trigger while
  // the closing overlay is still mounted is swallowed by the dismiss layer.
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  const select = page.getByTestId('select-project-desktop');
  await expect(select).toHaveValue('proj_alpha');
  await expect(select.locator('option')).toHaveCount(1);

  await page.getByTestId('button-new-project-desktop').click();
  const nameInput = page.getByTestId('input-new-project-name-desktop');
  await expect(nameInput).toHaveValue('');

  // Creating with a name only falls back to mobile's default description.
  await nameInput.fill('Skunkworks');
  await page.getByTestId('button-create-project-desktop').click();
  await expect(select.locator('option')).toHaveCount(2);
  await expect(select.locator('option:checked')).toHaveText('Skunkworks');

  await expect
    .poll(async () => {
      const persisted = await readPersistedState(page);
      const created = persisted?.projects?.find(
        (entry: { name?: string }) => entry.name === 'Skunkworks',
      );
      return {
        description: created?.description,
        active:
          Boolean(created?.id) && persisted?.activeProjectId === created?.id,
      };
    })
    .toEqual({ description: 'Project workspace', active: true });
});
