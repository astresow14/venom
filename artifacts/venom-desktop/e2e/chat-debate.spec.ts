import { expect, test, type Page } from '@playwright/test';
import { mockKnowledgeExtraction } from './support/chat-stream';

const DESKTOP = { width: 1280, height: 860 };

/**
 * Debate mode: named voices argue as visible participants in the thread. The
 * dev server has no API behind it, so every endpoint is stubbed; streams are
 * produced inside the page (fetch wrapper) so mid-round UI can be asserted.
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
  },
  {
    id: 'venom-claude',
    provider: 'anthropic',
    name: 'Venom Claude',
    family: 'Claude',
    summary: 'Model used by browser tests.',
    available: true,
    availabilityText: 'Ready',
  },
  {
    id: 'venom-gemini',
    provider: 'gemini',
    name: 'Venom Gemini',
    family: 'Gemini',
    summary: 'Model used by browser tests.',
    available: true,
    availabilityText: 'Ready',
  },
];

/**
 * Seed the UI-test workspace with the given enabled models. Three enabled
 * models put real model corners on the blend pad; a single enabled model is
 * the shipped default and forces persona fallback even when the server
 * catalog is full.
 */
async function seedEnabledModels(
  page: Page,
  enabledModelIds: string[] = ['venom-gpt', 'venom-claude', 'venom-gemini'],
) {
  await page.addInitScript((enabledIds: string[]) => {
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
  }, enabledModelIds);
}

const DEBATE_ROSTER = [
  {
    voiceId: 'venom-gpt',
    name: 'Venom GPT',
    modelId: 'venom-gpt',
    modelName: 'Venom GPT',
  },
  {
    voiceId: 'venom-claude',
    name: 'Venom Claude',
    modelId: 'venom-claude',
    modelName: 'Venom Claude',
  },
  {
    voiceId: 'venom-gemini',
    name: 'Venom Gemini',
    modelId: 'venom-gemini',
    modelName: 'Venom Gemini',
  },
];

async function mockModels(page: Page) {
  await page.route('**/api/venom/models', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(MODELS),
    });
  });
}

async function mockDeliberationAvailability(page: Page) {
  await page.route('**/api/venom/deliberation', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        available: true,
        mode: 'multi-model',
        voices: [
          { voiceId: 'direct', name: 'First take', tagline: 'Head-on' },
          { voiceId: 'skeptic', name: 'Skeptic', tagline: 'Risks' },
          { voiceId: 'evidence', name: 'Evidence', tagline: 'Sources' },
        ],
      }),
    });
  });
}

/**
 * Streams scripted SSE rounds from inside the page so in-progress debate UI
 * stays on screen long enough to assert. Each /api/venom/respond call
 * consumes the next round; request bodies are recorded on window for
 * interjection assertions.
 */
async function mockDebateRounds(
  page: Page,
  rounds: Array<Array<[number, unknown]>>,
) {
  await page.addInitScript((scriptedRounds: Array<Array<[number, unknown]>>) => {
    const captured: string[] = [];
    (window as unknown as { __debateBodies: string[] }).__debateBodies = captured;
    let call = 0;
    const originalFetch = window.fetch.bind(window);
    window.fetch = (async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ): Promise<Response> => {
      const url =
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.href
            : input.url;
      if (!url.includes('/api/venom/respond')) {
        return originalFetch(input as RequestInfo, init);
      }
      captured.push(String(init?.body ?? ''));
      const events = scriptedRounds[Math.min(call, scriptedRounds.length - 1)];
      call += 1;
      const encoder = new TextEncoder();
      const signal = init?.signal ?? null;
      const stream = new ReadableStream<Uint8Array>({
        async start(controller) {
          for (const [delay, payload] of events) {
            await new Promise((resolve) => setTimeout(resolve, delay));
            if (signal?.aborted) {
              try {
                controller.close();
              } catch {
                /* already closed */
              }
              return;
            }
            controller.enqueue(
              encoder.encode(`data: ${JSON.stringify(payload)}\n\n`),
            );
          }
          controller.close();
        },
      });
      return new Response(stream, {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      });
    }) as typeof window.fetch;
  }, rounds);
}

async function openChat(page: Page) {
  await page.goto('/workspace/chat');
  await expect(page.getByTestId('form-composer')).toBeVisible();
}

function metaEvent(turns: number): unknown {
  return {
    modelId: 'venom-gpt',
    modelName: 'Venom GPT',
    debate: { voices: DEBATE_ROSTER, turns },
  };
}

test.use({ viewport: DESKTOP });

