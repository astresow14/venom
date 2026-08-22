import { expect, test, type Page } from '@playwright/test';
import {
  mockChatFailure,
  mockChatStream,
  mockKnowledgeExtraction,
  mockStagedChatStream,
  STUB_MODEL,
} from './support/chat-stream';

const DESKTOP = { width: 1280, height: 860 };
const PHONE = { width: 390, height: 740 };

/** The e2e dev server serves the UI only, so the model list is stubbed. */
async function mockModels(page: Page) {
  await page.route('**/api/venom/models', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify([
        {
          id: 'gpt-5',
          provider: 'openai',
          name: 'Test Model',
          family: 'GPT',
          summary: 'Model used by browser tests.',
          available: true,
          availabilityText: 'Ready',
        },
      ]),
    });
  });
}

async function openChat(page: Page) {
  await mockModels(page);
  await page.goto('/workspace/chat');
  await expect(page.getByTestId('form-composer')).toBeVisible();
}

test.describe('wide screens', () => {
  test.use({ viewport: DESKTOP });

  test('shows a persistent sidebar with chat history, new chat, and project switching', async ({
    page,
  }) => {
    await openChat(page);

    const sidebar = page.getByTestId('sidebar-desktop');
    await expect(sidebar).toBeVisible();
    // The drawer trigger belongs to narrow screens only.
    await expect(page.getByTestId('button-open-navigation')).toBeHidden();

    await expect(sidebar.getByTestId('select-project-desktop')).toHaveValue(
      'proj_default',
    );
    await expect(page.getByTestId('text-chat-greeting')).toBeVisible();

    const conversations = sidebar.getByTestId(/^button-conversation-/);
    const initialCount = await conversations.count();
    expect(initialCount).toBeGreaterThan(0);

    await sidebar.getByTestId('button-new-chat-desktop').click();
    await expect(conversations).toHaveCount(initialCount + 1);

    // Selecting an older chat makes it the current one.
    const previous = conversations.nth(1);
    const previousName = (await previous.textContent())?.trim();
    await previous.click();
    await expect(previous).toHaveAttribute('aria-current', 'page');
    await expect(page.getByTestId('text-conversation-title')).toHaveText(
      previousName ?? '',
    );

    // Workspace destinations stay reachable without leaving the shell.
    await sidebar.getByTestId('link-nav-to-do').click();
    await expect(page).toHaveURL(/\/workspace\/tasks$/);
    await expect(sidebar).toBeVisible();
    await sidebar.getByTestId('link-nav-chat').click();
    await expect(page).toHaveURL(/\/workspace\/chat$/);
  });

  test('streams a reply, then surfaces an error with a working retry', async ({
    page,
  }) => {
    await mockChatStream(page, ['Hello ', 'from Venom.']);
    await openChat(page);

    const composer = page.getByTestId('input-message');

    // Shift+Enter inserts a newline instead of sending.
    await composer.click();
    await composer.type('line one');
    await composer.press('Shift+Enter');
    await composer.type('line two');
    await expect(composer).toHaveValue('line one\nline two');
    await composer.fill('');

    await composer.fill('What is next?');
    await composer.press('Enter');

    await expect(page.getByTestId('message-user')).toHaveText('What is next?');
    await expect(page.getByTestId('message-assistant')).toContainText(
      'Hello from Venom.',
    );
    await expect(composer).toHaveValue('');

    // Second turn fails: the inline error and retry must appear.
    await mockChatFailure(page);
    await composer.fill('And after that?');
    await composer.press('Enter');

    const error = page.getByTestId('alert-stream-error');
    await expect(error).toBeVisible();
    await expect(error).toContainText('The model is unavailable right now.');

    await mockChatStream(page, ['Recovered answer.']);
    await page.getByTestId('button-retry').click();
    await expect(page.getByTestId('alert-stream-error')).toHaveCount(0);
    await expect(page.getByTestId('message-assistant').last()).toContainText(
      'Recovered answer.',
    );
  });

  test('holds the mid-answer states while a reply arrives in stages', async ({
    page,
  }) => {
    await mockKnowledgeExtraction(page);
    await mockStagedChatStream(page, [
      [
        // Pre-token pause: long enough to assert the placeholder states.
        [700, { content: 'Streaming takes ' }],
        [250, { content: 'a moment ' }],
        [250, { content: 'to finish.' }],
        // Long tail before completion keeps the mid-stream window open.
        [900, STUB_MODEL],
        [100, { done: true }],
      ],
    ]);
    await openChat(page);

    const composer = page.getByTestId('input-message');
    const send = page.getByTestId('button-send');

    await composer.fill('Walk me through it slowly.');
    await composer.press('Enter');

    // Before the first token: a "Thinking…" placeholder, and a composer
    // that refuses further input until the reply lands.
    const thinking = page.getByTestId('status-thinking');
    await expect(thinking).toBeVisible();
    await expect(composer).toBeDisabled();
    await expect(send).toBeDisabled();

    // First tokens: the placeholder yields to text with a caret, and the
    // composer stays locked while the answer is still arriving.
    const reply = page.getByTestId('message-assistant');
    await expect(reply).toContainText('Streaming takes');
    await expect(thinking).toHaveCount(0);
    await expect(page.getByTestId('status-caret')).toBeVisible();
    await expect(composer).toBeDisabled();

    // Completion: the full answer, no caret, and the composer editable
    // again — typing re-arms the send button.
    await expect(reply).toContainText('Streaming takes a moment to finish.');
    await expect(page.getByTestId('status-caret')).toHaveCount(0);
    await expect(composer).toBeEnabled();
    await composer.fill('Follow-up question');
    await expect(send).toBeEnabled();
  });

  test('a stream that dies mid-answer surfaces the inline error, and retry does not keep the half reply', async ({
    page,
  }) => {
    await mockKnowledgeExtraction(page);
    await mockStagedChatStream(page, [
      [
        // The stream closes after a partial answer, without `{done: true}`.
        [200, { content: 'Half an answer that never' }],
      ],
      [
        [150, { content: 'Recovered after the stall.' }],
        [100, STUB_MODEL],
        [100, { done: true }],
      ],
    ]);
    await openChat(page);

    const composer = page.getByTestId('input-message');
    await composer.fill('Will this stall?');
    await composer.press('Enter');

    // The stalled turn surfaces the inline error alongside the partial
    // text instead of quietly saving half a reply.
    const error = page.getByTestId('alert-stream-error');
    await expect(error).toBeVisible();
    await expect(error).toContainText('ended before completion');
    await expect(page.getByTestId('message-assistant')).toContainText(
      'Half an answer',
    );

    // Retry replays the turn; the recovered answer replaces the fragment.
    await page.getByTestId('button-retry').click();
    await expect(page.getByTestId('alert-stream-error')).toHaveCount(0);
    const replies = page.getByTestId('message-assistant');
    await expect(replies).toHaveCount(1);
    await expect(replies).toContainText('Recovered after the stall.');
    await expect(replies).not.toContainText('Half an answer');
    await expect(composer).toBeEnabled();
  });

  test('starter prompts fill the composer and mention the project', async ({
    page,
  }) => {
    await openChat(page);

    const prompts = page.getByTestId('button-starter-prompt');
    await expect(prompts.first()).toBeVisible();
    await prompts.first().click();

    const composer = page.getByTestId('input-message');
    await expect(composer).not.toHaveValue('');
    await expect(composer).toBeFocused();
  });
});

