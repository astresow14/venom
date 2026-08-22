import assert from "node:assert/strict";
import test from "node:test";
import { SendVenomMessageBody } from "@workspace/api-zod";
import {
  buildDebateTurnMessages,
  DEBATE_MAX_TURNS,
  debateCharBudget,
  debateWordBudget,
  InvalidDebateParticipants,
  normalizeBlendWeights,
  planDebateTurns,
  planDebateVoices,
  runDebate,
  type DebateTurnRecord,
  type PlannedDebateVoice,
} from "./venom-debate";
import { buildSynthesisMessages } from "./venom-deliberation";
import {
  PROVIDER_ACCOUNT_ERROR_MESSAGE,
  ProviderError,
  type VenomMessage,
} from "./venom-provider-adapters";
import type { VenomManagedModel } from "./venom-models";

/** Production provider layout: every managed model on its own provider. */
const MODEL_PROVIDERS: Record<VenomManagedModel["id"], VenomManagedModel["provider"]> = {
  "venom-gpt": "openai",
  "venom-claude": "anthropic",
  "venom-gemini": "gemini",
  "venom-grok": "openrouter",
};

function catalogEntry(
  id: VenomManagedModel["id"],
  name: string,
  available: boolean,
  accountHealth?: VenomManagedModel["accountHealth"],
  provider?: VenomManagedModel["provider"],
): VenomManagedModel {
  return {
    id,
    provider: provider ?? MODEL_PROVIDERS[id],
    name,
    family: "GPT",
    summary: "",
    available,
    availabilityText: available ? "Ready" : "Not configured",
    accountHealth,
  } as VenomManagedModel;
}

const FULL_CATALOG = [
  catalogEntry("venom-gpt", "Venom GPT", true),
  catalogEntry("venom-claude", "Venom Claude", true),
  catalogEntry("venom-gemini", "Venom Gemini", true),
  catalogEntry("venom-grok", "Venom Grok", false),
];

const SOLO_CATALOG = [
  catalogEntry("venom-gpt", "Venom GPT", true),
  catalogEntry("venom-claude", "Venom Claude", false),
  catalogEntry("venom-gemini", "Venom Gemini", false),
  catalogEntry("venom-grok", "Venom Grok", false),
];

const BASE_MESSAGES: VenomMessage[] = [
  { role: "system", content: "You are Venom." },
  { role: "user", content: "Should we ship on Friday?" },
];

type Script =
  | string[]
  | Error
  | ((signal: AbortSignal | undefined) => AsyncGenerator<string, void, unknown>);

/**
 * Fake provider keyed by which debate voice is speaking: every turn's system
 * prompt names its voice as `You are "<name>"`.
 */
function scriptedStreamModel(scripts: Record<string, Script | Script[]>) {
  const calls: Array<{ key: string; modelId: string; messages: VenomMessage[] }> = [];
  const seen = new Map<string, number>();
  const streamModel = ((
    modelId: string,
    messages: VenomMessage[],
    signal?: AbortSignal,
  ) => {
    const system = messages[0]?.content ?? "";
    const match = system.match(/You are "([^"]+)"/);
    const key = match?.[1] ?? "unknown";
    calls.push({ key, modelId, messages });

    let script = scripts[key];
    // Allow an array of scripts consumed call-by-call for repeat turns.
    if (Array.isArray(script) && script.length > 0 && (Array.isArray(script[0]) || script[0] instanceof Error || typeof script[0] === "function")) {
      const index = seen.get(key) ?? 0;
      seen.set(key, index + 1);
      const scripted = script as Script[];
      script = scripted[Math.min(index, scripted.length - 1)];
    }
    const resolved = script as Script | undefined;
    return (async function* () {
      if (!resolved) return;
      if (resolved instanceof Error) throw resolved;
      if (typeof resolved === "function") {
        yield* resolved(signal);
        return;
      }
      for (const chunk of resolved) {
        if (signal?.aborted) return;
        yield chunk;
      }
    })();
  }) as never;
  return { streamModel, calls };
}

