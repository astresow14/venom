import { expect, test, type Page } from '@playwright/test';
import {
  mockChatStream,
  mockKnowledgeExtraction,
  STUB_MODEL,
} from './support/chat-stream';
import { stubWorkspaceApis } from './support/stubs';

/**
 * Core workspace regression for Venom Desktop.
 *
 * Covers the chat-first shell (persistent sidebar on wide screens, the drawer
 * on phones, sync status, thread list), the task board, and a full chat turn
 * against a stubbed model, which together are the flow every desktop session
 * goes through. Streaming edge cases (retry, composer keys) live in
 * chat-shell.spec.ts.
 *
 * Responsive layout, safe areas, and focus management live in
 * responsive-shell.spec.ts.
 */

test.beforeEach(async ({ page }) => {
  await stubWorkspaceApis(page);
});


/** A single readable record, used to prove the page recovers. */
const PORTFOLIO_APP = {
  id: '3f1d5a1c-7c2a-4c9e-9f2b-0f1a2b3c4d5e',
  name: 'Symbiote Desktop',
  purpose: 'Track the desktop source history.',
  brand: 'Venom',
  status: 'ready',
  detectedStack: ['react'],
  sourceType: 'zip',
  sourceVersion: 2,
  deploymentUrl: null,
  importStatus: null,
  sourceUpdatedAt: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-02T00:00:00.000Z',
};

const PHONE = { width: 390, height: 740 };
async function openDrawer(page: Page) {
  await page.getByRole('button', { name: 'Open navigation' }).click();
  const drawer = page.getByRole('dialog', { name: 'Navigation' });
  await expect(drawer).toBeVisible();
  return drawer;
}

const sections: { link: string; assert: (page: Page) => Promise<void> }[] = [
  {
    link: 'Feed',
    assert: async (page) => {
      await expect(page).toHaveURL(/\/workspace\/feed$/);
      await expect(
        page.getByRole('heading', { name: 'Community Briefing' }),
      ).toBeVisible();
      await expect(page.getByText('No threads found')).toBeVisible();
    },
  },
  {
    link: 'Brain',
    assert: async (page) => {
      await expect(page).toHaveURL(/\/workspace\/brain$/);
      await expect(
        page.getByRole('region', { name: /Knowledge map with \d+ nodes/ }),
      ).toBeVisible();
    },
  },
  {
    link: 'To-Do',
    assert: async (page) => {
      await expect(page).toHaveURL(/\/workspace\/tasks$/);
      await expect(
        page.getByRole('heading', { name: 'To-Do' }),
      ).toBeVisible();
    },
  },
  {
    link: 'Apps',
    assert: async (page) => {
      await expect(page).toHaveURL(/\/workspace\/apps$/);
      await expect(
        page.getByRole('heading', { name: 'Apps', exact: true }),
      ).toBeVisible();
      await expect(
        page.getByRole('heading', { name: 'No apps registered' }),
      ).toBeVisible();
    },
  },
  {
    link: 'Chat',
    assert: async (page) => {
      await expect(page).toHaveURL(/\/workspace\/chat$/);
      await expect(page.getByTestId('text-chat-greeting')).toBeVisible();
    },
  },
];

test('routes into chat and moves between sections from the sidebar', async ({
  page,
}) => {
  await page.goto('/workspace');

  await expect(page).toHaveURL(/\/workspace\/chat$/);
  await expect(page.getByTestId('text-chat-greeting')).toBeVisible();

  const sidebar = page.getByTestId('sidebar-desktop');
  await expect(sidebar).toBeVisible();
  await expect(sidebar.getByTestId('select-project-desktop')).toBeVisible();
  await expect(sidebar.getByTestId('status-sync-desktop')).toContainText(
    'Saved',
  );

  for (const section of sections) {
    await sidebar
      .getByRole('link', { name: section.link, exact: true })
      .click();
    await section.assert(page);
    // The sidebar is persistent on wide screens.
    await expect(sidebar).toBeVisible();
  }
});

test('moves between sections from the drawer on a phone', async ({ page }) => {
  await page.setViewportSize(PHONE);
  await page.goto('/workspace/chat');
  await expect(page.getByTestId('text-chat-greeting')).toBeVisible();
  await expect(page.getByTestId('sidebar-desktop')).toBeHidden();

  const header = page.getByRole('banner');
  await expect(header.getByTestId('text-active-project')).toHaveText(
    'Global Workspace',
  );

  for (const section of sections) {
    const drawer = await openDrawer(page);
    await drawer.getByRole('link', { name: section.link, exact: true }).click();
    await section.assert(page);
    // The drawer closes itself on navigation; the next iteration reopens it.
    await expect(page.getByRole('dialog', { name: 'Navigation' })).toBeHidden();
  }
});

