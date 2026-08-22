import { expect, test, type Page } from '@playwright/test';
import { stubWorkspaceApis } from './support/stubs';

/**
 * Hands-free voice mode on desktop.
 *
 * The composer's mic button opens a full-screen voice surface running the
 * same loop as the phone: listen → transcribe → decide → reply out loud →
 * listen again, with every turn filed into the active conversation. The
 * UI-test bundle swaps the Web Audio adapter for a deterministic harness
 * driven through window events, and every voice endpoint is stubbed here —
 * UI-test mode keeps fetches live, so an unstubbed route would hit the dev
 * server's HTML fallback and break JSON parsing.
 *
 * Harness controls (see src/lib/voice/audio/voiceTestHarness.ts):
 *   dispatch 'venom-voice:utterance'      → one finished utterance
 *   __venomVoiceDenyMic                   → capture start fails (mic denied)
 *   __venomVoiceHoldPlayback              → playback waits for
 *                                           'venom-voice:finish-playback'
 *   __venomVoiceCaptureState              → 'idle|listening|paused|stopped'
 *   __venomVoicePlaybackLog               → { begun, chunks, ends, stops, … }
 */

const DESKTOP = { width: 1280, height: 860 };
test.use({ viewport: DESKTOP });

const PRESETS = [
  { id: 'sam', name: 'Sam' },
  { id: 'marcus', name: 'Marcus' },
  { id: 'rowan', name: 'Rowan' },
  { id: 'elijah', name: 'Elijah' },
  { id: 'maya', name: 'Maya' },
  { id: 'isla', name: 'Isla' },
] as const;

type DecisionScript = {
  decision: 'respond' | 'acknowledge' | 'silent';
  windDown?: boolean;
  acknowledgment?: string;
  /** Omit the decisionId — the decision executes but goes untracked. */
  untracked?: boolean;
};

type VoiceStubOptions = {
  /** Sequential transcripts; the last one repeats when exhausted. */
  transcripts?: string[];
  /** Sequential replies as SSE content chunk arrays; last repeats. */
  replies?: string[][];
  /** Sequential restraint decisions; default is tracked `respond`. */
  decisions?: DecisionScript[];
  /** Initial /voice/catalog status — mutable via the returned controls. */
  catalogStatus?: number;
};

type VoiceStubControls = {
  catalogStatus: number;
  log: {
    transcribe: Array<{ audioBase64?: string }>;
    respond: Array<{
      projectId?: string;
      modelId?: string;
      workspaceId?: string;
      projectContext?: string;
      messages?: Array<{ role: string; content: string }>;
    }>;
    speak: Array<{ text?: string; presetId?: string }>;
    decide: Array<{
      transcript?: string;
      talkativeness?: string;
      recentTurns?: Array<{ role: string; content: string }>;
    }>;
    outcomes: Array<{ decisionId?: string; outcome?: string }>;
    extract: Array<{ conversation?: { projectId?: string | null } }>;
  };
};

function sse(events: unknown[]): string {
  return (
    events
      .map(
        (event) =>
          `data: ${typeof event === 'string' ? event : JSON.stringify(event)}\n\n`,
      )
      .join('') + 'data: [DONE]\n\n'
  );
}

