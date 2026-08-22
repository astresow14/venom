import { expect, test } from "@playwright/test";
import { mockStagedChatStream } from "./support/chat-stream";

/**
 * Debate mode on the mobile chat: with three real models enabled, the blend
 * pad shows them at the corners, favoring one steers the request weights,
 * named voices land in the thread as attributed messages with citations
 * resolved, the mode is remembered, and a follow-up round carries the prior
 * turns as history.
 */

const catalog = [
  {
    id: "venom-gpt",
    provider: "openai",
    name: "Venom GPT",
    family: "GPT",
    summary: "OpenAI managed model",
    available: true,
    availabilityText: "Ready",
  },
  {
    id: "venom-claude",
    provider: "anthropic",
    name: "Venom Claude",
    family: "Claude",
    summary: "Anthropic managed model",
    available: true,
    availabilityText: "Ready",
  },
  {
    id: "venom-gemini",
    provider: "google",
    name: "Venom Gemini",
    family: "Gemini",
    summary: "Google managed model",
    available: true,
    availabilityText: "Ready",
  },
];

const debateRoster = [
  {
    voiceId: "venom-gpt",
    name: "Venom GPT",
    modelId: "venom-gpt",
    modelName: "Venom GPT",
  },
  {
    voiceId: "venom-claude",
    name: "Venom Claude",
    modelId: "venom-claude",
    modelName: "Venom Claude",
  },
  {
    voiceId: "venom-gemini",
    name: "Venom Gemini",
    modelId: "venom-gemini",
    modelName: "Venom Gemini",
  },
];

const GPT_TURN = "Opening take: ship it behind a flag [source:src-live].";
const CLAUDE_TURN =
  "Venom GPT is too eager — stage the migration first, then flip the flag.";
const FOLLOW_UP_TURN = "Given your point, staging one day is the compromise.";

const firstRound = [
  {
    modelId: "venom-gpt",
    modelName: "Venom GPT",
    debate: { voices: debateRoster, turns: 3 },
  },
  {
    debateTurn: {
      index: 0,
      of: 3,
      voiceId: "venom-gpt",
      name: "Venom GPT",
      modelId: "venom-gpt",
      modelName: "Venom GPT",
    },
  },
  { turn: 0, content: GPT_TURN },
  { turn: 0, turnStatus: "ok" },
  {
    debateTurn: {
      index: 1,
      of: 3,
      voiceId: "venom-claude",
      name: "Venom Claude",
      modelId: "venom-claude",
      modelName: "Venom Claude",
    },
  },
  { turn: 1, content: CLAUDE_TURN },
  { turn: 1, turnStatus: "ok" },
  {
    debateTurn: {
      index: 2,
      of: 3,
      voiceId: "venom-gemini",
      name: "Venom Gemini",
      modelId: "venom-gemini",
      modelName: "Venom Gemini",
    },
  },
  { turn: 2, turnStatus: "failed" },
  { done: true },
];

const secondRound = [
  {
    modelId: "venom-gpt",
    modelName: "Venom GPT",
    debate: { voices: debateRoster, turns: 3 },
  },
  {
    debateTurn: {
      index: 0,
      of: 3,
      voiceId: "venom-gpt",
      name: "Venom GPT",
      modelId: "venom-gpt",
      modelName: "Venom GPT",
    },
  },
  { turn: 0, content: FOLLOW_UP_TURN },
  { turn: 0, turnStatus: "ok" },
  { done: true },
];

function sseBody(events: unknown[]): string {
  return events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("");
}

type RespondBody = {
  mode?: string;
  blend?: Array<{ id: string; weight: number }>;
  deliberate?: boolean;
  messages?: Array<{ role: string; content: string }>;
};