test('keeps the Apps page readable when the portfolio comes back malformed', async ({
  page,
}) => {
  // An unavailable API, an error body, or an unauthenticated response all hand
  // the page something that is not a list. Registered after the beforeEach
  // stub, so this handler wins.
  let payload: unknown = { error: 'unauthorized' };
  await page.route('**/venom/apps', async (route) => {
    if (route.request().method() !== 'GET') {
      await route.fallback();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(payload),
    });
  });

  await page.goto('/workspace/apps');

  const failure = page.getByTestId('status-apps-error');
  await expect(failure).toBeVisible();
  await expect(failure).toContainText('Portfolio unavailable');
  // The route survives: the shell and the page header keep rendering, and the
  // error boundary's crash screen never takes over.
  await expect(
    page.getByRole('heading', { name: 'Apps', exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('heading', { name: 'Something went wrong' }),
  ).toHaveCount(0);

  // Recovery happens in place, without reloading the workspace.
  payload = [PORTFOLIO_APP];
  await page.getByTestId('button-retry-apps').click();

  await expect(page.getByTestId(`card-app-${PORTFOLIO_APP.id}`)).toBeVisible();
  await expect(failure).toHaveCount(0);
});

test('creates a task, advances it across the board, and deletes it', async ({
  page,
}) => {
  await page.goto('/workspace/tasks');

  await expect(page.getByRole('heading', { name: 'To-Do' })).toBeVisible();
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

test('answers a message from a stubbed model and keeps the thread after a reload', async ({
  page,
}) => {
  await mockChatStream(page, ['Deterministic ', 'stub reply.']);
  await mockKnowledgeExtraction(page);

  await page.goto('/workspace/chat');
  await expect(page.getByTestId('text-chat-greeting')).toBeVisible();

  const question = 'What shipped this week?';
  const composer = page.getByTestId('input-message');
  await composer.fill(question);
  await page.getByTestId('button-send').click();

  await expect(page.getByTestId('message-user')).toHaveText(question);

  // Every streamed chunk is joined into one reply, attributed to the model
  // the server named.
  const assistant = page.getByTestId('message-assistant');
  await expect(assistant).toContainText('Deterministic stub reply.');
  await expect(assistant).toContainText(STUB_MODEL.modelName);
  await expect(page.getByTestId('status-thinking')).toHaveCount(0);
  await expect(page.getByTestId('alert-stream-error')).toHaveCount(0);

  // The composer clears and re-enables for the next turn, and the thread takes
  // its title from the question.
  await expect(composer).toHaveValue('');
  await expect(composer).toBeEnabled();
  await expect(page.getByTestId('text-conversation-title')).toHaveText(question);

  await page.reload();

  await expect(page.getByTestId('message-user')).toHaveText(question);
  await expect(page.getByTestId('message-assistant')).toContainText(
    'Deterministic stub reply.',
  );
  await expect(page.getByTestId('text-conversation-title')).toHaveText(question);

  // The reloaded session reopens on that same thread.
  const sidebar = page.getByTestId('sidebar-desktop');
  await expect(
    sidebar.getByTestId(/^button-conversation-/).filter({ hasText: question }),
  ).toHaveAttribute('aria-current', 'page');
});

test('starts a new thread from the sidebar and keeps it in the history', async ({
  page,
}) => {
  await page.goto('/workspace/chat');
  await expect(page.getByTestId('text-chat-greeting')).toBeVisible();

  const sidebar = page.getByTestId('sidebar-desktop');
  const threads = sidebar.getByTestId(/^button-conversation-/);
  await expect(threads).toHaveCount(1);

  await sidebar.getByTestId('button-new-chat-desktop').click();

  await expect(page).toHaveURL(/\/workspace\/chat$/);
  await expect(page.getByTestId('text-chat-greeting')).toBeVisible();
  await expect(threads).toHaveCount(2);
  // The freshly created thread is the selected one.
  await expect(sidebar.locator('button[aria-current="page"]')).toHaveCount(1);
  await expect(threads.first()).toHaveAttribute('aria-current', 'page');
});
