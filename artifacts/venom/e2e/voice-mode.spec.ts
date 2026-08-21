/**
 * voice-mode.spec.ts — hands-free voice conversation regression suite.
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

type VoiceDecisionStub = {
  decision: "respond" | "acknowledge" | "silent";
  windDown?: boolean;
  acknowledgment?: string;
  /** Server omitted decisionId (row not durable): execute, don't track. */
  untracked?: boolean;
};

type VoiceStubOptions = {
  transcripts?: string[];
  replies?: string[][];
  voiceCatalogStatus?: number;
  /** Per-turn restraint decisions; past the end, every turn responds. */
  decisions?: VoiceDecisionStub[];
  decideStatus?: number;
};

type VoiceStubLog = {
  transcribeCalls: number;
  speakBodies: Array<{ text: string; presetId: string }>;
  respondBodies: Array<{ message?: string; conversationId?: string }>;
  decideBodies: Array<{
    transcript?: string;
    recentTurns?: Array<{ role: string; content: string }>;
    talkativeness?: string;
  }>;
  outcomeBodies: Array<{ decisionId?: string; outcome?: string }>;
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
    decideBodies: [],
    outcomeBodies: [],
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
  await page.route("**/api/venom/voice/decide", (route) => {
    const turn = log.decideBodies.length;
    log.decideBodies.push(
      route.request().postDataJSON() as VoiceStubLog["decideBodies"][number],
    );
    if ((options.decideStatus ?? 200) !== 200) {
      return route.fulfill({
        status: options.decideStatus,
        contentType: "application/json",
        body: JSON.stringify({ error: "Decide unavailable." }),
      });
    }
    const stub = options.decisions?.[turn] ?? { decision: "respond" as const };
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        ...(stub.untracked ? {} : { decisionId: `decision-${turn + 1}` }),
        decision: stub.decision,
        windDown: stub.windDown ?? false,
        ...(stub.acknowledgment
          ? { acknowledgment: stub.acknowledgment }
          : {}),
      }),
    });
  });
  await page.route("**/api/venom/voice/decision-outcome", (route) => {
    log.outcomeBodies.push(
      route.request().postDataJSON() as VoiceStubLog["outcomeBodies"][number],
    );
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ recorded: true }),
    });
  });

  return log;
}

function captureState(page: Page) {
  return page.evaluate(
    () =>
      (window as unknown as { __venomVoiceCaptureState?: string })
        .__venomVoiceCaptureState ?? "unset",
  );
}

function speakUtterance(page: Page, durationMs = 1_500) {
  return page.evaluate((duration) => {
    window.dispatchEvent(
      new CustomEvent("venom-voice:utterance", {
        detail: { durationMs: duration },
      }),
    );
  }, durationMs);
}

test.beforeEach(({}, testInfo) => {
  test.skip(
    testInfo.project.name === "desktop-chromium",
    "Voice mode ships on the mobile app; the mobile viewport covers it.",
  );
});

test("hands-free loop: two spoken turns land in the conversation", async ({
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

  // The session begins listening on its own — no tap needed.
  await expect.poll(() => captureState(page)).toBe("listening");
  await expect(page.getByTestId("voice-status")).toHaveText("listening");

  // Turn one: the user talks; the bot replies out loud and keeps listening.
  await speakUtterance(page);
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

  // The loop resumed by itself after the reply finished.
  await expect.poll(() => captureState(page)).toBe("listening");

  // Turn two: no tapping in between.
  await speakUtterance(page);
  await expect(
    page.getByTestId("voice-transcript-assistant").nth(1),
  ).toContainText("One task is blocked on review.");
  await expect.poll(() => captureState(page)).toBe("listening");
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
  await expect.poll(() => captureState(page)).toBe("listening");

  await speakUtterance(page);
  await expect(page.getByTestId("voice-status")).toContainText(
    "Sam is speaking",
  );

  // Interrupt mid-sentence: the user takes their turn back.
  await page.getByTestId("voice-orb-press").click();
  await expect
    .poll(() => captureState(page), { timeout: 10_000 })
    .toBe("listening");

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
  await expect.poll(() => captureState(page)).toBe("listening");

  // The spoken reply uses the chosen voice.
  await speakUtterance(page);
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

  // The server comes back; Try again resumes hands-free listening.
  await page.route("**/api/venom/voice/catalog", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(voiceCatalog),
    }),
  );
  await page.getByTestId("voice-error-retry").click();
  await expect.poll(() => captureState(page)).toBe("listening");
  await expect(page.getByTestId("voice-error-panel")).toHaveCount(0);

  // And the loop actually works after recovery.
  await speakUtterance(page);
  await expect(page.getByTestId("voice-transcript-assistant")).toContainText(
    "This board has three stages.",
  );
  expect(log.transcribeCalls).toBe(1);
});

