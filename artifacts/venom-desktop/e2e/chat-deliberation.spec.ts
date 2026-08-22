import { expect, test, type Page } from '@playwright/test';
import {
  mockChatStream,
  mockKnowledgeExtraction,
  mockStagedChatStream,
} from './support/chat-stream';

const DESKTOP = { width: 1280, height: 860 };

/**
 * Multi-voice deliberation: an opt-in turn runs three voices in parallel,
 * then converges into one collective answer that flags where they split.
 * The dev server has no API behind it, so every endpoint is stubbed.
 */

const ROSTER = [
  {
    voiceId: 'direct',
    name: 'First take',
    tagline: 'Answers the question head-on',
    modelId: 'gpt-5',
    modelName: 'Venom GPT',
  },
  {
    voiceId: 'skeptic',
    name: 'Skeptic',
    tagline: 'Attacks assumptions and risks',
    modelId: 'claude-sonnet',
    modelName: 'Venom Claude',
  },
  {
    voiceId: 'evidence',
    name: 'Evidence',
    tagline: 'Sticks to the cited sources',
    modelId: 'gemini-pro',
    modelName: 'Venom Gemini',
  },
] as const;

const DIRECT_TAKE = 'Ship the migration now; the risk is small.';
const EVIDENCE_TAKE = 'The runbook [source:src-live] says staging first.';
const DISAGREEMENT =
  'First take wanted to ship immediately; Evidence insisted on staging first.';

function finalDeliberation(disagreements: string[]) {
  return {
    deliberation: {
      voices: [
        {
          voiceId: 'direct',
          name: 'First take',
          modelId: 'gpt-5',
          modelName: 'Venom GPT',
          content: DIRECT_TAKE,
          status: 'ok',
        },
        {
          voiceId: 'skeptic',
          name: 'Skeptic',
          modelId: 'claude-sonnet',
          modelName: 'Venom Claude',
          content: '',
          status: 'failed',
        },
        {
          voiceId: 'evidence',
          name: 'Evidence',
          modelId: 'gemini-pro',
          modelName: 'Venom Gemini',
          content: EVIDENCE_TAKE,
          status: 'ok',
        },
      ],
      disagreements,
    },
  };
}

async function mockModels(page: Page) {
  await page.route('**/api/venom/models', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify([
        {
          id: 'gpt-5',
          provider: 'openai',
          name: 'Venom GPT',
          family: 'GPT',
          summary: 'Model used by browser tests.',
          available: true,
          availabilityText: 'Ready',
        },
      ]),
    });
  });
}

async function mockDeliberationAvailability(
  page: Page,
  mode: 'multi-model' | 'personas' = 'multi-model',
) {
  await page.route('**/api/venom/deliberation', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        available: true,
        mode,
        // The catalog behind these tests holds a single usable model, so the
        // server reports that per-voice model choice is unavailable.
        distinctModels: false,
        voices: ROSTER.map(({ voiceId, name, tagline }) => ({
          voiceId,
          name,
          tagline,
        })),
      }),
    });
  });
}

async function openChat(page: Page) {
  await page.goto('/workspace/chat');
  await expect(page.getByTestId('form-composer')).toBeVisible();
}

test.use({ viewport: DESKTOP });

