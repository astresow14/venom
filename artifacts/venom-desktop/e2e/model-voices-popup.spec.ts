import { expect, test, type Page } from '@playwright/test';
import {
  capturedChatRequestBodies,
  mockKnowledgeExtraction,
  mockStagedChatStream,
} from './support/chat-stream';

const DESKTOP = { width: 1280, height: 860 };

/**
 * The combined models & voices popup: one dialog owns model management
 * (enable / set default / remove / use) and, in Verify, the per-voice model
 * pickers with the argue-itself rule enforced inline. The dev server has no
 * API behind it, so every endpoint is stubbed.
 */

const MODELS = [
  {
    id: 'venom-gpt',
    provider: 'openai',
    name: 'Venom GPT',
    family: 'GPT',
    summary: 'Model used by browser tests.',
    available: true,
    availabilityText: 'Ready',
    costTier: '$$$',
  },
  {
    id: 'venom-claude',
    provider: 'anthropic',
    name: 'Venom Claude',
    family: 'Claude',
    summary: 'Model used by browser tests.',
    available: true,
    availabilityText: 'Ready',
    costTier: '$$',
  },
  {
    id: 'venom-gemini',
    provider: 'gemini',
    name: 'Venom Gemini',
    family: 'Gemini',
    summary: 'Model used by browser tests.',
    available: true,
    availabilityText: 'Ready',
    costTier: '$',
  },
  {
    id: 'venom-grok',
    provider: 'openrouter',
    name: 'Venom Grok',
    family: 'Grok',
    summary: 'Model used by browser tests.',
    available: true,
    availabilityText: 'Ready',
    costTier: '$$',
  },
];

async function seedEnabledModels(
  page: Page,
  enabledModelIds: string[] = ['venom-gpt', 'venom-claude', 'venom-gemini'],
  { onlyIfAbsent = false } = {},
) {
  await page.addInitScript(
    ({ enabledIds, skipWhenPresent }: {
      enabledIds: string[];
      skipWhenPresent: boolean;
    }) => {
    // Init scripts re-run on every navigation; a reload test needs the
    // first-load seed to survive instead of being re-stamped.
    if (
      skipWhenPresent &&
      window.localStorage.getItem('@venom_desktop_v1:venom-desktop-ui-test')
    ) {
      return;
    }
    const now = Date.now();
    const state = {
      projects: [],
      conversations: [
        {
          id: 'conv_default',
          title: 'New Session',
          projectId: 'proj_default',
          updatedAt: now,
          messages: [],
        },
      ],
      clusters: [],
      sources: [],
      activeProjectId: 'proj_default',
      activeConversationId: 'conv_default',
      tombstones: {
        projects: [],
        tasks: [],
        conversations: [],
        messages: [],
        clusters: [],
      },
      modelPreferences: {
        enabledModelIds: enabledIds,
        defaultModelId: 'venom-gpt',
        activeModelId: 'venom-gpt',
        updatedAt: now,
      },
    };
    window.localStorage.setItem(
      '@venom_desktop_v1:venom-desktop-ui-test',
      JSON.stringify(state),
    );
    },
    { enabledIds: enabledModelIds, skipWhenPresent: onlyIfAbsent },
  );
}

async function mockModels(page: Page, models: unknown[] = MODELS) {
  await page.route('**/api/venom/models', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(models),
    });
  });
}

async function mockDeliberationAvailability(
  page: Page,
  distinctModels = true,
) {
  await page.route('**/api/venom/deliberation', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        available: true,
        mode: distinctModels ? 'multi-model' : 'personas',
        distinctModels,
        voices: [
          { voiceId: 'direct', name: 'First take', tagline: 'Head-on' },
          { voiceId: 'skeptic', name: 'Skeptic', tagline: 'Risks' },
          { voiceId: 'evidence', name: 'Evidence', tagline: 'Sources' },
        ],
      }),
    });
  });
}

async function openChat(page: Page) {
  await page.goto('/workspace/chat');
  await expect(page.getByTestId('form-composer')).toBeVisible();
}