// ── Conversational restraint ─────────────────────────────────────────────────

test("a trailing remark gets silence: filed, unanswered, still listening", async ({
  page,
}) => {
  const log = await stubVoiceBackend(page, {
    transcripts: ["okay yeah, makes sense"],
    decisions: [{ decision: "silent" }],
  });

  await page.goto("/");
  await page.getByTestId("open-voice-mode").click();
  await expect.poll(() => captureState(page)).toBe("listening");

  await speakUtterance(page);

  // The words are filed like any turn…
  await expect(
    page.getByTestId("voice-transcript-user").first(),
  ).toContainText("okay yeah, makes sense");
  await expect(page.getByTestId("voice-live-user")).toHaveCount(0);

  // …but nothing is generated or spoken, and there's no "I chose not to
  // answer" announcement — the session just relaxes back into listening.
  await expect.poll(() => captureState(page)).toBe("listening");
  await expect(page.getByTestId("voice-status")).toHaveText("listening");
  expect(log.decideBodies.length).toBe(1);
  expect(log.decideBodies[0].transcript).toBe("okay yeah, makes sense");
  expect(log.decideBodies[0].talkativeness).toBe("balanced");
  expect(log.respondBodies.length).toBe(0);
  expect(log.speakBodies.length).toBe(0);
  await expect(page.getByTestId("voice-transcript-assistant")).toHaveCount(0);

  // Ending the session settles the decision's outcome for the training log.
  await page.getByTestId("voice-mode-close").click();
  await expect.poll(() => log.outcomeBodies.length).toBe(1);
  expect(log.outcomeBodies[0]).toEqual({
    decisionId: "decision-1",
    outcome: "session_closed",
  });
});

test("a silent decision without an id is still honored, just untracked", async ({
  page,
}) => {
  // When the server can't make the decision row durable in time it omits
  // the id. Restraint must still hold — the danger is regressing to a full
  // reply whenever logging is slow.
  const log = await stubVoiceBackend(page, {
    transcripts: ["hm, right"],
    decisions: [{ decision: "silent", untracked: true }],
  });

  await page.goto("/");
  await page.getByTestId("open-voice-mode").click();
  await expect.poll(() => captureState(page)).toBe("listening");

  await speakUtterance(page);

  await expect(
    page.getByTestId("voice-transcript-user").first(),
  ).toContainText("hm, right");
  await expect.poll(() => captureState(page)).toBe("listening");
  expect(log.respondBodies.length).toBe(0);
  expect(log.speakBodies.length).toBe(0);
  await expect(page.getByTestId("voice-transcript-assistant")).toHaveCount(0);

  // No id was issued for this turn, so ending the session reports nothing.
  await page.getByTestId("voice-mode-close").click();
  await page.waitForTimeout(400);
  expect(log.outcomeBodies.length).toBe(0);
});

test("a goodbye gets a short closer and the session eases itself closed", async ({
  page,
}) => {
  const log = await stubVoiceBackend(page, {
    transcripts: ["alright, good night venom"],
    decisions: [
      {
        decision: "acknowledge",
        windDown: true,
        acknowledgment: "Good night.",
      },
    ],
  });

  await page.goto("/");
  // Shrink the quiet period so the test doesn't sit through 16 seconds.
  await page.evaluate(() => {
    (
      window as unknown as { __venomVoiceWindDownMs?: number }
    ).__venomVoiceWindDownMs = 600;
  });
  await page.getByTestId("open-voice-mode").click();
  await expect.poll(() => captureState(page)).toBe("listening");

  await speakUtterance(page);

  // The closer goes through the voice pipe — no full reply is generated.
  await expect
    .poll(() => log.speakBodies.map((body) => body.text))
    .toContain("Good night.");

  // After sustained quiet the session slips away on its own — no tap,
  // no "are you still there?".
  await expect(page.getByTestId("voice-mode-overlay")).toHaveCount(0, {
    timeout: 10_000,
  });
  expect(log.respondBodies.length).toBe(0);
  await expect
    .poll(() => log.outcomeBodies.map((body) => body.outcome))
    .toContain("wound_down");

  // The exchange survives as real messages in the chat thread.
  const chat = page.getByTestId("workspace-chat");
  await expect(chat.getByText("alright, good night venom")).toBeVisible();
  await expect(chat.getByText("Good night.")).toBeVisible();
});

