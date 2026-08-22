import { expect, test } from '@playwright/test';
import {
  mockChatStream,
  mockKnowledgeExtraction,
} from './support/chat-stream';
import { stubWorkspaceApis } from './support/stubs';

/**
 * Chat sessions follow the selected project.
 *
 * A session records the project it was written in, and a session with no
 * project belongs to no project. Switching projects must therefore move the
 * chat: the picked project's own latest session reopens, a project that has
 * never been chatted in starts empty, and a project-less session is never
 * adopted. The message sent after a switch has to be filed under the project
 * on screen — the regression this guards against filed it under no project,
 * where it never showed up in the project's history and survived deleting
 * the project.
 *
 * The workspace is seeded through the same local mirror a signed-in account
 * keeps (`readLocalState`), which UI-test mode reads at startup, and filing
 * is asserted against that mirror after the turn completes.
 */

const STORAGE_KEY = '@venom_desktop_v1:venom-desktop-ui-test';
const NOW = 1_755_600_000_000; // fixed timestamp keeps the seed deterministic

const ALPHA_QUESTION = 'Where did the alpha survey land?';
const ORPHAN_NOTE = 'Loose thought with no project';

/** Two projects, one project-less session (the newest), Alpha on screen. */
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
          content: ALPHA_QUESTION,
          createdAt: NOW - 7_200_000,
          status: 'sent',
        },
        {
          id: 'msg_alpha_a',
          role: 'assistant',
          content: 'North ridge, past the relay.',
          createdAt: NOW - 7_100_000,
          status: 'sent',
        },
      ],
    },
    {
      // The newest session of all, belonging to no project. Before the fix it
      // was listed under every project and adopted on every switch.
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
  activeConversationId: 'conv_orphan',
};

test.beforeEach(async ({ page }) => {
  await stubWorkspaceApis(page);
  await page.addInitScript(
    ({ key, value }) => window.localStorage.setItem(key, value),
    { key: STORAGE_KEY, value: JSON.stringify(WORKSPACE_STATE) },
  );
});

test('switching projects never adopts a project-less session and files the message under the project on screen', async ({
  page,
}) => {
  await mockChatStream(page, ['Copy. ', 'Beacon is up.']);
  await mockKnowledgeExtraction(page);

  await page.goto('/workspace/chat');

  const sidebar = page.getByTestId('sidebar-desktop');
  const select = sidebar.getByTestId('select-project-desktop');
  await expect(select).toHaveValue('proj_alpha');

  // The chat list is the project's own history: the project-less session is
  // not listed under Aurora Systems.
  await expect(
    sidebar.getByTestId('button-conversation-conv_alpha'),
  ).toBeVisible();
  await expect(
    sidebar.getByTestId('button-conversation-conv_orphan'),
  ).toHaveCount(0);

  // Beacon Ops has never been chatted in: switching there starts empty
  // instead of adopting the newer project-less session.
  await select.selectOption('proj_beta');
  await expect(page.getByTestId('text-chat-greeting')).toBeVisible();
  await expect(page.getByTestId('message-user')).toHaveCount(0);
  await expect(sidebar.getByTestId('list-conversations-desktop')).toContainText(
    'No chats yet',
  );

  // The first message opens a session under the project on screen.
  const question = 'Beacon uplink check';
  await page.getByTestId('input-message').fill(question);
  await page.getByTestId('button-send').click();

  await expect(page.getByTestId('message-user')).toHaveText(question);
  await expect(page.getByTestId('message-assistant')).toContainText(
    'Copy. Beacon is up.',
  );

  // Where it was filed: under Beacon Ops, in a fresh session that is now the
  // active one. The project-less session is untouched and still project-less.
  await expect
    .poll(async () =>
      page.evaluate(
        ({ key, sent }) => {
          const raw = window.localStorage.getItem(key);
          if (!raw) return null;
          const state = JSON.parse(raw) as {
            activeConversationId: string | null;
            conversations: Array<{
              id: string;
              projectId: string | null;
              messages: Array<{ content: string }>;
            }>;
          };
          const filed = state.conversations.find((conversation) =>
            conversation.messages.some((message) => message.content === sent),
          );
          const orphan = state.conversations.find(
            (conversation) => conversation.id === 'conv_orphan',
          );
          return {
            filedProject: filed?.projectId ?? null,
            filedIsFreshSession: Boolean(filed) && filed?.id !== 'conv_orphan',
            activeMatchesFiled: state.activeConversationId === filed?.id,
            // `null` is the legitimate value here — it proves the session was
            // not adopted by the project it was sent from.
            orphanProject: orphan ? orphan.projectId : 'missing',
            orphanMessageCount: orphan?.messages.length ?? -1,
          };
        },
        { key: STORAGE_KEY, sent: question },
      ),
    )
    .toEqual({
      filedProject: 'proj_beta',
      filedIsFreshSession: true,
      activeMatchesFiled: true,
      orphanProject: null,
      orphanMessageCount: 1,
    });

  // Switching back to Aurora Systems reopens the chat written in it — not the
  // newer sessions that belong elsewhere.
  await select.selectOption('proj_alpha');
  await expect(page.getByTestId('text-conversation-title')).toHaveText(
    'Alpha planning',
  );
  await expect(page.getByTestId('message-user')).toHaveText(ALPHA_QUESTION);

  // And Beacon Ops still shows the message that was just written in it.
  await select.selectOption('proj_beta');
  await expect(page.getByTestId('message-user')).toHaveText(question);
});

test('a restored project-less session is not written into while a project is on screen', async ({
  page,
}) => {
  await mockChatStream(page, ['Filed under Aurora.']);
  await mockKnowledgeExtraction(page);

  // The seed restores a mismatched pair: Aurora Systems is on screen while
  // the active session belongs to no project (a state a synced snapshot can
  // legitimately land in).
  await page.goto('/workspace/chat');
  await expect(page.getByTestId('message-user')).toHaveText(ORPHAN_NOTE);

  const question = 'File this under alpha';
  await page.getByTestId('input-message').fill(question);
  await page.getByTestId('button-send').click();

  // Sending opens a fresh session for the on-screen project instead of
  // appending to the mismatched one, and the thread on screen is that new
  // session.
  await expect(page.getByTestId('message-user')).toHaveText(question);
  await expect(page.getByTestId('message-assistant')).toContainText(
    'Filed under Aurora.',
  );

  await expect
    .poll(async () =>
      page.evaluate(
        ({ key, sent }) => {
          const raw = window.localStorage.getItem(key);
          if (!raw) return null;
          const state = JSON.parse(raw) as {
            conversations: Array<{
              id: string;
              projectId: string | null;
              messages: Array<{ content: string }>;
            }>;
          };
          const filed = state.conversations.find((conversation) =>
            conversation.messages.some((message) => message.content === sent),
          );
          const orphan = state.conversations.find(
            (conversation) => conversation.id === 'conv_orphan',
          );
          const alphaSeed = state.conversations.find(
            (conversation) => conversation.id === 'conv_alpha',
          );
          return {
            filedProject: filed?.projectId ?? null,
            filedIsFreshSession:
              Boolean(filed) &&
              filed?.id !== 'conv_orphan' &&
              filed?.id !== 'conv_alpha',
            orphanMessageCount: orphan?.messages.length ?? -1,
            alphaSeedMessageCount: alphaSeed?.messages.length ?? -1,
          };
        },
        { key: STORAGE_KEY, sent: question },
      ),
    )
    .toEqual({
      filedProject: 'proj_alpha',
      filedIsFreshSession: true,
      orphanMessageCount: 1,
      alphaSeedMessageCount: 2,
    });
});