function collectDebate(
  scripts: Record<string, Script | Script[]>,
  options?: {
    catalog?: VenomManagedModel[];
    requestedIds?: string[];
    blend?: Array<{ id: string; weight: number }>;
    allowed?: string[];
    turnTimeoutMs?: number;
    roundBudgetMs?: number;
    now?: () => number;
    signal?: AbortSignal;
  },
) {
  const catalog = options?.catalog ?? FULL_CATALOG;
  const voices = planDebateVoices("venom-gpt", catalog, options?.requestedIds);
  const weights = normalizeBlendWeights(options?.blend, voices);
  const { streamModel, calls } = scriptedStreamModel(scripts);
  const events: Array<Record<string, unknown>> = [];
  const outcome = runDebate({
    baseMessages: BASE_MESSAGES,
    voices,
    weights,
    allowedCitationIds: new Set(options?.allowed ?? []),
    signal: options?.signal ?? new AbortController().signal,
    emit: (event) => events.push(event),
    turnTimeoutMs: options?.turnTimeoutMs ?? 5_000,
    roundBudgetMs: options?.roundBudgetMs,
    retryDelayMs: 0,
    streamModel,
    now: options?.now,
  });
  return { outcome, events, calls, voices, weights };
}

function turnText(events: Array<Record<string, unknown>>, turn: number): string {
  return events
    .filter((event) => event.turn === turn && typeof event.content === "string")
    .map((event) => event.content as string)
    .join("");
}

// ─── Voice planning ──────────────────────────────────────────────────────────

test("three available providers debate as themselves, anchor first", () => {
  const voices = planDebateVoices("venom-claude", FULL_CATALOG);
  assert.deepEqual(
    voices.map((voice) => voice.id),
    ["venom-claude", "venom-gpt", "venom-gemini"],
  );
  assert.deepEqual(
    voices.map((voice) => voice.name),
    ["Venom Claude", "Venom GPT", "Venom Gemini"],
  );
  assert.ok(voices.every((voice) => voice.stance === null));
});

test("the automatic model trio never seats a billing-dead account", () => {
  const catalog = [
    catalogEntry("venom-gpt", "Venom GPT", true),
    catalogEntry("venom-claude", "Venom Claude", true, "unfunded"),
    catalogEntry("venom-gemini", "Venom Gemini", true),
    catalogEntry("venom-grok", "Venom Grok", true),
  ];
  const voices = planDebateVoices("venom-gpt", catalog);
  assert.deepEqual(
    voices.map((voice) => voice.id),
    ["venom-gpt", "venom-gemini", "venom-grok"],
  );
});

test("an explicitly requested corner keeps its model even when the account is billing-dead", () => {
  const catalog = [
    catalogEntry("venom-gpt", "Venom GPT", true),
    catalogEntry("venom-claude", "Venom Claude", true, "unfunded"),
    catalogEntry("venom-gemini", "Venom Gemini", true),
    catalogEntry("venom-grok", "Venom Grok", false),
  ];
  // The user's stated corners win: they get a warned model and a clear
  // in-chat account error, never a silent reroute.
  const voices = planDebateVoices("venom-gpt", catalog, [
    "venom-claude",
    "venom-gpt",
    "venom-gemini",
  ]);
  assert.deepEqual(
    voices.map((voice) => voice.id),
    ["venom-claude", "venom-gpt", "venom-gemini"],
  );
});

test("personas ride healthy models when billing deaths thin the field", () => {
  const catalog = [
    catalogEntry("venom-gpt", "Venom GPT", true),
    catalogEntry("venom-claude", "Venom Claude", true, "unfunded"),
    catalogEntry("venom-gemini", "Venom Gemini", true),
    catalogEntry("venom-grok", "Venom Grok", false),
  ];
  // Only two healthy providers remain, so the plan falls back to personas —
  // and the billing-dead model never appears among the assignments.
  const voices = planDebateVoices("venom-gpt", catalog);
  assert.deepEqual(
    voices.map((voice) => voice.id),
    ["direct", "skeptic", "evidence"],
  );
  assert.ok(voices.every((voice) => voice.modelId !== "venom-claude"));
});

test("a requested trio of available models is honored in order", () => {
  const voices = planDebateVoices("venom-gpt", FULL_CATALOG, [
    "venom-gemini",
    "venom-claude",
    "venom-gpt",
  ]);
  assert.deepEqual(
    voices.map((voice) => voice.id),
    ["venom-gemini", "venom-claude", "venom-gpt"],
  );
});

test("a duplicated corner is rejected — a model can't argue itself", () => {
  assert.throws(
    () =>
      planDebateVoices("venom-gpt", FULL_CATALOG, [
        "venom-gpt",
        "venom-gpt",
        "venom-claude",
      ]),
    (error: unknown) =>
      error instanceof InvalidDebateParticipants &&
      /Venom GPT can't argue itself/.test(error.message),
  );
});