test("debates a round with named voices on the mobile chat", async ({
  page,
}, testInfo) => {
  test.skip(
    testInfo.project.name === "desktop-chromium",
    "The mobile debate journey is covered at the mobile viewport.",
  );

  // Three real models enabled: the pad corners are the models themselves.
  await page.addInitScript(() => {
    window.localStorage.setItem(
      "@venom_state_v2:venom-ui-test",
      JSON.stringify({
        projects: [],
        conversations: [],
        clusters: [],
        sources: [],
        activeProjectId: null,
        activeConversationId: null,
        modelPreferences: {
          enabledModelIds: ["venom-gpt", "venom-claude", "venom-gemini"],
          defaultModelId: "venom-gpt",
          activeModelId: "venom-gpt",
          updatedAt: 1,
        },
      }),
    );
  });

  const respondBodies: RespondBody[] = [];

  await page.route("**/api/venom/models", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(catalog),
    });
  });
  await page.route("**/api/venom/deliberation", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        available: true,
        mode: "models",
        voices: debateRoster.map(({ voiceId, name }) => ({
          voiceId,
          name,
          tagline: "",
        })),
      }),
    });
  });
  await page.route("**/api/venom/respond", async (route) => {
    const body = route.request().postDataJSON() as RespondBody;
    respondBodies.push(body);
    await route.fulfill({
      status: 200,
      headers: {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
      },
      body: sseBody(respondBodies.length === 1 ? firstRound : secondRound),
    });
  });
  const extractBodies: Array<{
    messages: Array<{ role: string; content: string }>;
  }> = [];
  await page.route("**/api/venom/knowledge/extract", async (route) => {
    extractBodies.push(
      route.request().postDataJSON() as (typeof extractBodies)[number],
    );
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ clusters: [] }),
    });
  });

  await page.goto("/");

  // Switch the session into Debate; the pad corners are the enabled models.
  await expect(page.getByTestId("mode-switch")).toBeVisible();
  await page.getByTestId("mode-option-debate").click();
  await expect(page.getByTestId("mode-option-debate")).toHaveAttribute(
    "aria-checked",
    "true",
  );
  await expect(page.getByTestId("blend-pad")).toBeVisible();
  await expect(page.getByTestId("blend-weight-venom-gpt")).toHaveText("33%");

  // Favor GPT through the non-pointer path; the weights follow.
  await page.getByTestId("button-blend-favor-venom-gpt").click();
  await expect(page.getByTestId("blend-weight-venom-gpt")).toHaveText("70%");
  await expect(page.getByTestId("blend-weight-venom-claude")).toHaveText(
    "15%",
  );

  await page.getByTestId("chat-input").fill("Ship the migration now?");
  await page.getByTestId("send-message-button").click();

  // The request declares debate mode and carries the favored blend.
  await expect.poll(() => respondBodies.length).toBe(1);
  const first = respondBodies[0];
  expect(first.mode).toBe("debate");
  expect(first.deliberate).toBeUndefined();
  expect(first.blend?.map((entry) => entry.id)).toEqual([
    "venom-gpt",
    "venom-claude",
    "venom-gemini",
  ]);
  expect(first.blend?.[0].weight ?? 0).toBeGreaterThan(0.6);

  // Both finished voices land in the thread as named participants; the
  // failed third voice doesn't kill the round.
  const chatWorkspace = page.getByTestId("workspace-chat");
  await expect(
    chatWorkspace.getByText("stage the migration first", { exact: false }),
  ).toBeVisible();
  const speakerChips = chatWorkspace.getByTestId("chip-speaker");
  await expect(speakerChips).toHaveCount(2);
  await expect(speakerChips.first()).toContainText("Venom Claude");
  await expect(speakerChips.last()).toContainText("Venom GPT");

  // Group-chat avatars: each voice's turn carries its model family's glyph
  // beside the bubble — distinct speakers, distinct marks.
  await expect(chatWorkspace.getByTestId("speaker-avatar-gpt")).toHaveCount(1);
  await expect(chatWorkspace.getByTestId("speaker-avatar-claude")).toHaveCount(
    1,
  );

  // Citation markers resolve into labels, never raw tags.
  await expect(
    chatWorkspace.getByText("(archived source)", { exact: false }).first(),
  ).toBeVisible();
  await expect(chatWorkspace.getByText("[source:")).toHaveCount(0);

  // The client persists exactly what the server streamed — never more. Raw
  // markers are stored as sent (they resolve at render time), so a bounded
  // turn can never re-expand through persistence or sync.
  await expect
    .poll(async () =>
      page.evaluate(() => {
        const raw = window.localStorage.getItem(
          "@venom_state_v2:venom-ui-test",
        );
        if (!raw) return null;
        const state = JSON.parse(raw) as {
          conversations: Array<{
            messages: Array<{ role: string; content: string }>;
          }>;
        };
        return state.conversations
          .flatMap((conversation) => conversation.messages)
          .filter((message) => message.role === "assistant")
          .map((message) => message.content);
      }),
    )
    .toEqual([GPT_TURN, CLAUDE_TURN]);

  // The mode sticks to the conversation after the round.
  await expect(page.getByTestId("mode-option-debate")).toHaveAttribute(
    "aria-checked",
    "true",
  );

  // A follow-up starts a new debate round whose history carries the prior
  // named turns, so the voices can react to what was already said.
  await page.getByTestId("chat-input").fill("What about a shorter stage?");
  await page.getByTestId("send-message-button").click();
  await expect.poll(() => respondBodies.length).toBe(2);
  const second = respondBodies[1];
  expect(second.mode).toBe("debate");
  const assistantHistory = (second.messages ?? [])
    .filter((message) => message.role === "assistant")
    .map((message) => message.content);
  expect(
    assistantHistory.some((content) =>
      content.includes("stage the migration first"),
    ),
  ).toBe(true);
  await expect(
    chatWorkspace.getByText("staging one day is the compromise", {
      exact: false,
    }),
  ).toBeVisible();

  // Neither round produced a settled conclusion — the first round's closing
  // voice failed, and the follow-up round ended before its closing turn —
  // so no debate text reached the Brain.
  await page.waitForTimeout(300);
  expect(extractBodies).toHaveLength(0);
});