test('debate round: named turns stream into the thread, one voice fails, citations resolve', async ({
  page,
}) => {
  await seedEnabledModels(page);
  await mockModels(page);
  await mockDeliberationAvailability(page);
  await mockKnowledgeExtraction(page);
  await mockDebateRounds(page, [
    [
      [0, metaEvent(4)],
      [
        150,
        {
          debateTurn: {
            index: 0,
            of: 4,
            voiceId: 'venom-gpt',
            name: 'Venom GPT',
            modelId: 'venom-gpt',
            modelName: 'Venom GPT',
          },
        },
      ],
      [200, { turn: 0, content: 'Opening: ship it now.' }],
      [350, { turn: 0, turnStatus: 'ok' }],
      [
        150,
        {
          debateTurn: {
            index: 1,
            of: 4,
            voiceId: 'venom-claude',
            name: 'Venom Claude',
            modelId: 'venom-claude',
            modelName: 'Venom Claude',
          },
        },
      ],
      [200, { turn: 1, content: 'Counter: the runbook [source:src-live] says staging first.' }],
      [250, { turn: 1, turnStatus: 'ok' }],
      [
        150,
        {
          debateTurn: {
            index: 2,
            of: 4,
            voiceId: 'venom-gemini',
            name: 'Venom Gemini',
            modelId: 'venom-gemini',
            modelName: 'Venom Gemini',
          },
        },
      ],
      [250, { turn: 2, turnStatus: 'failed' }],
      [
        150,
        {
          debateTurn: {
            index: 3,
            of: 4,
            voiceId: 'venom-gpt',
            name: 'Venom GPT',
            modelId: 'venom-gpt',
            modelName: 'Venom GPT',
          },
        },
      ],
      [200, { turn: 3, content: 'Closing: stage behind a flag, then ship.' }],
      [250, { turn: 3, turnStatus: 'ok' }],
      [150, { done: true }],
    ],
  ]);
  await openChat(page);

  // Switch to Debate; the pad shows the three real models at the corners.
  await page.getByTestId('mode-option-debate').click();
  await expect(page.getByTestId('mode-option-debate')).toHaveAttribute(
    'aria-checked',
    'true',
  );
  await expect(page.getByTestId('blend-pad')).toBeVisible();
  await expect(page.getByTestId('blend-weight-venom-gpt')).toContainText('33%');
  await expect(page.getByTestId('blend-weight-venom-claude')).toContainText('33%');

  // Keyboard path: favor the first corner without dragging.
  await page.getByTestId('blend-pin').focus();
  await page.keyboard.press('1');
  await expect(page.getByTestId('blend-weight-venom-gpt')).toContainText('70%');
  await page.keyboard.press('Home');
  await expect(page.getByTestId('blend-weight-venom-gpt')).toContainText('33%');

  const composer = page.getByTestId('input-message');
  await composer.fill('Should we ship the migration?');
  await composer.press('Enter');

  // Mid-round: the status line names the current speaker, and the composer
  // stays open — the user is a participant, not a spectator.
  const status = page.getByTestId('debate-status');
  await expect(status).toBeVisible();
  await expect(status).toContainText('Venom GPT is speaking');
  await expect(composer).toBeEnabled();
  await expect(page.getByTestId('button-debate-stop')).toBeVisible();

  // Turns persist as named messages as they finish.
  const speakerChips = page.getByTestId('chip-speaker');
  await expect(speakerChips.first()).toContainText('Venom GPT');

  // The failed voice is flagged, and the round carries on without it.
  await expect(page.getByTestId('chip-debate-failed')).toContainText(
    "Venom Gemini couldn't respond",
  );

  // Round done: three completed turns in the thread, attributed by name.
  await expect(page.getByTestId('debate-stream')).toHaveCount(0);
  const assistants = page.getByTestId('message-assistant');
  await expect(assistants).toHaveCount(3);
  await expect(assistants.nth(0)).toContainText('Opening: ship it now.');
  await expect(assistants.nth(1)).toContainText('staging first');
  await expect(assistants.nth(2)).toContainText('Closing: stage behind a flag');

  // Citations resolve to references, never raw markers.
  await expect(assistants.nth(1)).toContainText('(archived source)');
  await expect(assistants.nth(1)).not.toContainText('[source:');

  // Clients persist exactly what the server streamed — never more. The
  // stored turn content is byte-identical to the bounded SSE content (raw
  // citation markers included; they resolve at render time), so a capped
  // turn can never re-expand through persistence or sync.
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
            messages: Array<{ role: string; content: string }>;
          }>;
        };
        return (
          state.conversations
            .find((conversation) => conversation.id === 'conv_default')
            ?.messages.filter((message) => message.role === 'assistant')
            .map((message) => message.content) ?? null
        );
      }),
    )
    .toEqual([
      'Opening: ship it now.',
      'Counter: the runbook [source:src-live] says staging first.',
      'Closing: stage behind a flag, then ship.',
    ]);

  // The request carried the debate mode and the blend weights.
  const bodies = await page.evaluate(
    () => (window as unknown as { __debateBodies: string[] }).__debateBodies,
  );
  const request = JSON.parse(bodies[0]);
  expect(request.mode).toBe('debate');
  expect(request.blend).toHaveLength(3);
  expect(request.blend[0].id).toBe('venom-gpt');

  // Mode stays remembered for the conversation.
  await expect(page.getByTestId('mode-option-debate')).toHaveAttribute(
    'aria-checked',
    'true',
  );
});