/** True when focus currently sits inside the models & voices dialog. */
async function focusInsideDialog(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const dialog = document.querySelector('[data-testid="dialog-model-voices"]');
    return Boolean(dialog && dialog.contains(document.activeElement));
  });
}

test.use({ viewport: DESKTOP });

test('one popup: every entry point opens it, voices get models, a self-argument is blocked, the request carries the picks', async ({
  page,
}) => {
  await seedEnabledModels(page);
  await mockModels(page);
  await mockDeliberationAvailability(page);
  await mockKnowledgeExtraction(page);
  await mockStagedChatStream(
    page,
    [
      [
        [
          0,
          {
            modelId: 'venom-gpt',
            modelName: 'Venom GPT',
            deliberation: {
              voices: [
                {
                  voiceId: 'direct',
                  name: 'First take',
                  modelId: 'venom-gpt',
                  modelName: 'Venom GPT',
                },
                {
                  voiceId: 'skeptic',
                  name: 'Skeptic',
                  modelId: 'venom-claude',
                  modelName: 'Venom Claude',
                },
                {
                  voiceId: 'evidence',
                  name: 'Evidence',
                  modelId: 'venom-gpt',
                  modelName: 'Venom GPT',
                },
              ],
            },
          },
        ],
        [150, { voice: 'direct', content: 'Plan looks sound.' }],
        [100, { voice: 'direct', voiceStatus: 'ok' }],
        [100, { voice: 'skeptic', content: 'Rollback path is untested.' }],
        [100, { voice: 'skeptic', voiceStatus: 'ok' }],
        [100, { voice: 'evidence', voiceStatus: 'ok' }],
        [100, { stage: 'synthesis' }],
        [150, { content: 'Collective: test the rollback first.' }],
        [
          100,
          {
            deliberation: {
              voices: [
                {
                  voiceId: 'direct',
                  name: 'First take',
                  modelId: 'venom-gpt',
                  modelName: 'Venom GPT',
                  content: 'Plan looks sound.',
                  status: 'ok',
                },
                {
                  voiceId: 'skeptic',
                  name: 'Skeptic',
                  modelId: 'venom-claude',
                  modelName: 'Venom Claude',
                  content: 'Rollback path is untested.',
                  status: 'ok',
                },
                {
                  voiceId: 'evidence',
                  name: 'Evidence',
                  modelId: 'venom-gpt',
                  modelName: 'Venom GPT',
                  content: '',
                  status: 'ok',
                },
              ],
              disagreements: [],
            },
          },
        ],
        [100, { done: true }],
      ],
    ],
    { captureRequestBodies: true },
  );
  await openChat(page);

  // Verify lives inside the popup now: open it from the Select-model chip —
  // the composer's only model entry point — and switch Verify on there.
  await page.getByTestId('button-model-chip').click();
  const dialog = page.getByTestId('dialog-model-voices');
  await expect(dialog).toBeVisible();
  expect(await focusInsideDialog(page)).toBe(true);
  // Model management lives in the same popup.
  await expect(page.getByTestId('model-card-venom-gpt')).toBeVisible();
  await page.getByTestId('switch-verify').click();
  await expect(page.getByTestId('switch-verify')).toHaveAttribute(
    'aria-checked',
    'true',
  );
  // Closing hands focus back to the chip that opened it.
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByTestId('button-model-chip')).toBeFocused();

  // Reopen: Verify stuck to the conversation, and the blend pad shows the
  // voice corners in the same popup.
  await page.getByTestId('button-model-chip').click();
  await expect(dialog).toBeVisible();
  await expect(page.getByTestId('switch-verify')).toHaveAttribute(
    'aria-checked',
    'true',
  );
  await expect(page.getByTestId('blend-pad')).toBeVisible();

  // Assign the Skeptic to another provider.
  await page.getByTestId('voice-pick-skeptic-venom-claude').click();
  await expect(
    page.getByTestId('voice-pick-skeptic-venom-claude'),
  ).toHaveAttribute('aria-pressed', 'true');
  // The pad reflects the pick under the Skeptic corner.
  await expect(page.getByTestId('blend-pad')).toContainText('Venom Claude');

  // Give First take an explicit model too.
  await page.getByTestId('voice-pick-direct-venom-gpt').click();
  await expect(
    page.getByTestId('voice-pick-direct-venom-gpt'),
  ).toHaveAttribute('aria-pressed', 'true');

  // A model can't argue itself: with First take on Venom GPT, the Skeptic's
  // Venom GPT option is blocked and the row says why in plain words.
  await expect(page.getByTestId('voice-pick-skeptic-venom-gpt')).toBeDisabled();
  await expect(page.getByTestId('voice-conflict-note-skeptic')).toContainText(
    "Venom GPT can't argue itself — pick a different model for Skeptic.",
  );
  // The rule cuts both ways: First take can't take the Skeptic's model.
  await expect(
    page.getByTestId('voice-pick-direct-venom-claude'),
  ).toBeDisabled();
  await expect(page.getByTestId('voice-conflict-note-direct')).toContainText(
    "Venom Claude can't argue itself — pick a different model for First take.",
  );

  // Evidence is neutral: it may reuse First take's model.
  const evidencePick = page.getByTestId('voice-pick-evidence-venom-gpt');
  await expect(evidencePick).toBeEnabled();
  await evidencePick.click();
  await expect(evidencePick).toHaveAttribute('aria-pressed', 'true');

  // Enabling a model in the management section immediately widens the
  // voice pickers.
  await expect(page.getByTestId('voice-pick-skeptic-venom-grok')).toHaveCount(0);
  await page
    .getByTestId('model-card-venom-grok')
    .getByRole('button', { name: 'Enable Venom Grok' })
    .click();
  await expect(page.getByTestId('voice-pick-skeptic-venom-grok')).toBeVisible();

  // Switch the active model from the same popup.
  await page.getByTestId('button-use-venom-claude').click();
  await page.getByTestId('button-model-voices-done').click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByTestId('text-active-model')).toContainText(
    'Venom Claude',
  );

  // Send a Verify message; the request carries the explicit picks.
  const composer = page.getByTestId('input-message');
  await composer.fill('Is the rollout plan ready?');
  await composer.press('Enter');

  await expect(page.getByTestId('message-assistant')).toContainText(
    'Collective: test the rollback first.',
  );

  const bodies = await capturedChatRequestBodies(page);
  const request = JSON.parse(bodies[0]);
  expect(request.mode).toBe('verify');
  // Canonical voice order, exactly the picks made in the popup.
  expect(request.voiceModels).toEqual([
    { voiceId: 'direct', modelId: 'venom-gpt' },
    { voiceId: 'skeptic', modelId: 'venom-claude' },
    { voiceId: 'evidence', modelId: 'venom-gpt' },
  ]);
  // In Verify the blend corners are the voices themselves.
  const blend = request.blend as Array<{ id: string; weight: number }>;
  expect(blend.map((entry) => entry.id)).toEqual([
    'direct',
    'skeptic',
    'evidence',
  ]);

  // The picks persist on the conversation for cross-device sync.
  await expect
    .poll(async () =>
      page.evaluate(() => {
        const raw = window.localStorage.getItem(
          '@venom_desktop_v1:venom-desktop-ui-test',
        );
        if (!raw) return null;
        const state = JSON.parse(raw) as {
          conversations: Array<{
            id: string;
            voiceModels?: Array<{ voiceId: string; modelId: string }>;
          }>;
        };
        return (
          state.conversations.find(
            (conversation) => conversation.id === 'conv_default',
          )?.voiceModels ?? null
        );
      }),
    )
    .toEqual([
      { voiceId: 'direct', modelId: 'venom-gpt' },
      { voiceId: 'skeptic', modelId: 'venom-claude' },
      { voiceId: 'evidence', modelId: 'venom-gpt' },
    ]);
});