test("speaking again cancels a wind-down before it closes the session", async ({
  page,
}) => {
  const log = await stubVoiceBackend(page, {
    transcripts: ["okay cool", "actually, one more question"],
    replies: [["Go ahead — what's on your mind?"]],
    decisions: [{ decision: "silent", windDown: true }, { decision: "respond" }],
  });

  await page.goto("/");
  await page.evaluate(() => {
    (
      window as unknown as { __venomVoiceWindDownMs?: number }
    ).__venomVoiceWindDownMs = 2_000;
  });
  await page.getByTestId("open-voice-mode").click();
  await expect.poll(() => captureState(page)).toBe("listening");

  // A wind-down starts its quiet-close clock…
  await speakUtterance(page);
  await expect(
    page.getByTestId("voice-transcript-user").first(),
  ).toContainText("okay cool");
  await expect.poll(() => captureState(page)).toBe("listening");

  // …but the user re-engages before it runs out.
  await speakUtterance(page);
  await expect(page.getByTestId("voice-transcript-assistant")).toContainText(
    "Go ahead",
  );

  // The quiet decision reads as "the user had to follow up".
  await expect
    .poll(() => log.outcomeBodies.map((body) => body.outcome))
    .toContain("user_followed_up");

  // Well past the original horizon, the session is still here and listening.
  await page.waitForTimeout(2_500);
  await expect(page.getByTestId("voice-mode-overlay")).toBeVisible();
  await expect.poll(() => captureState(page)).toBe("listening");
});

test("restraint failing open: a decide error still gets a full reply", async ({
  page,
}) => {
  const log = await stubVoiceBackend(page, {
    transcripts: ["thanks a lot"],
    decideStatus: 500,
  });

  await page.goto("/");
  await page.getByTestId("open-voice-mode").click();
  await expect.poll(() => captureState(page)).toBe("listening");

  await speakUtterance(page);
  await expect(page.getByTestId("voice-transcript-assistant")).toContainText(
    "This board has three stages.",
  );
  expect(log.decideBodies.length).toBe(1);
  expect(log.respondBodies.length).toBe(1);

  // No decision was issued, so there is nothing to report.
  await page.getByTestId("voice-mode-close").click();
  await page.waitForTimeout(300);
  expect(log.outcomeBodies.length).toBe(0);
});

test("talkativeness dial rides the picker sheet into decide calls", async ({
  page,
}) => {
  const log = await stubVoiceBackend(page, {
    transcripts: ["hm, interesting"],
  });

  await page.goto("/");
  await page.getByTestId("open-voice-mode").click();
  await expect.poll(() => captureState(page)).toBe("listening");

  // The dial sits beside the voice picker, with plain-language copy.
  await page.getByTestId("voice-preset-chip").click();
  await expect(page.getByTestId("voice-picker-sheet")).toBeVisible();
  await expect(page.getByTestId("voice-talkativeness-control")).toBeVisible();
  await expect(
    page.getByTestId("voice-talkativeness-description"),
  ).toContainText(/real questions/i);
  await page.getByTestId("voice-talkativeness-reserved").click();
  await expect(
    page.getByTestId("voice-talkativeness-description"),
  ).toContainText(/spoken to/i);
  await page.getByTestId("voice-picker-close").click();

  // The next turn's decision request carries the new level.
  await speakUtterance(page);
  await expect.poll(() => log.decideBodies.length).toBe(1);
  expect(log.decideBodies[0].talkativeness).toBe("reserved");

  // The same preference shows up in Settings — one synced value.
  await page.getByTestId("voice-mode-close").click();
  await page.getByTestId("open-settings").click();
  await expect(page.getByTestId("voice-talkativeness-control")).toBeVisible();
  await expect(
    page.getByTestId("voice-talkativeness-description"),
  ).toContainText(/spoken to/i);
});