test("two corners on one provider are rejected via provider metadata, not id equality", () => {
  const catalog = [
    catalogEntry("venom-gpt", "Venom GPT", true),
    catalogEntry("venom-claude", "Venom Claude", true),
    // Fabricate a second Anthropic-backed model: distinct ids, same account.
    catalogEntry("venom-gemini", "Venom Gemini", true, undefined, "anthropic"),
    catalogEntry("venom-grok", "Venom Grok", false),
  ];
  assert.throws(
    () =>
      planDebateVoices("venom-gpt", catalog, [
        "venom-gpt",
        "venom-claude",
        "venom-gemini",
      ]),
    (error: unknown) =>
      error instanceof InvalidDebateParticipants &&
      /Venom Claude and Venom Gemini both run on Anthropic/.test(error.message),
  );
});

test("automatic planning spreads corners across providers when it can", () => {
  const catalog = [
    catalogEntry("venom-gpt", "Venom GPT", true),
    // A second OpenAI-backed model earlier in catalog order than the
    // distinct-provider alternatives.
    catalogEntry("venom-claude", "Venom Claude", true, undefined, "openai"),
    catalogEntry("venom-gemini", "Venom Gemini", true),
    catalogEntry("venom-grok", "Venom Grok", true),
  ];
  const voices = planDebateVoices("venom-gpt", catalog);
  assert.deepEqual(
    voices.map((voice) => voice.id),
    ["venom-gpt", "venom-gemini", "venom-grok"],
  );
});

test("too few distinct providers: automatic planning fills in catalog order, never rejects", () => {
  const catalog = [
    catalogEntry("venom-gpt", "Venom GPT", true, undefined, "openai"),
    catalogEntry("venom-claude", "Venom Claude", true, undefined, "openai"),
    catalogEntry("venom-gemini", "Venom Gemini", true, undefined, "openai"),
    catalogEntry("venom-grok", "Venom Grok", false),
  ];
  const voices = planDebateVoices("venom-gpt", catalog);
  assert.deepEqual(
    voices.map((voice) => voice.id),
    ["venom-gpt", "venom-claude", "venom-gemini"],
  );
  assert.ok(voices.every((voice) => voice.stance === null));
});

test("an unavailable requested model is rejected, never silently rerouted", () => {
  assert.throws(
    () => planDebateVoices("venom-gpt", FULL_CATALOG, ["venom-grok", "venom-gpt", "venom-claude"]),
    InvalidDebateParticipants,
  );
});

test("an unknown participant id is rejected", () => {
  assert.throws(
    () => planDebateVoices("venom-gpt", FULL_CATALOG, ["mystery-model"]),
    InvalidDebateParticipants,
  );
});

test("a single provider falls back to the deliberation personas", () => {
  const voices = planDebateVoices("venom-gpt", SOLO_CATALOG);
  assert.deepEqual(
    voices.map((voice) => voice.id),
    ["direct", "skeptic", "evidence"],
  );
  assert.deepEqual(
    voices.map((voice) => voice.name),
    ["First take", "Skeptic", "Evidence"],
  );
  assert.ok(voices.every((voice) => voice.modelId === "venom-gpt"));
  assert.ok(voices.every((voice) => typeof voice.stance === "string"));
});

test("persona corner ids are accepted when personas are planned", () => {
  const voices = planDebateVoices("venom-gpt", SOLO_CATALOG, [
    "direct",
    "skeptic",
    "evidence",
  ]);
  assert.deepEqual(
    voices.map((voice) => voice.id),
    ["direct", "skeptic", "evidence"],
  );
});

test("an explicit all-persona roster is honored even with a full catalog", () => {
  // One enabled model client-side, three configured providers server-side:
  // the pad showed personas, so the debate must run those personas — on the
  // anchor model only — not fan out to models the user never chose.
  const voices = planDebateVoices("venom-claude", FULL_CATALOG, [
    "direct",
    "skeptic",
    "evidence",
  ]);
  assert.deepEqual(
    voices.map((voice) => voice.id),
    ["direct", "skeptic", "evidence"],
  );
  assert.ok(voices.every((voice) => voice.modelId === "venom-claude"));
  assert.ok(voices.every((voice) => typeof voice.stance === "string"));

  // And the persona weights the pad sent map onto the planned voices instead
  // of collapsing to an even blend.
  const weights = normalizeBlendWeights(
    [
      { id: "direct", weight: 0.1 },
      { id: "skeptic", weight: 0.8 },
      { id: "evidence", weight: 0.1 },
    ],
    voices,
  );
  assert.ok(weights[1] > weights[0] && weights[1] > weights[2]);
  assert.ok(Math.abs(weights[1] - 0.8) < 1e-9);
});

