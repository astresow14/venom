import { expect, test, type Page } from "@playwright/test";

/**
 * Verify mode on the mobile chat: the composer's mode switch selects it, the
 * blend pad shows the persona corners when only one real model is enabled,
 * the turn converges into one collective answer with the split flagged, and
 * the individual takes stay readable with citations resolved — never raw
 * [source:id] markers. Talk stays byte-identical with today's requests.
 *
 * The in-progress chamber is asserted by replaying the stream with real
 * delays. `page.route` fulfills atomically, so the streaming tests produce
 * the body inside the page by wrapping `window.fetch` from an init script.
 * That trick holds for this client because `expo/fetch` on web re-exports
 * `globalThis.fetch` at module evaluation, which happens after init scripts
 * run — the wrapper captures the override.
 */

const catalog = [
  {
    id: "venom-gpt",
    name: "Venom GPT",
    provider: "openai",
    description: "Managed default",
    available: true,
    managed: true,
    isDefault: true,
  },
];

const roster = [
  {
    voiceId: "direct",
    name: "First take",
    tagline: "Answers head-on",
    modelId: "venom-gpt",
    modelName: "Venom GPT",
  },
  {
    voiceId: "skeptic",
    name: "Skeptic",
    tagline: "Pokes holes",
    modelId: "venom-gpt",
    modelName: "Venom GPT",
  },
  {
    voiceId: "evidence",
    name: "Evidence",
    tagline: "Sticks to sources",
    modelId: "venom-gpt",
    modelName: "Venom GPT",
  },
];

const DIRECT_TAKE = "Ship the migration now; the risk is small.";
const EVIDENCE_TAKE = "The runbook [source:src-live] says staging first.";
const DISAGREEMENT =
  "First take wants to ship now; Evidence insists on staging first.";
const COLLECTIVE = "Collective answer: stage it first, then ship.";

const rosterEvent = {
  modelId: "venom-gpt",
  modelName: "Venom GPT",
  deliberation: { voices: roster },
};

const finalDeliberationEvent = {
  deliberation: {
    voices: [
      {
        voiceId: "direct",
        name: "First take",
        modelId: "venom-gpt",
        modelName: "Venom GPT",
        content: DIRECT_TAKE,
        status: "ok",
      },
      {
        voiceId: "skeptic",
        name: "Skeptic",
        modelId: "venom-gpt",
        modelName: "Venom GPT",
        content: "",
        status: "failed",
      },
      {
        voiceId: "evidence",
        name: "Evidence",
        modelId: "venom-gpt",
        modelName: "Venom GPT",
        content: EVIDENCE_TAKE,
        status: "ok",
      },
    ],
    disagreements: [DISAGREEMENT],
  },
};

const deliberationEvents = [
  rosterEvent,
  { voice: "direct", content: DIRECT_TAKE },
  { voice: "direct", voiceStatus: "ok" },
  { voice: "skeptic", voiceStatus: "failed" },
  { voice: "evidence", content: EVIDENCE_TAKE },
  { voice: "evidence", voiceStatus: "ok" },
  { stage: "synthesis" },
  { content: COLLECTIVE },
  finalDeliberationEvent,
  { done: true },
];

/**
 * The same turn as [delay, payload] tuples for the streaming replayer. Two
 * long gaps hold the interesting states open: one while the skeptic is still
 * forming (streaming takes + breathing dots on screen), one after synthesis
 * begins (header flipped, voice cards dimmed).
 */
const streamedDeliberationEvents: Array<[number, unknown]> = [
  [0, rosterEvent],
  [700, { voice: "direct", content: DIRECT_TAKE }],
  [350, { voice: "evidence", content: EVIDENCE_TAKE }],
  [350, { voice: "direct", voiceStatus: "ok" }],
  [4200, { voice: "skeptic", voiceStatus: "failed" }],
  [1200, { voice: "evidence", voiceStatus: "ok" }],
  [400, { stage: "synthesis" }],
  [2600, { content: COLLECTIVE }],
  [300, finalDeliberationEvent],
  [200, { done: true }],
];

function sseBody(events: unknown[]): string {
  return events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("");
}

type RespondBody = {
  mode?: string;
  blend?: Array<{ id: string; weight: number }>;
  deliberate?: boolean;
};

async function mockModels(page: Page) {
  await page.route("**/api/venom/models", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(catalog),
    });
  });
}

async function mockDeliberationAvailability(page: Page) {
  await page.route("**/api/venom/deliberation", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        available: true,
        mode: "personas",
        voices: roster.map(({ voiceId, name, tagline }) => ({
          voiceId,
          name,
          tagline,
        })),
      }),
    });
  });
}