test("one enabled model with a full server catalog debates as personas", async ({
  page,
}, testInfo) => {
  test.skip(
    testInfo.project.name === "desktop-chromium",
    "The mobile debate journey is covered at the mobile viewport.",
  );

  // The shipped default: one enabled model, while the server catalog still
  // lists three providers. The pad must show persona corners — never the
  // disabled models — send persona ids as the blend, and render the round's
  // persona-attributed turns.
  await page.addInitScript(() => {
    window.localStorage.setItem(
      "@venom_state_v2:venom-ui-test",
      JSON.stringify({
        projects: [],
        conversations: [],
        clusters: [],
        sources: [],
        activeProjectId: null,
        activeConversationId: null,
        modelPreferences: {
          enabledModelIds: ["venom-gpt"],
          defaultModelId: "venom-gpt",
          activeModelId: "venom-gpt",
          updatedAt: 1,
        },
      }),
    );
  });

  const respondBodies: RespondBody[] = [];
  const personaRound = [
    {
      modelId: "venom-gpt",
      modelName: "Venom GPT",
      debate: {
        voices: [
          {
            voiceId: "skeptic",
            name: "Skeptic",
            modelId: "venom-gpt",
            modelName: "Venom GPT",
          },
          {
            voiceId: "direct",
            name: "First take",
            modelId: "venom-gpt",
            modelName: "Venom GPT",
          },
        ],
        turns: 2,
      },
    },
    {
      debateTurn: {
        index: 0,
        of: 2,
        voiceId: "skeptic",
        name: "Skeptic",
        modelId: "venom-gpt",
        modelName: "Venom GPT",
      },
    },
    { turn: 0, content: "Risk first: the rollback path is untested." },
    { turn: 0, turnStatus: "ok" },
    {
      debateTurn: {
        index: 1,
        of: 2,
        voiceId: "direct",
        name: "First take",
        modelId: "venom-gpt",
        modelName: "Venom GPT",
      },
    },
    { turn: 1, content: "Ship it behind a flag." },
    { turn: 1, turnStatus: "ok" },
    { done: true },
  ];

  await page.route("**/api/venom/models", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(catalog),
    });
  });
  await page.route("**/api/venom/deliberation", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        available: true,
        mode: "personas",
        voices: [
          { voiceId: "direct", name: "First take", tagline: "Head-on" },
          { voiceId: "skeptic", name: "Skeptic", tagline: "Risks" },
          { voiceId: "evidence", name: "Evidence", tagline: "Sources" },
        ],
      }),
    });
  });
  await page.route("**/api/venom/respond", async (route) => {
    respondBodies.push(route.request().postDataJSON() as RespondBody);
    await route.fulfill({
      status: 200,
      headers: {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
      },
      body: sseBody(personaRound),
    });
  });
  const extractBodies: Array<{
    messages: Array<{ role: string; content: string }>;
  }> = [];
  await page.route("**/api/venom/knowledge/extract", async (route) => {
    extractBodies.push(
      route.request().postDataJSON() as (typeof extractBodies)[number],
    );
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ clusters: [] }),
    });
  });

  await page.goto("/");

  await expect(page.getByTestId("mode-switch")).toBeVisible();
  await page.getByTestId("mode-option-debate").click();
  await expect(page.getByTestId("blend-pad")).toBeVisible();

  // Persona corners at an even blend — the disabled models never appear.
  await expect(page.getByTestId("blend-weight-direct")).toHaveText("33%");
  await expect(page.getByTestId("blend-weight-skeptic")).toHaveText("33%");
  await expect(page.getByTestId("blend-weight-evidence")).toHaveText("33%");
  await expect(page.getByTestId("blend-pad")).not.toContainText("Venom Claude");

  // Favor the Skeptic through the non-pointer path.
  await page.getByTestId("button-blend-favor-skeptic").click();
  await expect(page.getByTestId("blend-weight-skeptic")).toHaveText("70%");

  await page.getByTestId("chat-input").fill("Do we ship this week?");
  await page.getByTestId("send-message-button").click();

  // The request carries persona corner ids with the skeptic favored — the
  // exact contract the server planner honors on a full catalog.
  await expect.poll(() => respondBodies.length).toBe(1);
  const body = respondBodies[0];
  expect(body.mode).toBe("debate");
  expect((body as { modelId?: string }).modelId).toBe("venom-gpt");
  const blendIds = (body.blend ?? []).map((entry) => entry.id).sort();
  expect(blendIds).toEqual(["direct", "evidence", "skeptic"]);
  const skeptic = (body.blend ?? []).find((entry) => entry.id === "skeptic");
  expect(skeptic?.weight ?? 0).toBeGreaterThan(0.6);

  // Turns land attributed to persona names.
  const chatWorkspace = page.getByTestId("workspace-chat");
  await expect(
    chatWorkspace.getByText("Risk first", { exact: false }),
  ).toBeVisible();
  await expect(
    chatWorkspace.getByText("Ship it behind a flag.", { exact: false }),
  ).toBeVisible();
  // Newest-first thread: the closing persona sits on top, the opener below.
  const speakerChips = chatWorkspace.getByTestId("chip-speaker");
  await expect(speakerChips).toHaveCount(2);
  await expect(speakerChips.first()).toContainText("First take");
  await expect(speakerChips.last()).toContainText("Skeptic");

  // Personas share one model, so identical model glyphs would say nothing:
  // each voice gets its own monogram, and the shared model's glyph appears
  // nowhere in the thread.
  await expect(
    chatWorkspace.getByTestId("speaker-avatar-monogram-s"),
  ).toHaveCount(1);
  await expect(
    chatWorkspace.getByTestId("speaker-avatar-monogram-ft"),
  ).toHaveCount(1);
  await expect(chatWorkspace.getByTestId("speaker-avatar-gpt")).toHaveCount(0);

  // The settled round feeds the Brain exactly once: the closing take is
  // mined as the answer alongside the user's question, and the sparring
  // before it never reaches the extractor.
  await expect.poll(() => extractBodies.length).toBe(1);
  const extraction = extractBodies[0];
  const extractedAssistants = extraction.messages.filter(
    (message) => message.role === "assistant",
  );
  expect(extractedAssistants).toHaveLength(1);
  expect(extractedAssistants[0].content).toBe("Ship it behind a flag.");
  expect(
    extraction.messages.some((message) =>
      message.content.includes("Risk first"),
    ),
  ).toBe(false);
  expect(
    extraction.messages.some(
      (message) =>
        message.role === "user" &&
        message.content.includes("Do we ship this week?"),
    ),
  ).toBe(true);
});