/** Stubs the whole voice backend and records every request body. */
async function stubVoiceBackend(
  page: Page,
  options: VoiceStubOptions = {},
): Promise<VoiceStubControls> {
  const transcripts = [...(options.transcripts ?? ['Hello there.'])];
  const replies = [...(options.replies ?? [['Right ', 'here.']])];
  const decisions = [...(options.decisions ?? [])];
  let decisionCounter = 0;
  let lastTranscript = transcripts[transcripts.length - 1] ?? 'Hello there.';
  let lastReply = replies[replies.length - 1] ?? ['Right ', 'here.'];

  const controls: VoiceStubControls = {
    catalogStatus: options.catalogStatus ?? 200,
    log: {
      transcribe: [],
      respond: [],
      speak: [],
      decide: [],
      outcomes: [],
      extract: [],
    },
  };

  await stubWorkspaceApis(page);

  await page.route('**/api/venom/voice/catalog', async (route) => {
    if (controls.catalogStatus !== 200) {
      await route.fulfill({
        status: controls.catalogStatus,
        contentType: 'application/json',
        body: JSON.stringify({
          error: 'Voice is not configured right now.',
          code: 'voice_unavailable',
        }),
      });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(
        PRESETS.map((preset) => ({
          id: preset.id,
          name: preset.name,
          persona: `${preset.name} persona`,
          tone: 'steady',
          sampleText: `Hey, I'm ${preset.name}.`,
          available: true,
          availabilityText: 'Ready',
        })),
      ),
    });
  });

  await page.route('**/api/venom/voice/transcribe', async (route) => {
    controls.log.transcribe.push(route.request().postDataJSON() ?? {});
    const text = transcripts.length > 0 ? transcripts.shift()! : lastTranscript;
    lastTranscript = text;
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ text }),
    });
  });

  await page.route('**/api/venom/respond', async (route) => {
    controls.log.respond.push(route.request().postDataJSON() ?? {});
    const chunks = replies.length > 0 ? replies.shift()! : lastReply;
    lastReply = chunks;
    await route.fulfill({
      status: 200,
      contentType: 'text/event-stream',
      body: sse([
        { modelId: 'test-model', modelName: 'Test Model' },
        ...chunks.map((content) => ({ content })),
        { done: true },
      ]),
    });
  });

  await page.route('**/api/venom/voice/speak', async (route) => {
    controls.log.speak.push(route.request().postDataJSON() ?? {});
    await route.fulfill({
      status: 200,
      contentType: 'text/event-stream',
      body: sse([
        { format: { sampleRate: 24000 } },
        { audio: 'QUJD' },
        { audio: 'REVG' },
        { done: true },
      ]),
    });
  });

  await page.route('**/api/venom/voice/decide', async (route) => {
    controls.log.decide.push(route.request().postDataJSON() ?? {});
    decisionCounter += 1;
    const script = decisions.shift();
    const body: Record<string, unknown> = script
      ? {
          ...(script.untracked
            ? {}
            : { decisionId: `dec-${decisionCounter}` }),
          decision: script.decision,
          windDown: script.windDown === true,
          ...(script.acknowledgment
            ? { acknowledgment: script.acknowledgment }
            : {}),
        }
      : {
          decisionId: `dec-${decisionCounter}`,
          decision: 'respond',
          windDown: false,
        };
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(body),
    });
  });

  await page.route('**/api/venom/voice/decision-outcome', async (route) => {
    controls.log.outcomes.push(route.request().postDataJSON() ?? {});
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ ok: true }),
    });
  });

  await page.route('**/api/venom/knowledge/extract', async (route) => {
    controls.log.extract.push(route.request().postDataJSON() ?? {});
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ clusters: [] }),
    });
  });

  return controls;
}

async function openChat(page: Page) {
  await page.goto('/workspace/chat');
  await expect(page.getByTestId('form-composer')).toBeVisible();
}

async function openVoiceMode(page: Page) {
  await page.getByTestId('button-voice-mode').click();
  await expect(page.getByTestId('voice-mode-overlay')).toBeVisible();
}

async function waitForListening(page: Page) {
  await page.waitForFunction(
    () =>
      (window as unknown as { __venomVoiceCaptureState?: string })
        .__venomVoiceCaptureState === 'listening',
  );
  await expect(page.getByTestId('voice-status')).toHaveText(/listening/);
}

async function sendUtterance(page: Page, durationMs = 1500) {
  await page.evaluate((ms) => {
    window.dispatchEvent(
      new CustomEvent('venom-voice:utterance', { detail: { durationMs: ms } }),
    );
  }, durationMs);
}