async function mockKnowledgeExtraction(page: Page) {
  await page.route("**/api/venom/knowledge/extract", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ clusters: [] }),
    });
  });
}

/**
 * Replays SSE events with real delays so the in-progress deliberation panel
 * stays on screen long enough to assert. `page.route` fulfills atomically,
 * so the stream is produced inside the page by wrapping `window.fetch`; the
 * app reads it through `expo/fetch`, which is `globalThis.fetch` on web.
 */
async function mockStreamingRespond(
  page: Page,
  events: Array<[number, unknown]>,
) {
  await page.addInitScript((scripted: Array<[number, unknown]>) => {
    const originalFetch = window.fetch.bind(window);
    window.fetch = (async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ): Promise<Response> => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : input.url;
      if (!url.includes("/api/venom/respond")) {
        return originalFetch(input as RequestInfo, init);
      }
      const encoder = new TextEncoder();
      const stream = new ReadableStream<Uint8Array>({
        async start(controller) {
          for (const [delay, payload] of scripted) {
            await new Promise((resolve) => setTimeout(resolve, delay));
            controller.enqueue(
              encoder.encode(`data: ${JSON.stringify(payload)}\n\n`),
            );
          }
          controller.close();
        },
      });
      return new Response(stream, {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      });
    }) as typeof window.fetch;
  }, events);
}

/** Selects Verify on the composer's mode switch, then sends one message. */
async function armAndSend(page: Page) {
  const verifyOption = page.getByTestId("mode-option-verify");
  await expect(verifyOption).toBeVisible();
  await verifyOption.click();
  await expect(verifyOption).toHaveAttribute("aria-checked", "true");
  await page.getByTestId("chat-input").fill("Should we ship the migration?");
  await page.getByTestId("send-message-button").click();
}

test("holds the chamber open on the phone: voices stream, one fails, synthesis dims", async ({
  page,
}, testInfo) => {
  test.skip(
    testInfo.project.name === "desktop-chromium",
    "The mobile deliberation journey is covered at the mobile viewport.",
  );

  await mockModels(page);
  await mockDeliberationAvailability(page);
  await mockKnowledgeExtraction(page);
  await mockStreamingRespond(page, streamedDeliberationEvents);

  // Emulate reduced motion on the page and prove it applied — `test.use`
  // silently ignores the option in this Playwright version.
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/");
  expect(
    await page.evaluate(
      () => window.matchMedia("(prefers-reduced-motion: reduce)").matches,
    ),
  ).toBe(true);

  await armAndSend(page);

  // The chamber opens with every voice named and still forming.
  const panel = page.getByTestId("deliberation-panel");
  await expect(panel).toBeVisible();
  await expect(panel).toContainText("Verifying");
  await expect(panel).toContainText("3 voices are checking the question");
  const skepticCard = page.getByTestId("deliberation-voice-skeptic");
  await expect(skepticCard).toContainText("Skeptic");
  await expect(skepticCard).toContainText("Forming a take…");

  // Takes stream into their cards; citations resolve even mid-stream.
  const directCard = page.getByTestId("deliberation-voice-direct");
  await expect(directCard).toContainText("First take");
  await expect(directCard).toContainText("Ship the migration");
  const evidenceCard = page.getByTestId("deliberation-voice-evidence");
  await expect(evidenceCard).toContainText("Evidence");
  await expect(evidenceCard).toContainText("(archived source)");
  await expect(evidenceCard).not.toContainText("[source:");

  // Reduced motion is honored: the breathing dot settles instead of pulsing.
  const skepticDot = page.getByTestId("deliberation-dot-skeptic");
  await expect
    .poll(async () =>
      skepticDot.evaluate((el) => Number(getComputedStyle(el).opacity)),
    )
    .toBeGreaterThan(0.85);
  const samples: number[] = [];
  for (let i = 0; i < 3; i += 1) {
    samples.push(
      await skepticDot.evaluate((el) => Number(getComputedStyle(el).opacity)),
    );
    if (i < 2) await page.waitForTimeout(400);
  }
  for (const sample of samples) {
    expect(Math.abs(sample - samples[0])).toBeLessThan(0.02);
  }

  const panelBox = await panel.boundingBox();
  await page.screenshot({
    path: testInfo.outputPath("chamber-voices-light.png"),
  });

  // A dead voice is marked, and the turn keeps going without it.
  await expect(skepticCard).toContainText(
    "Didn't finish — the others carry on.",
  );

  // Convergence: the header flips and the voice cards dim together.
  await expect(panel).toContainText("Converging");
  await expect(panel).toContainText("merging into one answer");
  await expect(directCard).toHaveCSS("opacity", "0.65");
  await expect(skepticCard).toHaveCSS("opacity", "0.65");
  await page.screenshot({
    path: testInfo.outputPath("chamber-synthesis-light.png"),
  });

  // The turn still ends as one collective answer with the split flagged.
  const chatWorkspace = page.getByTestId("workspace-chat");
  await expect(chatWorkspace.getByText(COLLECTIVE)).toBeVisible();
  await expect(page.getByTestId("deliberation-panel")).toHaveCount(0);
  await expect(page.getByTestId("deliberation-disagreements")).toContainText(
    DISAGREEMENT,
  );

  // Inverted-list header placement: the transient chamber shares a column
  // with the persisted result — no sideways jump when one becomes the other.
  const resultBox = await page
    .getByTestId("deliberation-result")
    .boundingBox();
  expect(panelBox).not.toBeNull();
  expect(resultBox).not.toBeNull();
  expect(Math.abs((panelBox?.x ?? 0) - (resultBox?.x ?? 0))).toBeLessThanOrEqual(
    1.5,
  );
});