test("a mixed model and persona roster is rejected, never rerouted", () => {
  assert.throws(
    () =>
      planDebateVoices("venom-gpt", FULL_CATALOG, [
        "venom-gpt",
        "skeptic",
        "evidence",
      ]),
    InvalidDebateParticipants,
  );
});

// ─── Weights ─────────────────────────────────────────────────────────────────

test("missing blend means an even split", () => {
  const voices = planDebateVoices("venom-gpt", FULL_CATALOG);
  const weights = normalizeBlendWeights(undefined, voices);
  assert.deepEqual(weights, [1 / 3, 1 / 3, 1 / 3]);
});

test("weights match corners by id, normalize to one, and clamp junk", () => {
  const voices = planDebateVoices("venom-gpt", FULL_CATALOG);
  const weights = normalizeBlendWeights(
    [
      { id: "venom-claude", weight: 0.6 },
      { id: "venom-gpt", weight: 0.2 },
      { id: "venom-gemini", weight: 0.2 },
    ],
    voices,
  );
  assert.ok(Math.abs(weights.reduce((sum, w) => sum + w, 0) - 1) < 1e-9);
  assert.ok(Math.abs(weights[1] - 0.6) < 1e-9);
  assert.ok(Math.abs(weights[0] - 0.2) < 1e-9);

  const junk = normalizeBlendWeights(
    [
      { id: "venom-gpt", weight: Number.NaN },
      { id: "venom-claude", weight: 9 },
    ],
    voices,
  );
  assert.ok(junk.every((w) => w >= 0 && w <= 1));
  assert.ok(Math.abs(junk.reduce((sum, w) => sum + w, 0) - 1) < 1e-9);
});

test("model-id weights still land when personas fill the corners", () => {
  const voices = planDebateVoices("venom-gpt", SOLO_CATALOG);
  const weights = normalizeBlendWeights(
    [
      { id: "direct", weight: 0.7 },
      { id: "skeptic", weight: 0.2 },
      { id: "evidence", weight: 0.1 },
    ],
    voices,
  );
  assert.ok(weights[0] > weights[1] && weights[1] > weights[2]);

  const allZero = normalizeBlendWeights(
    [
      { id: "direct", weight: 0 },
      { id: "skeptic", weight: 0 },
      { id: "evidence", weight: 0 },
    ],
    voices,
  );
  assert.deepEqual(allZero, [1 / 3, 1 / 3, 1 / 3]);
});

// ─── Turn planning ───────────────────────────────────────────────────────────

test("an even blend plans one turn per voice", () => {
  assert.deepEqual(planDebateTurns([1 / 3, 1 / 3, 1 / 3]), [0, 1, 2]);
});

test("a mild favorite opens and closes", () => {
  assert.deepEqual(planDebateTurns([0.2, 0.45, 0.35]), [1, 2, 0, 1]);
});

test("a corner pin dominates without silencing anyone", () => {
  const plan = planDebateTurns([0.8, 0.1, 0.1]);
  assert.deepEqual(plan, [0, 1, 0, 2, 0]);
  assert.ok(plan.length <= DEBATE_MAX_TURNS);
  // Every voice still speaks.
  assert.deepEqual([...new Set(plan)].sort(), [0, 1, 2]);
});

test("favored voices get longer budgets, but every voice gets a real one", () => {
  assert.ok(debateWordBudget(1) > debateWordBudget(1 / 3));
  assert.ok(debateWordBudget(0) >= 90);
  assert.ok(debateCharBudget(1) > debateCharBudget(0));
  assert.ok(debateCharBudget(0) >= 700);
});

// ─── Turn message assembly ───────────────────────────────────────────────────