test('runs the hands-free loop for two turns and files both into the thread', async ({
  page,
}) => {
  const controls = await stubVoiceBackend(page, {
    transcripts: ['What are symbiotes made of?', 'And how do they bond?'],
    replies: [
      ['Living ', 'alien material.'],
      ['Through ', 'complete fusion.'],
    ],
  });
  await openChat(page);
  await openVoiceMode(page);
  await waitForListening(page);

  // Turn one: utterance → transcript bubble for each side of the exchange.
  await sendUtterance(page);
  await expect(page.getByTestId('voice-transcript-user')).toHaveText(
    'What are symbiotes made of?',
  );
  await expect(page.getByTestId('voice-transcript-assistant')).toHaveText(
    'Living alien material.',
  );
  // The reply played out and the loop resumed listening on its own; the
  // filed bubbles replaced the live ones (never both).
  await waitForListening(page);
  await expect(page.getByTestId('voice-live-user')).toHaveCount(0);
  await expect(page.getByTestId('voice-live-assistant')).toHaveCount(0);

  // Turn two rides the same session.
  await sendUtterance(page);
  await expect(page.getByTestId('voice-transcript-user')).toHaveCount(2);
  await expect(page.getByTestId('voice-transcript-assistant')).toHaveCount(2);
  await waitForListening(page);

  // The respond calls carried chat's own request shape: project scope and
  // the running history.
  expect(controls.log.respond).toHaveLength(2);
  expect(controls.log.respond[0].projectId).toBe('proj_default');
  expect(controls.log.respond[0].messages?.at(-1)).toEqual({
    role: 'user',
    content: 'What are symbiotes made of?',
  });
  const secondMessages = controls.log.respond[1].messages ?? [];
  expect(secondMessages.at(-1)).toEqual({
    role: 'user',
    content: 'And how do they bond?',
  });
  expect(
    secondMessages.some(
      (message) =>
        message.role === 'assistant' &&
        message.content === 'Living alien material.',
    ),
  ).toBe(true);

  // Speech went through the synthesis stream with the default preset.
  expect(controls.log.speak.length).toBeGreaterThan(0);
  expect(controls.log.speak[0].presetId).toBe('sam');

  // Extraction ran in the background for each completed turn.
  await expect(() => {
    expect(controls.log.extract.length).toBeGreaterThanOrEqual(2);
  }).toPass();

  // Closing voice mode lands both turns in the ordinary chat thread.
  await page.getByTestId('voice-mode-close').click();
  await expect(page.getByTestId('voice-mode-overlay')).toHaveCount(0);
  await expect(page.getByTestId('message-user')).toHaveCount(2);
  await expect(page.getByTestId('message-assistant')).toHaveCount(2);
  await expect(
    page.getByTestId('message-assistant').filter({
      hasText: 'Through complete fusion.',
    }),
  ).toBeVisible();
});

test('clicking the mass interrupts the reply and keeps the words already spoken', async ({
  page,
}) => {
  const controls = await stubVoiceBackend(page, {
    transcripts: ['Tell me everything.'],
    replies: [['This answer ', 'goes on for a while.']],
  });
  await openChat(page);
  await openVoiceMode(page);
  await waitForListening(page);

  // Hold playback open so the speaking state is assertable.
  await page.evaluate(() => {
    (window as unknown as { __venomVoiceHoldPlayback?: boolean }).__venomVoiceHoldPlayback =
      true;
  });
  await sendUtterance(page);
  await expect(page.getByTestId('voice-status')).toHaveText('Sam is speaking');

  // The orb is the interrupt control while Venom is talking.
  await page.getByTestId('voice-orb-press').click();
  await waitForListening(page);

  // The reply text stays in the transcript; playback was stopped.
  await expect(page.getByTestId('voice-transcript-assistant')).toHaveText(
    'This answer goes on for a while.',
  );
  const stops = await page.evaluate(
    () =>
      (window as unknown as { __venomVoicePlaybackLog?: { stops: number } })
        .__venomVoicePlaybackLog?.stops ?? 0,
  );
  expect(stops).toBeGreaterThan(0);
  expect(controls.log.respond).toHaveLength(1);
});