test("keeps the live chamber on the dark palette with reduced motion honored", async ({
  page,
}, testInfo) => {
  test.skip(
    testInfo.project.name === "desktop-chromium",
    "The mobile deliberation journey is covered at the mobile viewport.",
  );

  await mockModels(page);
  await mockDeliberationAvailability(page);
  await mockKnowledgeExtraction(page);
  await mockStreamingRespond(page, streamedDeliberationEvents);

  await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
  await page.goto("/");
  expect(
    await page.evaluate(() => ({
      dark: window.matchMedia("(prefers-color-scheme: dark)").matches,
      reduced: window.matchMedia("(prefers-reduced-motion: reduce)").matches,
    })),
  ).toEqual({ dark: true, reduced: true });

  await armAndSend(page);

  const panel = page.getByTestId("deliberation-panel");
  await expect(panel).toBeVisible();
  await expect(page.getByTestId("deliberation-voice-direct")).toContainText(
    "Ship the migration",
  );

  // The chamber picked up the dark card surface, not the light one.
  const background = await panel.evaluate(
    (el) => getComputedStyle(el).backgroundColor,
  );
  const channels = background.match(/\d+/g)?.map(Number) ?? [];
  expect(channels.length).toBeGreaterThanOrEqual(3);
  for (const channel of channels.slice(0, 3)) {
    expect(channel).toBeLessThan(64);
  }

  // Reduced motion still pins the dots in the dark theme.
  const skepticDot = page.getByTestId("deliberation-dot-skeptic");
  await expect
    .poll(async () =>
      skepticDot.evaluate((el) => Number(getComputedStyle(el).opacity)),
    )
    .toBeGreaterThan(0.85);

  await page.screenshot({
    path: testInfo.outputPath("chamber-voices-dark.png"),
  });

  await expect(panel).toContainText("Converging");
  await expect(page.getByTestId("deliberation-voice-direct")).toHaveCSS(
    "opacity",
    "0.65",
  );
  await page.screenshot({
    path: testInfo.outputPath("chamber-synthesis-dark.png"),
  });

  // Let the turn finish so teardown never races the in-page stream.
  await expect(
    page.getByTestId("workspace-chat").getByText(COLLECTIVE),
  ).toBeVisible();
});