test("default debate corners skip a model whose account can't pay", async ({
  page,
}, testInfo) => {
  test.skip(
    testInfo.project.name === "desktop-chromium",
    "The mobile debate journey is covered at the mobile viewport.",
  );

  // Four enabled models, but Claude's provider account is billing-dead:
  // still available (retry is the recovery path) yet flagged unfunded, so
  // the pad must not auto-seat it — the corners double as the debate roster
  // the server honors verbatim.
  const catalogWithUnfunded = [
    catalog[0],
    {
      ...catalog[1],
      availabilityText: "Provider account issue",
      accountHealth: "unfunded",
    },
    catalog[2],
    {
      id: "venom-grok",
      provider: "openrouter",
      name: "Venom Grok",
      family: "Grok",
      summary: "OpenRouter managed model",
      available: true,
      availabilityText: "Ready",
    },
  ];
  const healthyRoster = [
    debateRoster[0],
    debateRoster[2],
    {
      voiceId: "venom-grok",
      name: "Venom Grok",
      modelId: "venom-grok",
      modelName: "Venom Grok",
    },
  ];

  await page.addInitScript(() => {
    window.localStorage.setItem(
      "@venom_state_v2:venom-ui-test",
      JSON.stringify({
        projects: [],
        conversations: [],
        clusters: [],
        sources: [],
        activeProjectId: null,
        activeConversationId: null,
        modelPreferences: {
          enabledModelIds: [
            "venom-gpt",
            "venom-claude",
            "venom-gemini",
            "venom-grok",
          ],
          defaultModelId: "venom-gpt",
          activeModelId: "venom-gpt",
          updatedAt: 1,
        },
      }),
    );
  });

  const respondBodies: RespondBody[] = [];

  await page.route("**/api/venom/models", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(catalogWithUnfunded),
    });
  });
  await page.route("**/api/venom/deliberation", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        available: true,
        mode: "models",
        voices: healthyRoster.map(({ voiceId, name }) => ({
          voiceId,
          name,
          tagline: "",
        })),
      }),
    });
  });
  await page.route("**/api/venom/respond", async (route) => {
    const body = route.request().postDataJSON() as RespondBody;
    respondBodies.push(body);
    await route.fulfill({
      status: 200,
      headers: {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
      },
      body: sseBody([
        {
          modelId: "venom-gpt",
          modelName: "Venom GPT",
          debate: { voices: healthyRoster, turns: 3 },
        },
        {
          debateTurn: {
            index: 0,
            of: 3,
            voiceId: "venom-gpt",
            name: "Venom GPT",
            modelId: "venom-gpt",
            modelName: "Venom GPT",
          },
        },
        { turn: 0, content: "Healthy corners only." },
        { turn: 0, turnStatus: "ok" },
        { done: true },
      ]),
    });
  });
  const extractBodies: unknown[] = [];
  await page.route("**/api/venom/knowledge/extract", async (route) => {
    extractBodies.push(route.request().postDataJSON());
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ clusters: [] }),
    });
  });

  await page.goto("/");

  await expect(page.getByTestId("mode-switch")).toBeVisible();
  await page.getByTestId("mode-option-debate").click();
  await expect(page.getByTestId("blend-pad")).toBeVisible();

  // The healthy trio takes the corners; the unfunded model never appears.
  await expect(page.getByTestId("blend-weight-venom-gpt")).toHaveText("33%");
  await expect(page.getByTestId("blend-weight-venom-gemini")).toHaveText(
    "33%",
  );
  await expect(page.getByTestId("blend-weight-venom-grok")).toHaveText("33%");
  await expect(page.getByTestId("blend-weight-venom-claude")).toHaveCount(0);
  await expect(page.getByTestId("blend-pad")).not.toContainText(
    "Venom Claude",
  );

  await page.getByTestId("chat-input").fill("Who takes the corners?");
  await page.getByTestId("send-message-button").click();

  // The default request roster carries only models whose account can pay —
  // the server treats these ids as an explicit roster, so the client must
  // never volunteer a billing-dead model it picked by default.
  await expect.poll(() => respondBodies.length).toBe(1);
  const body = respondBodies[0];
  expect(body.mode).toBe("debate");
  const blendIds = (body.blend ?? []).map((entry) => entry.id);
  expect(blendIds).toEqual(["venom-gpt", "venom-gemini", "venom-grok"]);
  expect(blendIds).not.toContain("venom-claude");

  // The round still renders normally on the healthy roster.
  await expect(
    page
      .getByTestId("workspace-chat")
      .getByText("Healthy corners only.", { exact: false }),
  ).toBeVisible();

  // The round ran one turn of three and ended before its closing turn: an
  // unsettled debate, so nothing reached the Brain.
  await page.waitForTimeout(300);
  expect(extractBodies).toHaveLength(0);
});