test('the picker previews voices and a new choice carries into the next reply', async ({
  page,
}) => {
  const controls = await stubVoiceBackend(page, {
    transcripts: ['Say something.'],
    replies: [['Something.']],
  });
  await openChat(page);
  await openVoiceMode(page);
  await waitForListening(page);

  await page.getByTestId('voice-preset-chip').click();
  await expect(page.getByTestId('voice-picker-sheet')).toBeVisible();
  await expect(page.getByTestId('voice-preset-sam')).toHaveAttribute(
    'aria-checked',
    'true',
  );

  // Preview streams a sample line with the previewed preset, not the active.
  await page.getByTestId('voice-preview-maya').click();
  await expect(() => {
    expect(
      controls.log.speak.some(
        (call) => call.presetId === 'maya' && call.text === "Hey, I'm Maya.",
      ),
    ).toBe(true);
  }).toPass();

  // Selecting a voice updates the chip and sticks for the session.
  await page.getByTestId('voice-preset-isla').click();
  await expect(page.getByTestId('voice-preset-isla')).toHaveAttribute(
    'aria-checked',
    'true',
  );
  await page.getByTestId('voice-picker-close').click();
  await expect(page.getByTestId('voice-picker-sheet')).toHaveCount(0);
  await expect(page.getByTestId('voice-preset-chip')).toHaveText(/Isla/);

  // The next spoken reply uses the newly selected voice.
  await sendUtterance(page);
  await expect(page.getByTestId('voice-transcript-assistant')).toHaveText(
    'Something.',
  );
  await expect(() => {
    expect(controls.log.speak.at(-1)?.presetId).toBe('isla');
  }).toPass();
});

test('a denied microphone explains itself and drops back to text quietly', async ({
  page,
}) => {
  await stubVoiceBackend(page);
  await page.addInitScript(() => {
    (window as unknown as { __venomVoiceDenyMic?: boolean }).__venomVoiceDenyMic =
      true;
  });
  await openChat(page);
  await openVoiceMode(page);

  await expect(page.getByTestId('voice-error-panel')).toBeVisible();
  await expect(page.getByTestId('voice-error-message')).toHaveText(
    /microphone access is off/i,
  );

  // Back to text: the overlay leaves and the composer still works.
  await page.getByTestId('voice-error-exit').click();
  await expect(page.getByTestId('voice-mode-overlay')).toHaveCount(0);
  await page.getByTestId('input-message').fill('typing still works');
  await expect(page.getByTestId('input-message')).toHaveValue(
    'typing still works',
  );
});

test('an unconfigured voice backend degrades softly and retry recovers', async ({
  page,
}) => {
  const controls = await stubVoiceBackend(page, {
    transcripts: ['Are you there now?'],
    replies: [['Now ', 'I am.']],
    catalogStatus: 503,
  });
  await openChat(page);
  await openVoiceMode(page);

  await expect(page.getByTestId('voice-error-panel')).toBeVisible();
  await expect(page.getByTestId('voice-error-message')).toHaveText(
    /not configured/i,
  );

  // The provider comes back; Try again starts a fresh session.
  controls.catalogStatus = 200;
  await page.getByTestId('voice-error-retry').click();
  await waitForListening(page);

  // And the loop genuinely works after recovery.
  await sendUtterance(page);
  await expect(page.getByTestId('voice-transcript-assistant')).toHaveText(
    'Now I am.',
  );
});

test('a silent decision files the words, stays quiet, and reports its outcome', async ({
  page,
}) => {
  const controls = await stubVoiceBackend(page, {
    transcripts: ['Just thinking out loud.'],
    decisions: [{ decision: 'silent' }],
  });
  await openChat(page);
  await openVoiceMode(page);
  await waitForListening(page);

  await sendUtterance(page);

  // The user's words are filed, but no reply is generated or spoken.
  await expect(page.getByTestId('voice-transcript-user')).toHaveText(
    'Just thinking out loud.',
  );
  await waitForListening(page);
  await expect(page.getByTestId('voice-transcript-assistant')).toHaveCount(0);
  expect(controls.log.respond).toHaveLength(0);
  expect(controls.log.speak).toHaveLength(0);

  // Closing the session settles the still-pending quiet decision.
  await page.getByTestId('voice-mode-close').click();
  await expect(page.getByTestId('voice-mode-overlay')).toHaveCount(0);
  await expect(() => {
    expect(controls.log.outcomes).toContainEqual({
      decisionId: 'dec-1',
      outcome: 'session_closed',
    });
  }).toPass();

  // The remark still reached the thread.
  await expect(page.getByTestId('message-user')).toHaveText(
    'Just thinking out loud.',
  );
});

