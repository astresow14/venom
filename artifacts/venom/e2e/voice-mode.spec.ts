/**
 * voice-mode.spec.ts — tap-to-talk voice conversation regression suite.
 *
 * UI-test mode swaps the platform audio layer for a deterministic harness
 * (audio/voiceTestHarness.ts): tests drive the microphone with window events
 * and read playback activity from a window-scoped log. Every backend call is
 * stubbed with page.route — no API server runs in CI.
 */

import { expect, test, type Page } from "@playwright/test";

const modelCatalog = [
  {
    id: "venom-gpt",
    provider: "openai",
    name: "Venom GPT",
    family: "GPT",
    summary: "OpenAI managed model",
    available: true,
    availabilityText: "Ready",
  },
];

const voiceCatalog = [
  ["sam", "Sam", "Even-keeled and clear", "neutral"],
  ["marcus", "Marcus", "Warm and deliberate", "masculine"],
  ["rowan", "Rowan", "Bright storyteller", "neutral"],
  ["elijah", "Elijah", "Low and steady", "masculine"],
  ["maya", "Maya", "Quick and encouraging", "feminine"],
  ["isla", "Isla", "Soft and precise", "feminine"],
].map(([id, name, persona, tone]) => ({
  id,
  name,
  persona,
  tone,
  sampleText: `Hey, I'm ${name}.`,
  available: true,
  availabilityText: "Ready",
}));

function sseBody(events: Array<Record<string, unknown> | "[DONE]">): string {
  return (
    events
      .map((event) =>
        event === "[DONE]"
          ? "data: [DONE]"
          : `data: ${JSON.stringify(event)}`,
      )
      .join("\n\n") + "\n\n"
  );
}

const speakChunk = Buffer.from("fake-pcm16-audio").toString("base64");

type VoiceStubOptions = {
  transcripts?: string[];
  replies?: string[][];
  voiceCatalogStatus?: number;
};

type VoiceStubLog = {
  transcribeCalls: number;
  speakBodies: Array<{ text: string; presetId: string }>;
  respondBodies: Array<{ message?: string; conversationId?: string }>;
};

/** Stubs every backend call the voice loop makes and records what it sends. */
async function stubVoiceBackend(
  page: Page,
  options: VoiceStubOptions = {},
): Promise<VoiceStubLog> {
  const log: VoiceStubLog = {
    transcribeCalls: 0,
    speakBodies: [],
    respondBodies: [],
  };
  const transcripts = options.transcripts ?? ["What is on the board?"];
  const replies = options.replies ?? [
    ["This board has three stages. ", "Everything is on track."],
  ];

  await page.route("**/api/venom/models", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(modelCatalog),
    }),
  );
  await page.route("**/api/venom/voice/catalog", (route) => {
    if ((options.voiceCatalogStatus ?? 200) !== 200) {
      return route.fulfill({
        status: options.voiceCatalogStatus,
        contentType: "application/json",
        body: JSON.stringify({
          error: "Voice is not configured.",
          code: "voice_unavailable",
        }),
      });
    }
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(voiceCatalog),
    });
  });
  await page.route("**/api/venom/voice/transcribe", (route) => {
    const text =
      transcripts[Math.min(log.transcribeCalls, transcripts.length - 1)];
    log.transcribeCalls += 1;
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ text }),
    });
  });
  await page.route("**/api/venom/respond", (route) => {
    const body = route.request().postDataJSON() as {
      message?: string;
      conversationId?: string;
    };
    log.respondBodies.push(body);
    const turn = Math.min(log.respondBodies.length - 1, replies.length - 1);
    return route.fulfill({
      status: 200,
      headers: {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
      },
      body: sseBody([
        { modelId: "venom-gpt", modelName: "Venom GPT" },
        ...replies[turn].map((content) => ({ content })),
        { done: true },
      ]),
    });
  });
  await page.route("**/api/venom/voice/speak", (route) => {
    log.speakBodies.push(
      route.request().postDataJSON() as { text: string; presetId: string },
    );
    return route.fulfill({
      status: 200,
      headers: {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
      },
      body: sseBody([
        { format: { encoding: "pcm16", sampleRate: 24_000, channels: 1 } },
        { audio: speakChunk },
        { audio: speakChunk },
        { done: true },
        "[DONE]",
      ]),
    });
  });
  await page.route("**/api/venom/knowledge/extract", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ clusters: [] }),
    }),
  );

  return log;
}

function captureState(page: Page) {
  return page.evaluate(
    () =>
      (window as unknown as { __venomVoiceCaptureState?: string })
        .__venomVoiceCaptureState ?? "unset",
  );
}