test("a turn sees its own prior turns as itself and the others as quoted data", () => {
  const voices = planDebateVoices("venom-gpt", FULL_CATALOG);
  const prior: DebateTurnRecord[] = [
    {
      turn: 0,
      voiceId: "venom-gpt",
      name: "Venom GPT",
      modelId: "venom-gpt",
      modelName: "Venom GPT",
      content: "Ship it Friday.",
      status: "ok",
    },
    {
      turn: 1,
      voiceId: "venom-claude",
      name: "Venom Claude",
      modelId: "venom-claude",
      modelName: "Venom Claude",
      content: "Friday releases burn weekends.",
      status: "ok",
    },
  ];
  const messages = buildDebateTurnMessages(
    BASE_MESSAGES,
    voices,
    0,
    prior,
    "close",
    140,
  );
  assert.match(messages[0].content, /You are "Venom GPT"/);
  assert.match(messages[0].content, /close the debate/);
  assert.match(messages[0].content, /under 140 words/);
  const tail = messages.slice(-2);
  assert.equal(tail[0].role, "assistant");
  assert.equal(tail[0].content, "Ship it Friday.");
  assert.equal(tail[1].role, "user");
  assert.match(tail[1].content, /^\[Venom Claude said\]\n/);
});

test("persona stances reach persona turns", () => {
  const voices = planDebateVoices("venom-gpt", SOLO_CATALOG);
  const messages = buildDebateTurnMessages(BASE_MESSAGES, voices, 1, [], "open", 120);
  assert.match(messages[0].content, /You are "Skeptic"/);
  assert.match(messages[0].content, /Your stance: Attack the assumptions/);
});

// ─── Round execution ─────────────────────────────────────────────────────────

test("an even round streams one attributed turn per voice, in order", async () => {
  const { outcome, events, calls } = collectDebate({
    "Venom GPT": ["Ship it. ", "The blockers are gone."],
    "Venom Claude": ["Hold. GPT ignores the weekend risk."],
    "Venom Gemini": ["Both right: ship Monday morning."],
  });
  const result = await outcome;

  assert.equal(result.turns.length, 3);
  assert.deepEqual(
    result.turns.map((turn) => turn.voiceId),
    ["venom-gpt", "venom-claude", "venom-gemini"],
  );
  assert.ok(result.turns.every((turn) => turn.status === "ok"));
  assert.equal(result.truncated, false);

  // Turn-start events announce speaker and position before any content.
  const starts = events.filter((event) => event.debateTurn);
  assert.equal(starts.length, 3);
  assert.deepEqual(
    starts.map((event) => (event.debateTurn as { voiceId: string }).voiceId),
    ["venom-gpt", "venom-claude", "venom-gemini"],
  );
  assert.equal(turnText(events, 0), "Ship it. The blockers are gone.");

  // Later voices actually saw the earlier turns as quoted data.
  const geminiCall = calls.find((call) => call.key === "Venom Gemini");
  assert.ok(geminiCall);
  const quoted = geminiCall.messages.map((message) => message.content).join("\n");
  assert.match(quoted, /\[Venom GPT said\]/);
  assert.match(quoted, /\[Venom Claude said\]/);

  // Statuses end each turn.
  assert.deepEqual(
    events
      .filter((event) => typeof event.turnStatus === "string")
      .map((event) => `${event.turn}:${event.turnStatus}`),
    ["0:ok", "1:ok", "2:ok"],
  );
});

test("a corner pin gives the favored voice the opening, middle, and closing word", async () => {
  const { outcome, calls } = collectDebate(
    {
      "Venom Claude": ["Claude speaks."],
      "Venom GPT": ["GPT replies."],
      "Venom Gemini": ["Gemini replies."],
    },
    {
      blend: [
        { id: "venom-claude", weight: 0.9 },
        { id: "venom-gpt", weight: 0.05 },
        { id: "venom-gemini", weight: 0.05 },
      ],
      requestedIds: ["venom-claude", "venom-gpt", "venom-gemini"],
    },
  );
  const result = await outcome;

  assert.equal(result.turns.length, 5);
  assert.deepEqual(
    result.turns.map((turn) => turn.voiceId),
    ["venom-claude", "venom-gpt", "venom-claude", "venom-gemini", "venom-claude"],
  );
  // Others still get their say.
  assert.ok(result.turns.some((turn) => turn.voiceId === "venom-gpt"));
  assert.ok(result.turns.some((turn) => turn.voiceId === "venom-gemini"));

  // Favored voice hears a bigger word budget than the others.
  const claudeSystem = calls.find((call) => call.key === "Venom Claude")?.messages[0]
    ?.content as string;
  const gptSystem = calls.find((call) => call.key === "Venom GPT")?.messages[0]
    ?.content as string;
  const budget = (system: string) =>
    Number(system.match(/under (\d+) words/)?.[1] ?? 0);
  assert.ok(budget(claudeSystem) > budget(gptSystem));
});