test('an acknowledged goodbye winds the session down on its own', async ({
  page,
}) => {
  const controls = await stubVoiceBackend(page, {
    transcripts: ['Good night, Venom.'],
    decisions: [
      { decision: 'acknowledge', windDown: true, acknowledgment: 'Good night.' },
    ],
  });
  await page.addInitScript(() => {
    (window as unknown as { __venomVoiceWindDownMs?: number }).__venomVoiceWindDownMs = 500;
  });
  await openChat(page);
  await openVoiceMode(page);
  await waitForListening(page);

  await sendUtterance(page);

  // The brief closer is spoken through the normal synthesis path and filed.
  await expect(page.getByTestId('voice-transcript-assistant')).toHaveText(
    'Good night.',
  );
  await expect(() => {
    expect(
      controls.log.speak.some((call) => call.text === 'Good night.'),
    ).toBe(true);
  }).toPass();
  expect(controls.log.respond).toHaveLength(0);

  // Sustained quiet eases the session shut — the overlay slips away without
  // the user touching anything.
  await expect(page.getByTestId('voice-mode-overlay')).toHaveCount(0, {
    timeout: 5000,
  });
  await expect(() => {
    expect(controls.log.outcomes).toContainEqual({
      decisionId: 'dec-1',
      outcome: 'wound_down',
    });
  }).toPass();

  // Both sides of the goodbye are in the thread.
  await expect(page.getByTestId('message-user')).toHaveText(
    'Good night, Venom.',
  );
  await expect(page.getByTestId('message-assistant')).toHaveText('Good night.');
});

test('the talkativeness dial rides into the very next restraint decision', async ({
  page,
}) => {
  const controls = await stubVoiceBackend(page, {
    transcripts: ['Interesting.'],
    decisions: [{ decision: 'silent' }],
  });
  await openChat(page);
  await openVoiceMode(page);
  await waitForListening(page);

  await page.getByTestId('voice-preset-chip').click();
  await expect(
    page.getByTestId('voice-talkativeness-control'),
  ).toBeVisible();
  await page.getByTestId('voice-talkativeness-reserved').click();
  await expect(
    page.getByTestId('voice-talkativeness-description'),
  ).toHaveText('Speaks when spoken to. Asides and musings are left alone.');
  await page.getByTestId('voice-picker-close').click();

  await sendUtterance(page);
  await expect(page.getByTestId('voice-transcript-user')).toHaveText(
    'Interesting.',
  );
  await expect(() => {
    expect(controls.log.decide.at(-1)?.talkativeness).toBe('reserved');
  }).toPass();
});

// ── Decision overlap: a slow judge must not delay the reply ──────────────────

/**
 * Holds /voice/decide open until the test releases it — the deterministic
 * stand-in for a judge taking its full budget. Registered after
 * stubVoiceBackend so it wins (Playwright tries the last route first).
 */
async function holdDecide(page: Page) {
  let release: ((body: Record<string, unknown>) => void) | null = null;
  const held = new Promise<Record<string, unknown>>((resolve) => {
    release = resolve;
  });
  const state = { pending: false };
  await page.route('**/api/venom/voice/decide', async (route) => {
    state.pending = true;
    const body = await held;
    state.pending = false;
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(body),
    });
  });
  return {
    state,
    release: (body: Record<string, unknown>) => release?.(body),
  };
}

/** Grace 0 forces the optimistic path (UI-test builds otherwise serialize,
 * since their stubbed decides are instant). */