async function recordUtterance(page: Page) {
  const orb = page.getByTestId("voice-orb-press");
  await orb.click();
  await expect.poll(() => captureState(page)).toBe("listening");
  await expect(orb).toHaveAttribute("aria-label", "Stop recording and send");
  await orb.click();
}

test.beforeEach(({}, testInfo) => {
  test.skip(
    testInfo.project.name === "desktop-chromium",
    "Voice mode ships on the mobile app; the mobile viewport covers it.",
  );
});

test("tap-to-talk: two explicit recordings land in the conversation", async ({
  page,
}) => {
  const log = await stubVoiceBackend(page, {
    transcripts: ["What is on the board?", "Anything blocked right now?"],
    replies: [
      ["The board has three stages. ", "Nothing is overdue."],
      ["One task is blocked on review. ", "Everything else moves."],
    ],
  });

  await page.goto("/");
  await page.getByTestId("open-voice-mode").click();
  await expect(page.getByTestId("voice-mode-overlay")).toBeVisible();

  // The session prepares quietly; the user explicitly starts each recording.
  await expect.poll(() => captureState(page)).toBe("idle");
  await expect(page.getByTestId("voice-status")).toHaveText("tap to talk");
  await expect(page.getByTestId("voice-orb-press")).toHaveAttribute(
    "aria-label",
    "Start recording",
  );

  // Turn one: tap once to record and once to send.
  await recordUtterance(page);
  await expect(
    page.getByTestId("voice-transcript-user").first(),
  ).toContainText("What is on the board?");
  // Once the utterance is in the transcript, the live bubble must clear —
  // the same words must never show twice.
  await expect(page.getByTestId("voice-live-user")).toHaveCount(0);
  await expect(page.getByTestId("voice-transcript-assistant")).toContainText(
    "The board has three stages. Nothing is overdue.",
  );
  // Speech was streamed sentence-by-sentence, starting with the first one.
  expect(log.speakBodies.length).toBeGreaterThanOrEqual(1);
  expect(log.speakBodies[0].presetId).toBe("sam");
  expect(log.speakBodies[0].text).toContain("The board has three stages.");

  // The mic stays paused after the reply; nothing records without a tap.
  await expect.poll(() => captureState(page)).toBe("paused");
  await expect(page.getByTestId("voice-status")).toHaveText("tap to talk");

  // Turn two is another deliberate press-to-record / press-to-send action.
  await recordUtterance(page);
  await expect(
    page.getByTestId("voice-transcript-assistant").nth(1),
  ).toContainText("One task is blocked on review.");
  await expect.poll(() => captureState(page)).toBe("paused");
  expect(log.transcribeCalls).toBe(2);

  // Exit voice mode: both turns are real messages in the chat thread.
  await page.getByTestId("voice-mode-close").click();
  await expect(page.getByTestId("voice-mode-overlay")).toHaveCount(0);
  const chat = page.getByTestId("workspace-chat");
  await expect(chat.getByText("What is on the board?")).toBeVisible();
  await expect(
    chat.getByText("The board has three stages. Nothing is overdue."),
  ).toBeVisible();
  await expect(chat.getByText("Anything blocked right now?")).toBeVisible();
  await expect(
    chat.getByText("One task is blocked on review. Everything else moves."),
  ).toBeVisible();
});

test("a short tap returns to ready and the next recording still sends", async ({
  page,
}) => {
  const log = await stubVoiceBackend(page);

  await page.goto("/");
  await page.getByTestId("open-voice-mode").click();
  const orb = page.getByTestId("voice-orb-press");
  await expect.poll(() => captureState(page)).toBe("idle");

  // Both production adapters pause as soon as a recording finishes. Make the
  // test harness do the same, then prove a too-short clip cannot leave the
  // record button trying to finish an already paused recorder.
  await page.evaluate(() => {
    (
      window as unknown as {
        __venomVoiceNextUtterance?: { durationMs: number };
      }
    ).__venomVoiceNextUtterance = { durationMs: 100 };
  });
  await orb.click();
  await expect.poll(() => captureState(page)).toBe("listening");
  await orb.click();

  await expect.poll(() => captureState(page)).toBe("paused");
  await expect(page.getByTestId("voice-status")).toHaveText("tap to talk");
  await expect(page.getByTestId("voice-notice")).toContainText(
    /too short.*try again/i,
  );
  expect(log.transcribeCalls).toBe(0);

  await recordUtterance(page);
  await expect(page.getByTestId("voice-transcript-user")).toContainText(
    "What is on the board?",
  );
  expect(log.transcribeCalls).toBe(1);
});