test('one enabled model with a full server catalog debates as personas with mapped weights', async ({
  page,
}) => {
  // The shipped default: a single enabled model, while the server catalog
  // still lists three providers. The pad must fall back to persona corners,
  // send persona ids as the blend, and the round must run those personas —
  // the pad always describes the debate actually run.
  await seedEnabledModels(page, ['venom-gpt']);
  await mockModels(page);
  await mockDeliberationAvailability(page);
  await mockKnowledgeExtraction(page);
  const personaTurn = (
    index: number,
    voiceId: string,
    name: string,
    text: string,
  ): Array<[number, unknown]> => [
    [
      100,
      {
        debateTurn: {
          index,
          of: 3,
          voiceId,
          name,
          modelId: 'venom-gpt',
          modelName: 'Venom GPT',
        },
      },
    ],
    [150, { turn: index, content: text }],
    [200, { turn: index, turnStatus: 'ok' }],
  ];
  await mockDebateRounds(page, [
    [
      [
        0,
        {
          modelId: 'venom-gpt',
          modelName: 'Venom GPT',
          debate: {
            voices: [
              {
                voiceId: 'skeptic',
                name: 'Skeptic',
                modelId: 'venom-gpt',
                modelName: 'Venom GPT',
              },
              {
                voiceId: 'direct',
                name: 'First take',
                modelId: 'venom-gpt',
                modelName: 'Venom GPT',
              },
              {
                voiceId: 'evidence',
                name: 'Evidence',
                modelId: 'venom-gpt',
                modelName: 'Venom GPT',
              },
            ],
            turns: 3,
          },
        },
      ],
      ...personaTurn(0, 'skeptic', 'Skeptic', 'Risk first: the rollback path is untested.'),
      ...personaTurn(1, 'direct', 'First take', 'Ship it behind a flag.'),
      ...personaTurn(2, 'skeptic', 'Skeptic', 'Then the flag is the test.'),
      [100, { done: true }],
    ],
  ]);
  await openChat(page);

  await page.getByTestId('mode-option-debate').click();
  await expect(page.getByTestId('blend-pad')).toBeVisible();

  // Persona corners, not the two disabled models.
  await expect(page.getByTestId('blend-weight-direct')).toContainText('33%');
  await expect(page.getByTestId('blend-weight-skeptic')).toContainText('33%');
  await expect(page.getByTestId('blend-weight-evidence')).toContainText('33%');
  await expect(page.getByTestId('blend-pad')).not.toContainText('Venom Claude');

  // Favor the second corner (Skeptic) via the keyboard path.
  await page.getByTestId('blend-pin').focus();
  await page.keyboard.press('2');
  await expect(page.getByTestId('blend-weight-skeptic')).toContainText('70%');

  const composer = page.getByTestId('input-message');
  await composer.fill('Do we ship this week?');
  await composer.press('Enter');

  // Turns arrive attributed to persona names.
  await expect(page.getByTestId('debate-status')).toContainText(
    'Skeptic is speaking',
  );
  const assistants = page.getByTestId('message-assistant');
  await expect(assistants).toHaveCount(3);
  await expect(assistants.nth(0)).toContainText('Risk first');
  await expect(page.getByTestId('chip-speaker').first()).toContainText('Skeptic');

  // The request carried persona corner ids with the skeptic favored — the
  // exact contract the server planner honors.
  const bodies = await page.evaluate(
    () => (window as unknown as { __debateBodies: string[] }).__debateBodies,
  );
  const request = JSON.parse(bodies[0]);
  expect(request.mode).toBe('debate');
  expect(request.modelId).toBe('venom-gpt');
  const blend = request.blend as Array<{ id: string; weight: number }>;
  expect(blend.map((entry) => entry.id).sort()).toEqual([
    'direct',
    'evidence',
    'skeptic',
  ]);
  const skeptic = blend.find((entry) => entry.id === 'skeptic')!;
  expect(
    blend.every((entry) => entry.weight <= skeptic.weight),
  ).toBe(true);
  expect(skeptic.weight).toBeGreaterThan(0.5);
});