async function forceDecisionOverlap(page: Page) {
  await page.addInitScript(() => {
    const flags = window as unknown as {
      __venomVoiceDecideGraceMs?: number;
      __venomVoiceDecideTimeoutMs?: number;
    };
    flags.__venomVoiceDecideGraceMs = 0;
    // The held decide must outlive the client's own fail-open abort, or
    // the turn releases itself mid-assertion.
    flags.__venomVoiceDecideTimeoutMs = 30_000;
  });
}

test('a slow decision overlaps with the reply and releases it on respond', async ({
  page,
}) => {
  const controls = await stubVoiceBackend(page, {
    transcripts: ['So how would we actually ship this?'],
    replies: [['Shipping takes two steps. ', 'Cut scope, then cut again.']],
  });
  const decide = await holdDecide(page);
  await forceDecisionOverlap(page);

  await openChat(page);
  await openVoiceMode(page);
  await waitForListening(page);

  await sendUtterance(page);

  // The latency win as an ordering guarantee: the respond stream is already
  // running while the decision is still pending…
  await expect.poll(() => controls.log.respond.length).toBe(1);
  expect(decide.state.pending).toBe(true);
  // …but nothing has surfaced: no live text, no transcript, no speech.
  await expect(page.getByTestId('voice-mode-overlay')).not.toContainText(
    'Shipping',
  );
  await expect(page.getByTestId('voice-transcript-assistant')).toHaveCount(0);
  expect(controls.log.speak).toHaveLength(0);

  // The judge finally says "respond": the held reply surfaces intact.
  decide.release({
    decisionId: 'dec-slow',
    decision: 'respond',
    windDown: false,
  });
  await expect(page.getByTestId('voice-transcript-assistant')).toHaveText(
    'Shipping takes two steps. Cut scope, then cut again.',
  );
  await expect(() => {
    expect(
      controls.log.speak.some((call) =>
        (call.text ?? '').includes('Shipping takes two steps.'),
      ),
    ).toBe(true);
  }).toPass();
  await waitForListening(page);

  // The played-out reply settles the decision like any served turn.
  await expect(() => {
    expect(controls.log.outcomes).toContainEqual({
      decisionId: 'dec-slow',
      outcome: 'reply_completed',
    });
  }).toPass();
});

test('a slow silent decision discards the head start unseen and unheard', async ({
  page,
}) => {
  const controls = await stubVoiceBackend(page, {
    transcripts: ['Yeah, that all tracks.'],
    replies: [['This reply must never surface. ', 'Not a word of it.']],
  });
  const decide = await holdDecide(page);
  await forceDecisionOverlap(page);

  await openChat(page);
  await openVoiceMode(page);
  await waitForListening(page);

  await sendUtterance(page);

  // The head start is real — the respond stream already ran…
  await expect.poll(() => controls.log.respond.length).toBe(1);
  // …while the held turn kept it invisible and unspoken.
  await expect(page.getByTestId('voice-transcript-assistant')).toHaveCount(0);
  expect(controls.log.speak).toHaveLength(0);

  // "Stay quiet" lands: the buffered reply is thrown away wholesale and the
  // session just relaxes back into listening — no announcement.
  decide.release({
    decisionId: 'dec-quiet',
    decision: 'silent',
    windDown: false,
  });
  await waitForListening(page);
  expect(controls.log.speak).toHaveLength(0);
  await expect(page.getByTestId('voice-transcript-assistant')).toHaveCount(0);
  await expect(page.getByTestId('voice-mode-overlay')).not.toContainText(
    'surface',
  );
  // The user's words were filed like any turn.
  await expect(page.getByTestId('voice-transcript-user')).toHaveText(
    'Yeah, that all tracks.',
  );

  // Closing settles the late-registered decision, and the discarded reply
  // never reached the thread.
  await page.getByTestId('voice-mode-close').click();
  await expect(page.getByTestId('voice-mode-overlay')).toHaveCount(0);
  await expect(() => {
    expect(controls.log.outcomes).toContainEqual({
      decisionId: 'dec-quiet',
      outcome: 'session_closed',
    });
  }).toPass();
  await expect(page.getByTestId('message-user')).toHaveText(
    'Yeah, that all tracks.',
  );
  await expect(page.getByTestId('message-assistant')).toHaveCount(0);
});