test("collapses the mixer — corner picker included — and debates on the committed blend", async ({
  page,
}, testInfo) => {
  test.skip(
    testInfo.project.name === "desktop-chromium",
    "The mobile debate journey is covered at the mobile viewport.",
  );

  // Four healthy enabled models: the corner picker is available, so folding
  // the mixer must put it away too.
  const fourModelCatalog = [
    ...catalog,
    {
      id: "venom-grok",
      provider: "openrouter",
      name: "Venom Grok",
      family: "Grok",
      summary: "OpenRouter managed model",
      available: true,
      availabilityText: "Ready",
    },
  ];

  await page.addInitScript(() => {
    window.localStorage.setItem(
      "@venom_state_v2:venom-ui-test",
      JSON.stringify({
        projects: [],
        conversations: [],
        clusters: [],
        sources: [],
        activeProjectId: null,
        activeConversationId: null,
        modelPreferences: {
          enabledModelIds: [
            "venom-gpt",
            "venom-claude",
            "venom-gemini",
            "venom-grok",
          ],
          defaultModelId: "venom-gpt",
          activeModelId: "venom-gpt",
          updatedAt: 1,
        },
      }),
    );
  });

  const respondBodies: RespondBody[] = [];

  await page.route("**/api/venom/models", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(fourModelCatalog),
    });
  });
  await page.route("**/api/venom/deliberation", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        available: true,
        mode: "models",
        voices: debateRoster.map(({ voiceId, name }) => ({
          voiceId,
          name,
          tagline: "",
        })),
      }),
    });
  });
  await page.route("**/api/venom/respond", async (route) => {
    respondBodies.push(route.request().postDataJSON() as RespondBody);
    await route.fulfill({
      status: 200,
      headers: {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
      },
      body: sseBody(firstRound),
    });
  });
  await page.route("**/api/venom/knowledge/extract", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ clusters: [] }),
    });
  });

  await page.goto("/");

  await expect(page.getByTestId("mode-switch")).toBeVisible();
  await page.getByTestId("mode-option-debate").click();
  await expect(page.getByTestId("blend-pad")).toBeVisible();

  // Favor GPT and open the corner picker — the two pieces of mixer state a
  // collapse has to handle.
  await page.getByTestId("button-blend-favor-venom-gpt").click();
  await expect(page.getByTestId("blend-weight-venom-gpt")).toHaveText("70%");
  await page.getByTestId("button-blend-corners").click();
  await expect(page.getByTestId("blend-corner-picker")).toBeVisible();

  // Fold the mixer: the pad and the corner picker leave together while
  // Debate stays selected, and the chip names the favored voice.
  await page.getByTestId("button-blend-collapse").click();
  await expect(page.getByTestId("blend-pad")).toHaveCount(0);
  await expect(page.getByTestId("blend-corner-picker")).toHaveCount(0);
  await expect(page.getByTestId("mode-option-debate")).toHaveAttribute(
    "aria-checked",
    "true",
  );
  const summaryChip = page.getByTestId("button-blend-summary");
  await expect(summaryChip).toBeVisible();
  await expect(summaryChip).toContainText("Favoring Venom GPT");

  // Reopen: weights intact, and the corner picker stayed put away.
  await summaryChip.click();
  await expect(page.getByTestId("blend-pad")).toBeVisible();
  await expect(page.getByTestId("blend-weight-venom-gpt")).toHaveText("70%");
  await expect(page.getByTestId("blend-corner-picker")).toHaveCount(0);

  // Fold again and send: the request still declares debate mode and carries
  // the favored blend.
  await page.getByTestId("button-blend-collapse").click();
  await expect(page.getByTestId("blend-pad")).toHaveCount(0);
  await page.getByTestId("chat-input").fill("Ship the migration now?");
  await page.getByTestId("send-message-button").click();
  await expect.poll(() => respondBodies.length).toBe(1);
  expect(respondBodies[0].mode).toBe("debate");
  const favored = respondBodies[0].blend?.find(
    (entry) => entry.id === "venom-gpt",
  );
  expect(favored?.weight ?? 0).toBeGreaterThan(0.6);

  // The round lands normally while the mixer stays folded — no spring-back
  // once the debate settles into the thread.
  await expect(
    page
      .getByTestId("workspace-chat")
      .getByText("stage the migration first", { exact: false }),
  ).toBeVisible();
  await expect(page.getByTestId("blend-pad")).toHaveCount(0);
  await expect(summaryChip).toBeVisible();
});