test('with one usable model the popup explains why voice choice is limited', async ({
  page,
}) => {
  await seedEnabledModels(page, ['venom-gpt']);
  await mockModels(page, [MODELS[0]]);
  await mockDeliberationAvailability(page, false);
  await mockKnowledgeExtraction(page);
  await openChat(page);

  await page.getByTestId('button-model-chip').click();
  await expect(page.getByTestId('dialog-model-voices')).toBeVisible();
  await page.getByTestId('switch-verify').click();

  // The pad still balances the voices, but there is nothing to pick between:
  // the popup says so instead of rendering pickers.
  await expect(page.getByTestId('blend-pad')).toBeVisible();
  await expect(page.getByTestId('text-voices-limited')).toBeVisible();
  await expect(page.getByTestId('voice-pick-direct-auto')).toHaveCount(0);

  // Model management remains available in the same popup.
  await expect(page.getByTestId('model-card-venom-gpt')).toBeVisible();
});

test('an auto policy hands the popup to Venom, badges rank cost, and the choice survives a reload', async ({
  page,
}) => {
  await seedEnabledModels(page, undefined, { onlyIfAbsent: true });
  await mockModels(page);
  await mockDeliberationAvailability(page);
  await mockKnowledgeExtraction(page);
  await openChat(page);

  await page.getByTestId('button-model-chip').click();
  await expect(page.getByTestId('dialog-model-voices')).toBeVisible();
  await page.getByTestId('switch-verify').click();

  // Coarse cost badges rank the catalog — tiers only, never prices.
  await expect(page.getByTestId('cost-badge-venom-gpt')).toHaveText('$$$');
  await expect(page.getByTestId('cost-badge-venom-gemini')).toHaveText('$');

  // Manual is the standing default: pickers and library actions are live.
  await expect(page.getByTestId('policy-manual')).toHaveAttribute(
    'aria-checked',
    'true',
  );
  await expect(
    page.getByTestId('voice-pick-skeptic-venom-claude'),
  ).toBeVisible();
  await expect(page.getByTestId('button-use-venom-claude')).toBeEnabled();

  // Hand over to Auto — cheapest.
  await page.getByTestId('policy-auto-cheapest').click();
  await expect(page.getByTestId('policy-auto-cheapest')).toHaveAttribute(
    'aria-checked',
    'true',
  );
  // The takeover says who is choosing and why.
  await expect(page.getByTestId('model-policy-takeover')).toContainText(
    /cheapest/i,
  );
  // Voice pickers hand over instead of pretending picks still apply…
  await expect(page.getByTestId('voice-pick-skeptic-venom-claude')).toHaveCount(
    0,
  );
  await expect(page.getByTestId('voices-policy-takeover')).toBeVisible();
  // …and manual library actions rest while Venom drives.
  await expect(page.getByTestId('button-use-venom-claude')).toBeDisabled();

  // The composer chip announces the takeover.
  await page.getByTestId('button-model-voices-done').click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByTestId('text-active-model')).toContainText(
    'Auto — cheapest',
  );

  // The policy is part of the synced snapshot: it survives a fresh load.
  await page.reload();
  await expect(page.getByTestId('form-composer')).toBeVisible();
  await expect(page.getByTestId('text-active-model')).toContainText(
    'Auto — cheapest',
  );

  // Manual hands control straight back. (Verify persisted with the
  // conversation across the reload, so the voices section is still live.)
  await page.getByTestId('button-model-chip').click();
  await expect(page.getByTestId('policy-auto-cheapest')).toHaveAttribute(
    'aria-checked',
    'true',
  );
  await page.getByTestId('policy-manual').click();
  await expect(
    page.getByTestId('voice-pick-skeptic-venom-claude'),
  ).toBeVisible();
  await expect(page.getByTestId('button-use-venom-claude')).toBeEnabled();
  await expect(page.getByTestId('voices-policy-takeover')).toHaveCount(0);
});
