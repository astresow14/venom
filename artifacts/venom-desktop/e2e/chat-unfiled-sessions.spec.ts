import { expect, test } from '@playwright/test';
import { stubWorkspaceApis } from './support/stubs';

/**
 * A way back for sessions that belong to no project.
 *
 * The chat list is strictly the on-screen project's own history, and a
 * project-less session is never adopted by a project — which is correct, but
 * left sessions stranded with projectId null (old desktop behaviour, or a
 * restored/merged cloud snapshot) listed nowhere once any project exists.
 * The sidebar's Unfiled bucket lists them again: reopening one shows its
 * words without adopting it, and the explicit "file into project" action is
 * the only path that gives it a home. Filing rewrites projectId through the
 * same synced local mirror every other edit uses (`readLocalState`), with an
 * updatedAt bump so the cross-device merge keeps the new home.
 */

const STORAGE_KEY = '@venom_desktop_v1:venom-desktop-ui-test';
const NOW = 1_755_600_000_000; // fixed timestamp keeps the seed deterministic

const ORPHAN_NOTE = 'Loose thought with no project';

/** Two projects, one stranded project-less session, Alpha on screen. */
const WORKSPACE_STATE = {
  projects: [
    {
      id: 'proj_alpha',
      name: 'Aurora Systems',
      description: 'Active research workspace',
      accent: '#e5e5e5',
      sourceCount: 0,
      updatedAt: NOW,
    },
    {
      id: 'proj_beta',
      name: 'Beacon Ops',
      description: 'Field operations workspace',
      accent: '#e5e5e5',
      sourceCount: 0,
      updatedAt: NOW,
    },
  ],
  conversations: [
    {
      id: 'conv_alpha',
      title: 'Alpha planning',
      projectId: 'proj_alpha',
      updatedAt: NOW - 7_200_000,
      messages: [
        {
          id: 'msg_alpha_q',
          role: 'user',
          content: 'Where did the alpha survey land?',
          createdAt: NOW - 7_200_000,
          status: 'sent',
        },
      ],
    },
    {
      // Stranded by the old behaviour (or a restored snapshot): the newest
      // session of all, belonging to no project, and therefore absent from
      // every project's chat list.
      id: 'conv_orphan',
      title: 'Scratch notes',
      projectId: null,
      updatedAt: NOW,
      messages: [
        {
          id: 'msg_orphan',
          role: 'user',
          content: ORPHAN_NOTE,
          createdAt: NOW,
          status: 'sent',
        },
      ],
    },
  ],
  clusters: [],
  sources: [],
  activeProjectId: 'proj_alpha',
  activeConversationId: 'conv_alpha',
};

test.beforeEach(async ({ page }) => {
  await stubWorkspaceApis(page);
  await page.addInitScript(
    ({ key, value }) => window.localStorage.setItem(key, value),
    { key: STORAGE_KEY, value: JSON.stringify(WORKSPACE_STATE) },
  );
});

function readOrphanFiling(page: import('@playwright/test').Page) {
  return page.evaluate(
    ({ key, seededAt }) => {
      const raw = window.localStorage.getItem(key);
      if (!raw) return null;
      const state = JSON.parse(raw) as {
        activeProjectId: string | null;
        activeConversationId: string | null;
        conversations: Array<{
          id: string;
          projectId: string | null;
          updatedAt: number;
          messages: Array<{ id: string }>;
        }>;
      };
      const orphan = state.conversations.find(
        (conversation) => conversation.id === 'conv_orphan',
      );
      return {
        orphanProject: orphan ? orphan.projectId : 'missing',
        // Filing must move updatedAt forward or the cross-device merge
        // would let a stale stranded copy win the session back.
        orphanUpdatedAtBumped: (orphan?.updatedAt ?? 0) > seededAt,
        orphanMessageCount: orphan?.messages.length ?? -1,
        activeProjectId: state.activeProjectId,
        activeConversationId: state.activeConversationId,
      };
    },
    { key: STORAGE_KEY, seededAt: NOW },
  );
}

test('a stranded session is listed under Unfiled, reopens without being adopted, and filing moves it into the chosen project', async ({
  page,
}) => {
  await page.goto('/workspace/chat');

  const sidebar = page.getByTestId('sidebar-desktop');
  const select = sidebar.getByTestId('select-project-desktop');
  await expect(select).toHaveValue('proj_alpha');

  // The project's own history does not adopt the stranded session — it
  // appears in the Unfiled bucket instead, so it is reachable again.
  await expect(
    sidebar.getByTestId('button-conversation-conv_alpha'),
  ).toBeVisible();
  await expect(
    sidebar.getByTestId('button-conversation-conv_orphan'),
  ).toHaveCount(0);
  const unfiledSection = sidebar.getByTestId('section-unfiled-desktop');
  await expect(unfiledSection).toBeVisible();
  const unfiledRow = sidebar.getByTestId(
    'button-unfiled-conversation-conv_orphan',
  );
  await expect(unfiledRow).toHaveText('Scratch notes');

  // Reopening shows the stranded words but files nothing: the project on
  // screen stays selected and the session stays project-less.
  await unfiledRow.click();
  await expect(page.getByTestId('message-user')).toHaveText(ORPHAN_NOTE);
  await expect(select).toHaveValue('proj_alpha');
  await expect
    .poll(async () => (await readOrphanFiling(page))?.orphanProject)
    .toBeNull();

  // Filing is explicit: the row's file control discloses the project list.
  await sidebar.getByTestId('button-file-conversation-conv_orphan').click();
  await sidebar.getByTestId('button-file-into-proj_beta').click();

  // The workspace lands on the session in its new home: Beacon Ops is on
  // screen, the session is a regular entry in its history, the thread stays
  // open, and the Unfiled bucket has nothing left to show.
  await expect(select).toHaveValue('proj_beta');
  await expect(
    sidebar.getByTestId('button-conversation-conv_orphan'),
  ).toBeVisible();
  await expect(page.getByTestId('message-user')).toHaveText(ORPHAN_NOTE);
  await expect(unfiledSection).toHaveCount(0);

  // The synced mirror carries the filing the way every other edit is
  // carried, so the cross-device merge keeps it.
  await expect.poll(async () => readOrphanFiling(page)).toEqual({
    orphanProject: 'proj_beta',
    orphanUpdatedAtBumped: true,
    orphanMessageCount: 1,
    activeProjectId: 'proj_beta',
    activeConversationId: 'conv_orphan',
  });

  // Switching away and back: the filed session now belongs to Beacon Ops'
  // own history exactly like a chat written there.
  await select.selectOption('proj_alpha');
  await expect(page.getByTestId('text-conversation-title')).toHaveText(
    'Alpha planning',
  );
  await select.selectOption('proj_beta');
  await expect(page.getByTestId('message-user')).toHaveText(ORPHAN_NOTE);
});