test('interjection joins the thread and the next turns see it; stop ends the round cleanly', async ({
  page,
}) => {
  await seedEnabledModels(page);
  await mockModels(page);
  await mockDeliberationAvailability(page);
  await mockKnowledgeExtraction(page);
  const slowTurn = (
    index: number,
    voice: (typeof DEBATE_ROSTER)[number],
    text: string,
  ): Array<[number, unknown]> => [
    [
      150,
      {
        debateTurn: {
          index,
          of: 3,
          voiceId: voice.voiceId,
          name: voice.name,
          modelId: voice.modelId,
          modelName: voice.modelName,
        },
      },
    ],
    [250, { turn: index, content: text }],
    [600, { turn: index, turnStatus: 'ok' }],
  ];
  await mockDebateRounds(page, [
    // Round 1: two slow turns, then a third the test never reaches because
    // the interjection restarts the round at the second turn boundary.
    [
      [0, metaEvent(3)],
      ...slowTurn(0, DEBATE_ROSTER[0], 'First point.'),
      ...slowTurn(1, DEBATE_ROSTER[1], 'Second point.'),
      ...slowTurn(2, DEBATE_ROSTER[2], 'Third point, never seen.'),
      [150, { done: true }],
    ],
    // Round 2 (after the interjection): a reply that reacts to the user,
    // then a long-running turn the test stops mid-stream.
    [
      [0, metaEvent(2)],
      ...slowTurn(0, DEBATE_ROSTER[2], 'Noted your budget concern.'),
      [
        150,
        {
          debateTurn: {
            index: 1,
            of: 2,
            voiceId: 'venom-gpt',
            name: 'Venom GPT',
            modelId: 'venom-gpt',
            modelName: 'Venom GPT',
          },
        },
      ],
      [250, { turn: 1, content: 'Then we descope, still ship.' }],
      [5000, { turn: 1, turnStatus: 'ok' }],
      [150, { done: true }],
    ],
  ]);
  await openChat(page);

  await page.getByTestId('mode-option-debate').click();
  const composer = page.getByTestId('input-message');
  await composer.fill('Kick it around.');
  await composer.press('Enter');

  // Wait until the first turn is streaming, then interject.
  await expect(page.getByTestId('debate-status')).toContainText(
    'Venom GPT is speaking',
  );
  await composer.fill('Budget matters more than speed.');
  await composer.press('Enter');

  // The interjection appears in the thread immediately.
  await expect(
    page.getByTestId('message-user').filter({ hasText: 'Budget matters' }),
  ).toBeVisible();

  // The restarted round reacts to it.
  await expect(
    page.getByTestId('message-assistant').filter({ hasText: 'Noted your budget concern.' }),
  ).toBeVisible({ timeout: 15_000 });

  // Wait until that turn is finished and the next voice is mid-turn.
  await expect(page.getByTestId('debate-status')).toContainText(
    'Venom GPT is speaking',
    { timeout: 15_000 },
  );

  // The second request's context included the interjection.
  const bodies = await page.evaluate(
    () => (window as unknown as { __debateBodies: string[] }).__debateBodies,
  );
  expect(bodies.length).toBeGreaterThanOrEqual(2);
  const secondRequest = JSON.parse(bodies[bodies.length - 1]);
  const roles = secondRequest.messages.map((m: { role: string }) => m.role);
  expect(
    secondRequest.messages.some((m: { content: string }) =>
      m.content.includes('Budget matters more than speed.'),
    ),
  ).toBe(true);
  // Prior debate turns travel as assistant history.
  expect(roles).toContain('assistant');

  // Stop mid-turn: the round ends cleanly, finished turns stay, and the
  // partial turn is discarded rather than half-persisted.
  await page.getByTestId('button-debate-stop').click();
  await expect(page.getByTestId('debate-stream')).toHaveCount(0);
  await expect(page.getByTestId('button-debate-stop')).toHaveCount(0);
  await expect(
    page.getByTestId('message-assistant').filter({ hasText: 'Noted your budget concern.' }),
  ).toBeVisible();
  await expect(
    page.getByTestId('message-assistant').filter({ hasText: 'Then we descope' }),
  ).toHaveCount(0);
  await expect(composer).toBeEnabled();
});