test("only authorized citations survive a debate turn", async () => {
  const { outcome, events } = collectDebate(
    {
      "Venom GPT": ["See [source:ok-1] and [source:forged] for detail."],
      "Venom Claude": ["No citations here."],
      "Venom Gemini": ["None here either."],
    },
    { allowed: ["ok-1"] },
  );
  const result = await outcome;
  const first = result.turns[0];
  assert.match(first.content, /\[source:ok-1\]/);
  assert.ok(!first.content.includes("forged"));
  assert.ok(!turnText(events, 0).includes("forged"));
});

test("a failed voice is reported and skipped without killing the round", async () => {
  const { outcome, events } = collectDebate({
    "Venom GPT": ["Opening take."],
    "Venom Claude": new Error("provider fell over"),
    "Venom Gemini": ["Closing take."],
  });
  const result = await outcome;

  assert.equal(result.turns.length, 3);
  assert.equal(result.turns[1].status, "failed");
  assert.equal(result.turns[1].content, "");
  assert.equal(result.turns[2].status, "ok");
  assert.deepEqual(
    events
      .filter((event) => typeof event.turnStatus === "string")
      .map((event) => event.turnStatus),
    ["ok", "failed", "ok"],
  );
});

test("a round where every voice fails throws a retryable error", async () => {
  const { outcome } = collectDebate({
    "Venom GPT": new Error("dead"),
    "Venom Claude": new Error("dead"),
    "Venom Gemini": new Error("dead"),
  });
  await assert.rejects(outcome, (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /No debate voice completed a turn/);
    return true;
  });
});

function billingDeadError() {
  return Object.assign(
    new Error(
      '400 {"type":"error","error":{"type":"invalid_request_error","message":"Your credit balance is too low to access the Anthropic API."}}',
    ),
    { status: 400 },
  );
}

test("a round where every voice dies billing-class names the account problem", async () => {
  const { outcome } = collectDebate({
    "Venom GPT": billingDeadError(),
    "Venom Claude": billingDeadError(),
    "Venom Gemini": billingDeadError(),
  });
  await assert.rejects(outcome, (error: unknown) => {
    assert.ok(error instanceof ProviderError);
    assert.equal(error.kind, "account_billing");
    assert.equal(error.retryable, false);
    assert.equal(error.message, PROVIDER_ACCOUNT_ERROR_MESSAGE);
    // The provider's own wording never leaves the server.
    assert.doesNotMatch(error.message, /credit balance|Anthropic/i);
    return true;
  });
});

test("a mixed all-failed round stays a generic retryable error", async () => {
  const { outcome } = collectDebate({
    "Venom GPT": billingDeadError(),
    "Venom Claude": new Error("dead"),
    "Venom Gemini": new Error("dead"),
  });
  await assert.rejects(outcome, (error: unknown) => {
    assert.ok(error instanceof ProviderError);
    assert.equal(error.kind, "generic");
    assert.equal(error.retryable, true);
    assert.match(error.message, /No debate voice completed a turn/);
    return true;
  });
});

test("the round budget ends the exchange early instead of blowing the window", async () => {
  let clock = 0;
  const { outcome } = collectDebate(
    {
      "Venom GPT": ["First turn."],
      "Venom Claude": ["Second turn."],
      "Venom Gemini": ["Should never run."],
    },
    {
      roundBudgetMs: 10_000,
      now: () => {
        // Each call advances the fake clock; two turns exhaust the budget.
        clock += 4_000;
        return clock;
      },
    },
  );
  const result = await outcome;
  assert.ok(result.turns.length < 3);
  assert.equal(result.truncated, true);
});

test("aborting mid-round stops cleanly with the turns that finished", async () => {
  const controller = new AbortController();
  const { outcome } = collectDebate(
    {
      "Venom GPT": ["Done before the stop."],
      "Venom Claude": (async function* () {
        controller.abort();
        yield "never seen";
      }) as Script,
      "Venom Gemini": ["Unreachable."],
    },
    { signal: controller.signal },
  );
  const result = await outcome;
  assert.equal(result.turns.length, 1);
  assert.equal(result.turns[0].status, "ok");
});

