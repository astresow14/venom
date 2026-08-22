import { expect, test, type Page } from '@playwright/test';
import { mockChatStream, mockKnowledgeExtraction } from './support/chat-stream';

/**
 * The in-chat device-only notice.
 *
 * These specs opt into the workspace-sync test mode
 * (`?venomWorkspaceSyncTest=true`), where the provider runs its real
 * hydrate → debounce → save machinery against the workspace endpoint stubbed
 * below. That is what lets a browser test drive genuine failed saves and a
 * genuine recovery, instead of pinning the status like regular UI-test mode.
 */

const DESKTOP = { width: 1280, height: 860 };

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

type WorkspaceCloud = {
  /** Whether the next PUTs land or are rejected. */
  mode: 'ok' | 'fail';
  /** Milliseconds a failing PUT stays in flight before it is rejected. */
  failDelayMs: number;
  /** Save attempts observed, landed or not. */
  puts: number;
  /** The workspace state carried by the last save that landed. */
  lastSavedState: unknown;
};

/**
 * A scriptable stand-in for the workspace cloud. GET answers with an empty
 * snapshot so the provider seeds from its local default state and uploads it;
 * PUT records every save attempt and either lands it or rejects it with a
 * server error depending on `mode`.
 */
async function stubWorkspaceCloud(page: Page): Promise<WorkspaceCloud> {
  const cloud: WorkspaceCloud = {
    mode: 'ok',
    failDelayMs: 0,
    puts: 0,
    lastSavedState: null,
  };
  let revision = 0;

  await page.route('**/api/venom/workspace', async (route) => {
    const method = route.request().method();
    if (method === 'GET') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          state: null,
          revision,
          updatedAt: new Date().toISOString(),
        }),
      });
      return;
    }
    if (method !== 'PUT') {
      await route.fallback();
      return;
    }

    cloud.puts += 1;
    if (cloud.mode === 'fail') {
      if (cloud.failDelayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, cloud.failDelayMs));
      }
      await route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({ message: 'Cloud save rejected by the test.' }),
      });
      return;
    }

    revision += 1;
    cloud.lastSavedState =
      (route.request().postDataJSON() as { state?: unknown } | null)?.state ??
      null;
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        state: null,
        revision,
        updatedAt: new Date().toISOString(),
      }),
    });
  });

  return cloud;
}

async function sendChatMessage(page: Page, text: string) {
  await page.getByTestId('input-message').fill(text);
  await page.getByTestId('button-send').click();
  await expect(
    page.getByTestId('message-user').filter({ hasText: text }),
  ).toBeVisible();
  // The reply finishing is what queues this turn's final workspace write.
  await expect(page.getByTestId('message-assistant').last()).toContainText(
    'Recorded.',
  );
}

test.describe('device-only notice in chat', () => {
  test.use({ viewport: DESKTOP });

  test('appears while cloud saves keep failing and clears once a save lands', async ({
    page,
  }) => {
    const cloud = await stubWorkspaceCloud(page);
    await mockModels(page);
    await mockChatStream(page, ['Recorded.']);
    await mockKnowledgeExtraction(page);

    await page.goto('/workspace/chat?venomWorkspaceSyncTest=true');
    await expect(page.getByTestId('form-composer')).toBeVisible();

    const notice = page.getByTestId('chat-unsynced-notice');
    const status = page.getByTestId('status-sync-desktop');

    // Boot: the empty cloud gets seeded by an upload that lands.
    await expect(status).toContainText('Saved');
    await expect(notice).toHaveCount(0);
    const putsAfterBoot = cloud.puts;

    // A normal send against a healthy cloud passes through syncing and lands
    // without chat ever mentioning it.
    await sendChatMessage(page, 'Backed up question');
    await expect.poll(() => cloud.puts).toBeGreaterThan(putsAfterBoot);
    await expect(status).toContainText('Saved');
    await expect(notice).toHaveCount(0);

    // From here every save is rejected: the next message exists only on this
    // device, and chat has to say so in plain language instead of leaving the
    // hint buried in the sidebar.
    cloud.mode = 'fail';
    await sendChatMessage(page, 'Stranded question');
    await expect(status).toContainText('Sync failed');
    // The grace delay keeps the moment of failure itself quiet…
    await expect(notice).toHaveCount(0);
    // …but a failure that persists surfaces in chat.
    await expect(notice).toBeVisible({ timeout: 15_000 });
    await expect(notice).toContainText('on this device only');
    await expect(notice).toContainText('when the connection returns');

    // A retry that is itself still failing must not blink the notice off:
    // not while the save is in flight, and not after it fails again.
    cloud.failDelayMs = 1_500;
    await page.getByTestId('button-retry-sync-desktop').click();
    await expect(status).toContainText('Syncing');
    await expect(notice).toBeVisible();
    await expect(status).toContainText('Sync failed', { timeout: 10_000 });
    await expect(notice).toBeVisible();

    // The cloud recovers and the user retries: the save lands, carrying the
    // stranded message, and the notice clears on its own — that clearing is
    // the signal writers rely on.
    cloud.mode = 'ok';
    cloud.failDelayMs = 0;
    await page.getByTestId('button-retry-sync-desktop').click();
    await expect(status).toContainText('Saved', { timeout: 10_000 });
    await expect(notice).toHaveCount(0);
    expect(JSON.stringify(cloud.lastSavedState)).toContain('Stranded question');
  });
});