test('deliberates a turn: voices stream, one fails, the collective answer flags the split', async ({
  page,
}) => {
  await mockModels(page);
  await mockDeliberationAvailability(page);
  await mockKnowledgeExtraction(page);
  // A single script: the shared stub replays it for this turn (and any
  // further calls, which this test never makes).
  await mockStagedChatStream(page, [
    [
      [
        0,
        {
          modelId: 'gpt-5',
          modelName: 'Venom GPT',
          deliberation: { voices: ROSTER },
        },
      ],
      [250, { voice: 'direct', content: DIRECT_TAKE }],
      [250, { voice: 'evidence', content: EVIDENCE_TAKE }],
      [250, { voice: 'direct', voiceStatus: 'ok' }],
      [250, { voice: 'skeptic', voiceStatus: 'failed' }],
      [250, { voice: 'evidence', voiceStatus: 'ok' }],
      [250, { stage: 'synthesis' }],
      [250, { content: 'Collective: stage it first, ' }],
      [200, { content: 'then ship behind a flag.' }],
      [200, finalDeliberation([DISAGREEMENT])],
      [100, { done: true }],
    ],
  ]);
  await openChat(page);

  // Verify lives in the model configuration: open the Select-model popup
  // and switch it on. The composer itself only carries the Debate switch.
  const debateSwitch = page.getByTestId('switch-debate');
  await expect(debateSwitch).toBeVisible();
  await expect(debateSwitch).toHaveAttribute('aria-checked', 'false');
  await page.getByTestId('button-model-chip').click();
  await expect(page.getByTestId('dialog-model-voices')).toBeVisible();
  const verifySwitch = page.getByTestId('switch-verify');
  await expect(verifySwitch).toHaveAttribute('aria-checked', 'false');
  await verifySwitch.click();
  await expect(verifySwitch).toHaveAttribute('aria-checked', 'true');

  // The blend pad appears in the same popup once Verify is on; in Verify
  // the corners are the three voices themselves.
  await expect(page.getByTestId('blend-pad')).toBeVisible();
  await expect(page.getByTestId('blend-weight-direct')).toContainText('33%');
  // A single usable model: voice choice is limited, and the popup says why
  // instead of offering per-voice pickers.
  await expect(page.getByTestId('text-voices-limited')).toBeVisible();
  await expect(page.getByTestId('voice-pick-skeptic-auto')).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);

  const composer = page.getByTestId('input-message');
  await composer.fill('Should we ship the migration?');
  await composer.press('Enter');

  // While the turn streams, the conversation's mode is locked: the dialog's
  // Verify switch rests until the reply lands, like the Debate switch.
  await page.getByTestId('button-model-chip').click();
  await expect(page.getByTestId('dialog-model-voices')).toBeVisible();
  await expect(page.getByTestId('switch-verify')).toBeDisabled();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);

  // The chamber: named voices surface their takes while streaming.
  const panel = page.getByTestId('deliberation-panel');
  await expect(panel).toBeVisible();
  await expect(page.getByTestId('deliberation-voice-direct')).toContainText(
    'Ship the migration',
  );
  // Citation markers never render raw, even mid-stream.
  const evidenceCard = page.getByTestId('deliberation-voice-evidence');
  await expect(evidenceCard).toContainText('(archived source)');
  await expect(evidenceCard).not.toContainText('[source:');
  // A dead voice is marked, and the turn keeps going without it.
  await expect(page.getByTestId('deliberation-voice-skeptic')).toContainText(
    "Didn't finish — the others carry on.",
  );
  // Voices are personas over the model catalog, so each live card carries
  // its own monogram avatar — visually distinct even when models repeat.
  await expect(
    page
      .getByTestId('deliberation-voice-direct')
      .getByTestId('speaker-avatar-monogram-ft'),
  ).toBeVisible();
  await expect(
    page
      .getByTestId('deliberation-voice-evidence')
      .getByTestId('speaker-avatar-monogram-e'),
  ).toBeVisible();

  // The turn ends as one collective answer with the disagreement flagged.
  const answer = page.getByTestId('message-assistant');
  await expect(answer).toContainText(
    'Collective: stage it first, then ship behind a flag.',
  );
  const result = page.getByTestId('deliberation-result');
  await expect(result).toBeVisible();
  await expect(page.getByTestId('deliberation-disagreements')).toContainText(
    DISAGREEMENT,
  );
  await expect(page.getByTestId('deliberation-panel')).toHaveCount(0);

  // Individual takes stay readable, attributed to voice and model.
  await page.getByTestId('button-toggle-takes').click();
  const takes = page.getByTestId('deliberation-takes');
  await expect(takes).toBeVisible();
  await expect(page.getByTestId('deliberation-take-direct')).toContainText(
    'Ship the migration',
  );
  await expect(page.getByTestId('deliberation-take-direct')).toContainText(
    'Venom GPT',
  );
  await expect(page.getByTestId('deliberation-take-skeptic')).toContainText(
    "This voice didn't finish its take.",
  );
  // Persisted take rows keep the voice monograms.
  await expect(
    page
      .getByTestId('deliberation-take-direct')
      .getByTestId('speaker-avatar-monogram-ft'),
  ).toBeVisible();
  await expect(
    page
      .getByTestId('deliberation-take-skeptic')
      .getByTestId('speaker-avatar-monogram-s'),
  ).toBeVisible();
  const evidenceTake = page.getByTestId('deliberation-take-evidence');
  await expect(evidenceTake).toContainText('(archived source)');
  await expect(evidenceTake).not.toContainText('[source:');
  await expect(result).not.toContainText('[source:');

  // The mode is remembered for the conversation, not rearmed per message.
  await page.getByTestId('button-model-chip').click();
  await expect(page.getByTestId('switch-verify')).toHaveAttribute(
    'aria-checked',
    'true',
  );
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
});