test("a turn is capped at its character budget at the emission boundary", async () => {
  const long = "x".repeat(10_000);
  let secondChunkServed = false;
  const { outcome, events } = collectDebate({
    "Venom GPT": (async function* () {
      yield long;
      secondChunkServed = true;
      yield long;
    }) as Script,
    "Venom Claude": ["Short."],
    "Venom Gemini": ["Short."],
  });
  const result = await outcome;
  const cap = debateCharBudget(1 / 3);

  // The bound holds on the emitted SSE stream itself — what clients render,
  // accumulate, and persist — not just the internal record: one oversized
  // provider chunk is cut to the remaining budget before emission.
  const streamed = turnText(events, 0);
  assert.equal(streamed.length, cap);

  // The provider stream is terminated at the boundary, not drained.
  assert.equal(secondChunkServed, false);

  // Server record and streamed content agree, so a synced conversation can
  // never diverge from what the round actually streamed.
  assert.equal(result.turns[0].content, streamed.trim());
  assert.ok(result.turns[0].content.length <= cap);
});

test("an oversized citation-filter flush is also bounded", async () => {
  // A buffered `[source:...]` tail released by flush() goes through the same
  // capped forward path as ordinary tokens.
  const cap = debateCharBudget(1 / 3);
  const nearCap = "y".repeat(cap - 10);
  const hugeTail = ` ${"z".repeat(5_000)}`;
  const { outcome, events } = collectDebate({
    "Venom GPT": [nearCap, hugeTail],
    "Venom Claude": ["Short."],
    "Venom Gemini": ["Short."],
  });
  const result = await outcome;
  const streamed = turnText(events, 0);
  assert.equal(streamed.length, cap);
  assert.equal(result.turns[0].content, streamed.trim());
});

// ─── Verify weights in the synthesis ────────────────────────────────────────

test("blend weights annotate and order the synthesis takes", () => {
  const messages = buildSynthesisMessages(BASE_MESSAGES, [
    { name: "Skeptic", modelName: "Venom Claude", content: "Risky.", influence: 0.6 },
    { name: "First take", modelName: "Venom GPT", content: "Ship it.", influence: 0.25 },
  ]);
  const prompt = messages[messages.length - 1].content;
  assert.match(prompt, /\[Skeptic — Venom Claude — influence 60%\]/);
  assert.match(prompt, /\[First take — Venom GPT — influence 25%\]/);
  assert.match(prompt, /Weigh the takes by their influence percentages/);
  assert.ok(prompt.indexOf("Skeptic") < prompt.indexOf("First take"));
});

test("without weights the synthesis prompt is unchanged", () => {
  const messages = buildSynthesisMessages(BASE_MESSAGES, [
    { name: "First take", modelName: "Venom GPT", content: "Ship it." },
  ]);
  const prompt = messages[messages.length - 1].content;
  assert.match(prompt, /\[First take — Venom GPT\]/);
  assert.ok(!prompt.includes("influence"));
});

// ─── Request contract ────────────────────────────────────────────────────────

test("the chat request accepts a mode and bounded blend weights", () => {
  const parsed = SendVenomMessageBody.safeParse({
    messages: [{ role: "user", content: "hi" }],
    projectId: "proj_1",
    mode: "debate",
    blend: [
      { id: "venom-gpt", weight: 0.5 },
      { id: "venom-claude", weight: 0.3 },
      { id: "venom-gemini", weight: 0.2 },
    ],
  });
  assert.ok(parsed.success);
  assert.equal(parsed.data?.mode, "debate");
});

test("out-of-range weights and oversized blends are rejected", () => {
  assert.equal(
    SendVenomMessageBody.safeParse({
      messages: [{ role: "user", content: "hi" }],
      projectId: "proj_1",
      mode: "debate",
      blend: [{ id: "venom-gpt", weight: 2 }],
    }).success,
    false,
  );
  assert.equal(
    SendVenomMessageBody.safeParse({
      messages: [{ role: "user", content: "hi" }],
      projectId: "proj_1",
      mode: "verify",
      blend: [
        { id: "a", weight: 0.25 },
        { id: "b", weight: 0.25 },
        { id: "c", weight: 0.25 },
        { id: "d", weight: 0.25 },
      ],
    }).success,
    false,
  );
  assert.equal(
    SendVenomMessageBody.safeParse({
      messages: [{ role: "user", content: "hi" }],
      projectId: "proj_1",
      mode: "shout",
    }).success,
    false,
  );
});