test.describe('phone-sized screens', () => {
  test.use({ viewport: PHONE });

  test('uses a drawer that returns focus and keeps the composer reachable', async ({
    page,
  }) => {
    await openChat(page);

    await expect(page.getByTestId('sidebar-desktop')).toBeHidden();

    const trigger = page.getByTestId('button-open-navigation');
    await expect(trigger).toBeVisible();
    await trigger.click();

    const drawer = page.getByTestId('drawer-navigation');
    await expect(drawer).toBeVisible();
    await expect(drawer.getByTestId('button-new-chat-drawer')).toBeVisible();
    await expect(drawer.getByTestId('list-conversations-drawer')).toBeVisible();

    await page.keyboard.press('Escape');
    await expect(drawer).toBeHidden();
    await expect(trigger).toBeFocused();

    // Choosing a chat from the drawer closes it and stays on chat.
    await trigger.click();
    await drawer.getByTestId(/^button-conversation-/).first().click();
    await expect(drawer).toBeHidden();
    await expect(page).toHaveURL(/\/workspace\/chat$/);

    // Composer stays inside the viewport above the safe-area inset.
    const composerBox = await page.getByTestId('form-composer').boundingBox();
    expect(composerBox).not.toBeNull();
    if (composerBox) {
      expect(composerBox.y + composerBox.height).toBeLessThanOrEqual(
        PHONE.height,
      );
      expect(composerBox.y).toBeGreaterThan(0);
    }

    // The header stays clear of the top safe area and remains visible.
    const headerTitle = page.getByTestId('text-active-project');
    await expect(headerTitle).toBeVisible();
  });

  test('sends a message from the on-screen composer', async ({ page }) => {
    await mockChatStream(page, ['Mobile reply.']);
    await openChat(page);

    const composer = page.getByTestId('input-message');
    await composer.fill('Status update?');
    await page.getByTestId('button-send').click();

    await expect(page.getByTestId('message-assistant')).toContainText(
      'Mobile reply.',
    );
  });
});

test.describe('signed-out entry', () => {
  test.use({ viewport: DESKTOP });

  test('offers a chat-style gateway with sign-in and sign-up', async ({
    page,
  }) => {
    await page.goto('/');

    await expect(page.getByTestId('link-sign-in')).toBeVisible();
    await expect(page.getByTestId('link-sign-up')).toBeVisible();
    await expect(page.getByLabel('Ask Venom')).toBeVisible();

    await page.getByTestId('link-sign-in').click();
    await expect(page).toHaveURL(/\/sign-in$/);
    await expect(page.getByTestId('link-home')).toBeVisible();

    await page.getByTestId('link-home').click();
    await expect(page).toHaveURL(/\/$/);

    await page.getByTestId('link-sign-up').click();
    await expect(page).toHaveURL(/\/sign-up$/);
    await expect(page.getByTestId('link-home')).toBeVisible();
  });
});