test('persona mode converges without model attribution and reports agreement', async ({
  page,
}) => {
  await mockModels(page);
  await mockDeliberationAvailability(page, 'personas');
  await mockKnowledgeExtraction(page);
  // Every voice runs the same anchor model; the stream is served atomically
  // and only the finished rendering is asserted.
  const personaRoster = ROSTER.map((voice) => ({
    ...voice,
    modelId: 'gpt-5',
    modelName: 'Venom GPT',
  }));
  const final = finalDeliberation([]);
  final.deliberation.voices = final.deliberation.voices.map((take) => ({
    ...take,
    modelId: 'gpt-5',
    modelName: 'Venom GPT',
  }));
  await page.route('**/api/venom/respond', async (route) => {
    const events = [
      {
        modelId: 'gpt-5',
        modelName: 'Venom GPT',
        deliberation: { voices: personaRoster },
      },
      { voice: 'direct', content: DIRECT_TAKE },
      { voice: 'direct', voiceStatus: 'ok' },
      { voice: 'skeptic', voiceStatus: 'failed' },
      { voice: 'evidence', content: EVIDENCE_TAKE },
      { voice: 'evidence', voiceStatus: 'ok' },
      { stage: 'synthesis' },
      { content: 'One collective persona answer.' },
      final,
      { done: true },
    ];
    await route.fulfill({
      status: 200,
      contentType: 'text/event-stream',
      body: events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''),
    });
  });
  await openChat(page);

  await page.getByTestId('button-model-chip').click();
  await page.getByTestId('switch-verify').click();
  await page.getByTestId('button-model-voices-done').click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  const composer = page.getByTestId('input-message');
  await composer.fill('Same model everywhere?');
  await composer.press('Enter');

  await expect(page.getByTestId('message-assistant')).toContainText(
    'One collective persona answer.',
  );
  // No disagreements: the result says so instead of showing an empty block.
  await expect(page.getByTestId('deliberation-agreement')).toBeVisible();
  await expect(page.getByTestId('deliberation-disagreements')).toHaveCount(0);

  await page.getByTestId('button-toggle-takes').click();
  const directTake = page.getByTestId('deliberation-take-direct');
  await expect(directTake).toContainText('First take');
  // All voices share one model, so per-take model attribution is dropped.
  await expect(directTake).not.toContainText('Venom GPT');
});

test('hides the control when the server has no deliberation endpoint', async ({
  page,
}) => {
  await mockModels(page);
  await mockKnowledgeExtraction(page);
  await page.route('**/api/venom/deliberation', async (route) => {
    await route.fulfill({
      status: 404,
      contentType: 'application/json',
      body: JSON.stringify({ error: 'Not found' }),
    });
  });
  await mockChatStream(page, ['Ordinary reply.']);
  await openChat(page);

  await expect(page.getByTestId('switch-debate')).toHaveCount(0);
  await expect(page.getByTestId('blend-pad')).toHaveCount(0);
  // The model popup hides Verify too — no deliberation, no verify toggle.
  await page.getByTestId('button-model-chip').click();
  await expect(page.getByTestId('dialog-model-voices')).toBeVisible();
  await expect(page.getByTestId('switch-verify')).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);

  // Ordinary messages behave exactly as before.
  const composer = page.getByTestId('input-message');
  await composer.fill('Just answer normally.');
  await composer.press('Enter');
  await expect(page.getByTestId('message-assistant')).toContainText(
    'Ordinary reply.',
  );
  await expect(page.getByTestId('deliberation-result')).toHaveCount(0);
});
