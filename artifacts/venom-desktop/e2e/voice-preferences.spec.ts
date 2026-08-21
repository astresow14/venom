import { expect, test, type Page } from '@playwright/test';
import { stubWorkspaceApis } from './support/stubs';

/**
 * Voice preferences on desktop.
 *
 * Voice mode runs on the phone, but its two synced preferences — the speaking
 * voice and the chatty ↔ reserved talkativeness dial — are workspace state,
 * so desktop must let the user set them and must carry the choice through the
 * normal save path. The UI-test harness runs signed-out with cloud sync
 * disabled; the workspace provider mirrors every state change into the same
 * user-scoped local snapshot a signed-in reload hydrates from, so persistence
 * across a reload proves the write went through the real save path (normalize
 * + fresh updatedAt), not component state.
 */

const DESKTOP = { width: 1280, height: 860 };
test.use({ viewport: DESKTOP });

const UI_TEST_STORAGE_KEY = '@venom_desktop_v1:venom-desktop-ui-test';

async function openWorkspace(page: Page) {
  await stubWorkspaceApis(page);
  await page.goto('/workspace/chat');
  await expect(page.getByTestId('form-composer')).toBeVisible();
}

async function openVoicePreferences(page: Page) {
  await page.getByTestId('button-voice-preferences-desktop').click();
  await expect(page.getByTestId('dialog-voice-preferences')).toBeVisible();
}

test('the talkativeness dial sits with the voice picker and explains each level', async ({
  page,
}) => {
  await openWorkspace(page);
  await openVoicePreferences(page);

  // Both synced preferences share one surface: the voice picker and the
  // talkativeness dial, with defaults selected.
  await expect(page.getByTestId('voice-preset-sam')).toHaveAttribute(
    'aria-checked',
    'true',
  );
  await expect(page.getByTestId('voice-talkativeness-balanced')).toHaveAttribute(
    'aria-checked',
    'true',
  );
  await expect(page.getByTestId('voice-talkativeness-description')).toHaveText(
    'Answers real questions, lets throwaway remarks pass quietly.',
  );

  // Switching levels re-explains the dial in plain language immediately.
  await page.getByTestId('voice-talkativeness-reserved').click();
  await expect(page.getByTestId('voice-talkativeness-description')).toHaveText(
    'Speaks when spoken to. Asides and musings are left alone.',
  );
  await page.getByTestId('voice-talkativeness-chatty').click();
  await expect(page.getByTestId('voice-talkativeness-description')).toHaveText(
    'Answers almost everything — even a stray “okay” gets a nod.',
  );
});

test('a choice made on desktop rides the workspace save path and survives a reload', async ({
  page,
}) => {
  await openWorkspace(page);
  await openVoicePreferences(page);

  await page.getByTestId('voice-talkativeness-reserved').click();
  await page.getByTestId('voice-preset-maya').click();
  await expect(page.getByTestId('voice-preset-maya')).toHaveAttribute(
    'aria-checked',
    'true',
  );

  // The saved snapshot carries the same synced block the phone merges on,
  // stamped with a fresh clock so this device wins the cross-device merge.
  await expect(async () => {
    const saved = await page.evaluate(
      (key) => {
        const raw = localStorage.getItem(key);
        return raw
          ? (JSON.parse(raw) as {
              voicePreferences?: {
                presetId?: string;
                talkativeness?: string;
                updatedAt?: number;
              };
            }).voicePreferences ?? null
          : null;
      },
      UI_TEST_STORAGE_KEY,
    );
    expect(saved?.presetId).toBe('maya');
    expect(saved?.talkativeness).toBe('reserved');
    expect(saved?.updatedAt ?? 0).toBeGreaterThan(0);
  }).toPass();

  // A fresh page hydrates from the same snapshot a signed-in restore uses.
  await page.reload();
  await expect(page.getByTestId('form-composer')).toBeVisible();
  await openVoicePreferences(page);
  await expect(page.getByTestId('voice-talkativeness-reserved')).toHaveAttribute(
    'aria-checked',
    'true',
  );
  await expect(page.getByTestId('voice-preset-maya')).toHaveAttribute(
    'aria-checked',
    'true',
  );
});