test('a stream failure while held still bows to a silent decision', async ({
  page,
}) => {
  const controls = await stubVoiceBackend(page, {
    transcripts: ['Mostly musing to myself.'],
  });
  const decide = await holdDecide(page);
  await forceDecisionOverlap(page);
  // Registered after the stub, so it wins: the reply emits a bit of text
  // and then the stream dies without [DONE].
  let respondHit = false;
  await page.route('**/api/venom/respond', async (route) => {
    respondHit = true;
    await route.fulfill({
      status: 200,
      contentType: 'text/event-stream',
      body:
        'data: {"modelId":"test-model","modelName":"Test Model"}\n\n' +
        'data: {"content":"Half a thought that dies mid-"}\n\n',
    });
  });

  await openChat(page);
  await openVoiceMode(page);
  await waitForListening(page);

  await sendUtterance(page);

  // The optimistic stream ran and broke while the decision was pending…
  await expect.poll(() => respondHit).toBe(true);
  // …and the failure is parked, not surfaced: no error notice, no session
  // teardown, no filed half-reply.
  await expect(page.getByTestId('voice-mode-overlay')).toBeVisible();
  await expect(page.getByText(/reply was interrupted/i)).toHaveCount(0);
  await expect(page.getByTestId('voice-transcript-assistant')).toHaveCount(0);

  // "Stay quiet" erases the broken head start — failure and all.
  decide.release({
    decisionId: 'dec-hushed',
    decision: 'silent',
    windDown: false,
  });
  await waitForListening(page);
  await expect(page.getByTestId('voice-transcript-assistant')).toHaveCount(0);
  await expect(page.getByText(/Half a thought/)).toHaveCount(0);
  await expect(page.getByText(/reply was interrupted/i)).toHaveCount(0);
  expect(controls.log.speak).toHaveLength(0);

  // The words were filed; the broken reply and its error never were.
  await page.getByTestId('voice-mode-close').click();
  await expect(page.getByTestId('voice-mode-overlay')).toHaveCount(0);
  await expect(() => {
    expect(controls.log.outcomes).toContainEqual({
      decisionId: 'dec-hushed',
      outcome: 'session_closed',
    });
  }).toPass();
  await expect(page.getByTestId('message-user')).toHaveText(
    'Mostly musing to myself.',
  );
  await expect(page.getByTestId('message-assistant')).toHaveCount(0);
});

test('closing the overlay mid-hold keeps the speculative reply out of the thread', async ({
  page,
}) => {
  const controls = await stubVoiceBackend(page, {
    transcripts: ['Just chewing on the idea.'],
    replies: [['A speculative half reply. ', 'Never legitimized.']],
  });
  const decide = await holdDecide(page);
  await forceDecisionOverlap(page);

  await openChat(page);
  await openVoiceMode(page);
  await waitForListening(page);

  await sendUtterance(page);

  // The head start is running and the judge still hasn't spoken…
  await expect.poll(() => controls.log.respond.length).toBe(1);
  expect(decide.state.pending).toBe(true);

  // …when the user simply closes the overlay.
  await page.getByTestId('voice-mode-close').click();
  await expect(page.getByTestId('voice-mode-overlay')).toHaveCount(0);

  // Only the user's words reached the thread — the held reply died with
  // the session instead of being filed on the way out.
  await expect(page.getByTestId('message-user')).toHaveText(
    'Just chewing on the idea.',
  );
  await expect(page.getByTestId('message-assistant')).toHaveCount(0);
  expect(controls.log.speak).toHaveLength(0);
  expect(controls.log.outcomes).toHaveLength(0);

  // A decision arriving after the close changes nothing.
  decide.release({
    decisionId: 'dec-late',
    decision: 'respond',
    windDown: false,
  });
  await page.waitForTimeout(300);
  await expect(page.getByTestId('message-assistant')).toHaveCount(0);
});