test("live debate shows the current speaker's avatar and groups back-to-back turns", async ({
  page,
}, testInfo) => {
  test.skip(
    testInfo.project.name === "desktop-chromium",
    "The mobile debate journey is covered at the mobile viewport.",
  );

  // Staged streaming (not an atomic body) so the in-flight card stays on
  // screen long enough to watch the avatar follow the speaker; Claude then
  // takes two turns in a row so the settled thread has a real run to group.
  await page.addInitScript(() => {
    window.localStorage.setItem(
      "@venom_state_v2:venom-ui-test",
      JSON.stringify({
        projects: [],
        conversations: [],
        clusters: [],
        sources: [],
        activeProjectId: null,
        activeConversationId: null,
        modelPreferences: {
          enabledModelIds: ["venom-gpt", "venom-claude", "venom-gemini"],
          defaultModelId: "venom-gpt",
          activeModelId: "venom-gpt",
          updatedAt: 1,
        },
      }),
    );
  });

  await page.route("**/api/venom/models", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(catalog),
    });
  });
  await page.route("**/api/venom/deliberation", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        available: true,
        mode: "models",
        voices: debateRoster.map(({ voiceId, name }) => ({
          voiceId,
          name,
          tagline: "",
        })),
      }),
    });
  });
  await page.route("**/api/venom/knowledge/extract", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ clusters: [] }),
    });
  });
  const turn = (
    index: number,
    voice: (typeof debateRoster)[number],
    text: string,
  ): Array<[number, unknown]> => [
    [
      200,
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
    [300, { turn: index, content: text }],
    [600, { turn: index, turnStatus: "ok" }],
  ];
  await mockStagedChatStream(page, [
    [
      [
        0,
        {
          modelId: "venom-gpt",
          modelName: "Venom GPT",
          debate: { voices: debateRoster, turns: 3 },
        },
      ],
      ...turn(0, debateRoster[0], "Opening: ship it now."),
      ...turn(1, debateRoster[1], "Counter: stage it first."),
      ...turn(2, debateRoster[1], "And staging catches the cheap failures."),
      [200, { done: true }],
    ],
  ]);

  await page.goto("/");

  await expect(page.getByTestId("mode-switch")).toBeVisible();
  await page.getByTestId("mode-option-debate").click();
  await expect(page.getByTestId("mode-option-debate")).toHaveAttribute(
    "aria-checked",
    "true",
  );

  await page.getByTestId("chat-input").fill("Ship the migration now?");
  await page.getByTestId("send-message-button").click();

  // While GPT talks, the live card wears GPT's glyph…
  const stream = page.getByTestId("debate-stream");
  await expect(stream).toBeVisible();
  await expect(stream.getByTestId("speaker-avatar-gpt")).toBeVisible();

  // …and when Claude takes over, the avatar follows the speaker.
  await expect(stream.getByTestId("speaker-avatar-claude")).toBeVisible();

  // Round settled: Claude's back-to-back turns read as one group — one chip,
  // one avatar — while every bubble keeps its own text.
  await expect(stream).toHaveCount(0);
  const chatWorkspace = page.getByTestId("workspace-chat");
  await expect(
    chatWorkspace.getByText("Opening: ship it now.", { exact: false }),
  ).toBeVisible();
  await expect(
    chatWorkspace.getByText("Counter: stage it first.", { exact: false }),
  ).toBeVisible();
  await expect(
    chatWorkspace.getByText("staging catches the cheap failures", {
      exact: false,
    }),
  ).toBeVisible();
  await expect(chatWorkspace.getByTestId("chip-speaker")).toHaveCount(2);
  await expect(chatWorkspace.getByTestId("speaker-avatar-gpt")).toHaveCount(1);
  await expect(chatWorkspace.getByTestId("speaker-avatar-claude")).toHaveCount(
    1,
  );
});