test("verifies a turn end to end on the mobile chat", async ({
  page,
}, testInfo) => {
  test.skip(
    testInfo.project.name === "desktop-chromium",
    "The mobile deliberation journey is covered at the mobile viewport.",
  );

  const respondBodies: RespondBody[] = [];

  await mockModels(page);
  await mockDeliberationAvailability(page);
  await page.route("**/api/venom/respond", async (route) => {
    const body = route.request().postDataJSON() as RespondBody;
    respondBodies.push(body);
    const events =
      body.mode === "verify"
        ? deliberationEvents
        : [
            { modelId: "venom-gpt", modelName: "Venom GPT" },
            { content: "Plain follow-up." },
            { done: true },
          ];
    await route.fulfill({
      status: 200,
      headers: {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
      },
      body: sseBody(events),
    });
  });
  await mockKnowledgeExtraction(page);

  await page.goto("/");

  // The mode switch replaces the old one-shot toggle; Talk is the default.
  const modeSwitch = page.getByTestId("mode-switch");
  await expect(modeSwitch).toBeVisible();
  await expect(page.getByTestId("mode-option-talk")).toHaveAttribute(
    "aria-checked",
    "true",
  );

  // Verify mode brings up the blend pad with the persona corners: only one
  // real model is enabled, so the deliberation personas fill the triangle.
  await page.getByTestId("mode-option-verify").click();
  await expect(page.getByTestId("blend-pad")).toBeVisible();
  await expect(page.getByTestId("blend-weight-direct")).toHaveText("33%");
  await expect(page.getByTestId("blend-weight-skeptic")).toHaveText("33%");

  // Favoring a corner without dragging: the accessible button path.
  await page.getByTestId("button-blend-favor-direct").click();
  await expect(page.getByTestId("blend-weight-direct")).toHaveText("70%");
  await page.getByTestId("button-blend-even").click();
  await expect(page.getByTestId("blend-weight-direct")).toHaveText("33%");

  await page.getByTestId("chat-input").fill("Should we ship the migration?");
  await page.getByTestId("send-message-button").click();

  // The request declares verify mode and carries the persona blend.
  await expect.poll(() => respondBodies.length).toBe(1);
  expect(respondBodies[0].mode).toBe("verify");
  expect(respondBodies[0].deliberate).toBeUndefined();
  expect(respondBodies[0].blend?.map((entry) => entry.id)).toEqual([
    "direct",
    "skeptic",
    "evidence",
  ]);

  // The turn ends as one collective answer with the split flagged.
  const chatWorkspace = page.getByTestId("workspace-chat");
  await expect(chatWorkspace.getByText(COLLECTIVE)).toBeVisible();
  await expect(
    page.getByTestId("deliberation-disagreements"),
  ).toContainText(DISAGREEMENT);

  // Individual takes stay readable behind the collapsible section.
  await page.getByTestId("toggle-deliberation-takes").click();
  await expect(page.getByTestId("deliberation-take-direct")).toContainText(
    "Ship the migration",
  );
  await expect(page.getByTestId("deliberation-take-skeptic")).toContainText(
    "This voice didn't finish its take.",
  );
  const evidenceTake = page.getByTestId("deliberation-take-evidence");
  await expect(evidenceTake).toContainText("(archived source)");
  await expect(evidenceTake).not.toContainText("[source:");

  // Collapse hides them again.
  await page.getByTestId("toggle-deliberation-takes").click();
  await expect(page.getByTestId("deliberation-take-direct")).toHaveCount(0);

  // The mode is remembered per conversation — not a one-shot toggle.
  await expect(page.getByTestId("mode-option-verify")).toHaveAttribute(
    "aria-checked",
    "true",
  );

  // Back on Talk, the request body stays byte-identical with today's chat:
  // no mode key, no blend key.
  await page.getByTestId("mode-option-talk").click();
  await expect(page.getByTestId("blend-pad")).toHaveCount(0);
  await page.getByTestId("chat-input").fill("And normally now?");
  await page.getByTestId("send-message-button").click();
  await expect(chatWorkspace.getByText("Plain follow-up.")).toBeVisible();
  await expect.poll(() => respondBodies.length).toBe(2);
  expect("mode" in respondBodies[1]).toBe(false);
  expect("blend" in respondBodies[1]).toBe(false);
  expect("deliberate" in respondBodies[1]).toBe(false);
});

test("hides the mode controls when the server lacks the endpoint", async ({
  page,
}, testInfo) => {
  test.skip(
    testInfo.project.name === "desktop-chromium",
    "The mobile deliberation journey is covered at the mobile viewport.",
  );

  await mockModels(page);
  await page.route("**/api/venom/deliberation", async (route) => {
    await route.fulfill({
      status: 404,
      contentType: "application/json",
      body: JSON.stringify({ error: "Not found" }),
    });
  });
  await page.route("**/api/venom/respond", async (route) => {
    await route.fulfill({
      status: 200,
      headers: {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
      },
      body: sseBody([
        { modelId: "venom-gpt", modelName: "Venom GPT" },
        { content: "Ordinary reply." },
        { done: true },
      ]),
    });
  });

  await page.goto("/");

  await expect(page.getByTestId("chat-input")).toBeVisible();
  await expect(page.getByTestId("mode-switch")).toHaveCount(0);
  await expect(page.getByTestId("blend-pad")).toHaveCount(0);

  await page.getByTestId("chat-input").fill("Just answer normally.");
  await page.getByTestId("send-message-button").click();
  await expect(
    page.getByTestId("workspace-chat").getByText("Ordinary reply."),
  ).toBeVisible();
});