test("tapping the orb interrupts the reply and files what was said", async ({
  page,
}) => {
  await stubVoiceBackend(page, {
    transcripts: ["Give me the long version"],
    replies: [["Here is a very long explanation. ", "It keeps going forever."]],
  });

  await page.goto("/");
  // Playback holds until released, so 'speaking' stays observable.
  await page.evaluate(() => {
    (window as unknown as { __venomVoiceHoldPlayback?: boolean })
      .__venomVoiceHoldPlayback = true;
  });

  await page.getByTestId("open-voice-mode").click();
  await expect.poll(() => captureState(page)).toBe("idle");

  await recordUtterance(page);
  await expect(page.getByTestId("voice-status")).toContainText(
    "Sam is speaking",
  );

  // Interrupt mid-sentence: no new recording begins automatically.
  await page.getByTestId("voice-orb-press").click();
  await expect
    .poll(() => captureState(page), { timeout: 10_000 })
    .toBe("paused");
  await expect(page.getByTestId("voice-status")).toHaveText("tap to talk");

  // What was already said is kept as the assistant turn.
  await expect(page.getByTestId("voice-transcript-assistant")).toContainText(
    "Here is a very long explanation.",
  );

  await page.getByTestId("voice-mode-close").click();
  const chat = page.getByTestId("workspace-chat");
  await expect(
    chat.getByText(/Here is a very long explanation\./),
  ).toBeVisible();
});

test("voice presets: samples play, selection follows into voice mode", async ({
  page,
}) => {
  const log = await stubVoiceBackend(page);

  await page.goto("/");
  await page.getByTestId("open-settings").click();
  await expect(page.getByTestId("voice-settings-section")).toBeVisible();

  // All six named presets are offered.
  for (const preset of voiceCatalog) {
    await expect(page.getByTestId(`voice-preset-${preset.id}`)).toBeVisible();
  }

  // Tap-to-hear: the sample request speaks as that preset.
  await page.getByTestId("voice-preview-maya").click();
  await expect
    .poll(() => log.speakBodies.map((body) => body.presetId))
    .toContain("maya");
  expect(
    log.speakBodies.find((body) => body.presetId === "maya")?.text,
  ).toContain("Maya");

  // Pick Isla; the choice rides workspace state into voice mode.
  await page.getByTestId("voice-preset-isla").click();
  await page.goBack();
  await page.getByTestId("open-voice-mode").click();
  await expect(page.getByTestId("voice-preset-chip")).toContainText("Isla");
  await expect.poll(() => captureState(page)).toBe("idle");

  // The spoken reply uses the chosen voice.
  await recordUtterance(page);
  await expect
    .poll(() => log.speakBodies.map((body) => body.presetId))
    .toContain("isla");

  // The picker is also reachable inside voice mode.
  await page.getByTestId("voice-preset-chip").click();
  await expect(page.getByTestId("voice-picker-sheet")).toBeVisible();
  await expect(page.getByTestId("voice-preset-maya")).toBeVisible();
  await page.getByTestId("voice-picker-close").click();
  await expect(page.getByTestId("voice-picker-sheet")).toHaveCount(0);
});

test("mic permission denied explains itself and falls back to text", async ({
  page,
}) => {
  await stubVoiceBackend(page);

  await page.goto("/");
  await page.evaluate(() => {
    (window as unknown as { __venomVoiceDenyMic?: boolean })
      .__venomVoiceDenyMic = true;
  });

  await page.getByTestId("open-voice-mode").click();
  await expect(page.getByTestId("voice-status")).toHaveText("tap to talk");
  await page.getByTestId("voice-orb-press").click();
  await expect(page.getByTestId("voice-error-panel")).toBeVisible();
  await expect(page.getByTestId("voice-error-message")).toContainText(
    /microphone access is off/i,
  );

  // "Back to text" lands the user in the normal composer, not a dead end.
  await page.getByTestId("voice-error-exit").click();
  await expect(page.getByTestId("voice-mode-overlay")).toHaveCount(0);
  await expect(page.getByTestId("chat-input")).toBeVisible();
});

test("voice not configured surfaces quietly and retry recovers", async ({
  page,
}) => {
  const log = await stubVoiceBackend(page, { voiceCatalogStatus: 503 });

  await page.goto("/");
  await page.getByTestId("open-voice-mode").click();

  await expect(page.getByTestId("voice-error-panel")).toBeVisible();
  await expect(page.getByTestId("voice-error-message")).toContainText(
    /not configured/i,
  );

  // The server comes back; Try again restores the ready-to-record state.
  await page.route("**/api/venom/voice/catalog", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(voiceCatalog),
    }),
  );
  await page.getByTestId("voice-error-retry").click();
  await expect.poll(() => captureState(page)).toBe("idle");
  await expect(page.getByTestId("voice-error-panel")).toHaveCount(0);

  // And the loop actually works after recovery.
  await recordUtterance(page);
  await expect(page.getByTestId("voice-transcript-assistant")).toContainText(
    "This board has three stages.",
  );
  expect(log.transcribeCalls).toBe(1);
});
