import assert from "node:assert/strict";
import test from "node:test";
import { SendVenomMessageBody } from "@workspace/api-zod";
import {
  buildDeliberationAvailability,
  buildSynthesisMessages,
  createDisagreementSplitter,
  DELIBERATION_VOICES,
  DISAGREEMENT_MARKER,
  MAX_DISAGREEMENT_CHARS,
  MAX_DISAGREEMENTS,
  parseDisagreementNotes,
  planDeliberationVoices,
  runDeliberation,
  withVoicePrompt,
} from "./venom-deliberation";
import { ProviderError, type VenomMessage } from "./venom-provider-adapters";
import type { VenomManagedModel } from "./venom-models";

function catalogEntry(
  id: VenomManagedModel["id"],
  name: string,
  available: boolean,
): VenomManagedModel {
  return {
    id,
    provider: "openai",
    name,
    family: "GPT",
    summary: "",
    available,
    availabilityText: available ? "Ready" : "Not configured",
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
 * Fake provider keyed by which voice (or the synthesis) is being asked:
 * voice passes carry the voice name in their system prompt, the synthesis
 * pass carries the merge instructions in its final user message.
 */
function scriptedStreamModel(scripts: Record<string, Script>) {
  const calls: Array<{ key: string; modelId: string }> = [];
  const streamModel = ((
    modelId: string,
    messages: VenomMessage[],
    signal?: AbortSignal,
  ) => {
    const system = messages[0]?.content ?? "";
    const last = messages[messages.length - 1]?.content ?? "";
    const voice = DELIBERATION_VOICES.find((entry) =>
      system.includes(`"${entry.name}"`),
    );
    const key = last.includes("collective voice")
      ? "synthesis"
      : (voice?.id ?? "unknown");
    calls.push({ key, modelId });
    const script = scripts[key];
    return (async function* () {
      if (!script) return;
      if (script instanceof Error) throw script;
      if (typeof script === "function") {
        yield* script(signal);
        return;
      }
      for (const chunk of script) {
        if (signal?.aborted) return;
        yield chunk;
      }
    })();
  }) as never;
  return { streamModel, calls };
}

function collectRun(scripts: Record<string, Script>, options?: {
  catalog?: VenomManagedModel[];
  allowed?: string[];
  voiceTimeoutMs?: number;
  resolveMarker?: (citationId: string) => string | null;
}) {
  const catalog = options?.catalog ?? FULL_CATALOG;
  const { streamModel, calls } = scriptedStreamModel(scripts);
  const events: Array<Record<string, unknown>> = [];
  const outcome = runDeliberation({
    baseMessages: BASE_MESSAGES,
    voices: planDeliberationVoices("venom-gpt", catalog),
    synthesisModelId: "venom-gpt",
    allowedCitationIds: new Set(options?.allowed ?? []),
    ...(options?.resolveMarker
      ? { citationFilterOptions: { resolveMarker: options.resolveMarker } }
      : {}),
    signal: new AbortController().signal,
    emit: (event) => events.push(event),
    voiceTimeoutMs: options?.voiceTimeoutMs ?? 5_000,
    retryDelayMs: 0,
    streamModel,
  });
  return { outcome, events, calls };
}

function voiceText(events: Array<Record<string, unknown>>, voiceId: string) {
  return events
    .filter((event) => event.voice === voiceId && typeof event.content === "string")
    .map((event) => event.content)
    .join("");
}

function answerText(events: Array<Record<string, unknown>>) {
  return events
    .filter((event) => event.voice === undefined && typeof event.content === "string")
    .map((event) => event.content)
    .join("");
}

// ── Planning ────────────────────────────────────────────────────────────────

test("voices map to distinct available providers, anchored on the requested model", () => {
  const planned = planDeliberationVoices("venom-gpt", FULL_CATALOG);
  assert.deepEqual(
    planned.map((voice) => [voice.id, voice.modelId]),
    [
      ["direct", "venom-gpt"],
      ["skeptic", "venom-claude"],
      ["evidence", "venom-gemini"],
    ],
  );
  assert.equal(planned[1].modelName, "Venom Claude");
});

test("voices fall back to personas on the anchor model when only one provider is configured", () => {
  const planned = planDeliberationVoices("venom-gpt", SOLO_CATALOG);
  assert.deepEqual(
    planned.map((voice) => voice.modelId),
    ["venom-gpt", "venom-gpt", "venom-gpt"],
  );
  // Personas stay distinct even when the model is shared.
  assert.equal(new Set(planned.map((voice) => voice.stance)).size, 3);
});

test("planning rejects an anchor that is not in the catalog", () => {
  assert.throws(
    () => planDeliberationVoices("venom-gpt", []),
    ProviderError,
  );
});

test("availability reflects configured providers and lists the neutral roster", () => {
  const availability = buildDeliberationAvailability(FULL_CATALOG);
  assert.equal(availability.available, true);
  assert.equal(availability.distinctModels, true);
  assert.deepEqual(
    availability.voices.map((voice) => voice.voiceId),
    ["direct", "skeptic", "evidence"],
  );
  assert.ok(availability.voices.every((voice) => voice.name && voice.tagline));

  const solo = buildDeliberationAvailability(SOLO_CATALOG);
  assert.equal(solo.available, true);
  assert.equal(solo.distinctModels, false);

  const none = buildDeliberationAvailability(
    SOLO_CATALOG.map((model) => ({ ...model, available: false })),
  );
  assert.equal(none.available, false);
});

// ── Prompts ─────────────────────────────────────────────────────────────────

test("voice prompts extend the shared system prompt without touching history", () => {
  const voice = DELIBERATION_VOICES[1];
  const prompted = withVoicePrompt(BASE_MESSAGES, voice);
  assert.ok(prompted[0].content.startsWith("You are Venom."));
  assert.ok(prompted[0].content.includes(`"${voice.name}"`));
  assert.ok(prompted[0].content.includes(voice.stance));
  assert.deepEqual(prompted[1], BASE_MESSAGES[1]);
  assert.equal(BASE_MESSAGES[0].content, "You are Venom.");
});

test("synthesis request quotes the takes and demands the disagreement block", () => {
  const messages = buildSynthesisMessages(BASE_MESSAGES, [
    { name: "First take", modelName: "Venom GPT", content: "Ship it." },
    { name: "Skeptic", modelName: "Venom Claude", content: "Do not ship." },
  ]);
  const last = messages[messages.length - 1];
  assert.equal(last.role, "user");
  assert.ok(last.content.includes("[First take — Venom GPT]\nShip it."));
  assert.ok(last.content.includes("[Skeptic — Venom Claude]\nDo not ship."));
  assert.ok(last.content.includes(DISAGREEMENT_MARKER));
  assert.deepEqual(messages.slice(0, -1), BASE_MESSAGES);
});

// ── Disagreement splitting ──────────────────────────────────────────────────

test("splitter withholds the marker even when it is torn across chunks", () => {
  const splitter = createDisagreementSplitter();
  let forwarded = splitter.push("The answer. <<");
  forwarded += splitter.push("<DISAGREEMENTS>>>\n- First take vs Skeptic: risk.\n- none\n");
  const final = splitter.flush();
  assert.equal(forwarded, "The answer.");
  assert.equal(final.content, "");
  assert.deepEqual(final.disagreements, ["First take vs Skeptic: risk."]);
});

test("splitter passes ordinary angle brackets through", () => {
  const splitter = createDisagreementSplitter();
  let forwarded = splitter.push("a <");
  forwarded += splitter.push("b> and <<c");
  const final = splitter.flush();
  forwarded += final.content;
  assert.equal(forwarded, "a <b> and <<c");
  assert.deepEqual(final.disagreements, []);
});

test("disagreement notes are trimmed, de-bulleted, capped, and 'none' is dropped", () => {
  assert.deepEqual(parseDisagreementNotes("- none"), []);
  assert.deepEqual(parseDisagreementNotes("None."), []);
  const many = Array.from({ length: 12 }, (_, i) => `- point ${i}`).join("\n");
  assert.equal(parseDisagreementNotes(many).length, MAX_DISAGREEMENTS);
  const long = parseDisagreementNotes(`- ${"x".repeat(900)}`);
  assert.equal(long[0].length, MAX_DISAGREEMENT_CHARS);
  assert.deepEqual(parseDisagreementNotes("• spaced   note  "), ["spaced   note"]);
});

// ── Orchestration ───────────────────────────────────────────────────────────

test("deliberation streams voice takes, filters citations, then synthesizes with disagreements", async () => {
  const { outcome, events, calls } = collectRun(
    {
      direct: ["Ship it [source:good]. ", "Also [source:evil] fine."],
      skeptic: ["Too risky."],
      evidence: ["Sources say ready [source:good]."],
      synthesis: [
        "Collective: ship carefully [source:good].",
        "\n",
        DISAGREEMENT_MARKER,
        "\n- First take vs Skeptic: risk tolerance.\n- none",
      ],
    },
    { allowed: ["good"] },
  );
  const result = await outcome;

  // Voice streams kept authorized markers and stripped the rest.
  assert.equal(voiceText(events, "direct"), "Ship it [source:good]. Also  fine.");
  assert.equal(voiceText(events, "evidence"), "Sources say ready [source:good].");

  // Every voice reported a terminal status before the synthesis stage.
  const statuses = events.filter((event) => event.voiceStatus);
  assert.equal(statuses.length, 3);
  assert.ok(statuses.every((event) => event.voiceStatus === "ok"));
  const stageIndex = events.findIndex((event) => event.stage === "synthesis");
  assert.ok(stageIndex > events.findIndex((event) => Boolean(event.voiceStatus)));

  // The collective answer streams as plain content, marker never leaks.
  assert.equal(answerText(events), "Collective: ship carefully [source:good].");
  assert.ok(
    events.every(
      (event) =>
        typeof event.content !== "string" ||
        !event.content.includes(DISAGREEMENT_MARKER),
    ),
  );

  assert.deepEqual(result.disagreements, ["First take vs Skeptic: risk tolerance."]);
  assert.equal(result.synthesisFellBack, false);
  assert.equal(result.takes.length, 3);
  assert.ok(result.takes.every((take) => take.status === "ok"));

  // Distinct providers actually served distinct voices; synthesis on anchor.
  const byKey = Object.fromEntries(calls.map((call) => [call.key, call.modelId]));
  assert.equal(byKey.direct, "venom-gpt");
  assert.equal(byKey.skeptic, "venom-claude");
  assert.equal(byKey.evidence, "venom-gemini");
  assert.equal(byKey.synthesis, "venom-gpt");
});

test("workspace citation markers resolve to labels in every voice and the synthesis", async () => {
  // Mirrors the respond route's workspace setup: the wsk- id is allowed for
  // this request, but its marker must leave the stream as a plain-text label
  // because deliberation output is persisted in personal synced state.
  const { outcome, events } = collectRun(
    {
      direct: ["Per [source:wsk-c1] the runbook says restart."],
      skeptic: ["Doubtful [source:wsk-c1]", " but plausible."],
      evidence: ["Team notes agree [source:wsk-c1]."],
      synthesis: [
        "Restart first [source:wsk-c1], per the shared runbook.",
        `\n${DISAGREEMENT_MARKER}\n- none`,
      ],
    },
    {
      allowed: ["wsk-c1"],
      resolveMarker: (citationId) =>
        citationId === "wsk-c1" ? "[Workspace: Ops runbook]" : null,
    },
  );
  const result = await outcome;

  // No structured workspace marker survives anywhere a client persists.
  const allStreamed = events
    .map((event) => (typeof event.content === "string" ? event.content : ""))
    .join("");
  assert.ok(!allStreamed.includes("wsk-"));
  assert.ok(!JSON.stringify(result).includes("[source:"));

  assert.equal(
    voiceText(events, "direct"),
    "Per [Workspace: Ops runbook] the runbook says restart.",
  );
  // Torn across chunks: the filter still resolves the split marker.
  assert.equal(
    voiceText(events, "skeptic"),
    "Doubtful [Workspace: Ops runbook] but plausible.",
  );
  assert.equal(
    answerText(events),
    "Restart first [Workspace: Ops runbook], per the shared runbook.",
  );
  // Persisted takes carry the resolved label too.
  const skepticTake = result.takes.find((take) => take.voiceId === "skeptic");
  assert.equal(skepticTake?.content, "Doubtful [Workspace: Ops runbook] but plausible.");
});

test("a failed voice is flagged and the turn still completes from the rest", async () => {
  const { outcome, events } = collectRun({
    direct: ["Ship it."],
    skeptic: new ProviderError("provider down", 500, false),
    evidence: ["Evidence is thin."],
    synthesis: ["Collective answer.", `\n${DISAGREEMENT_MARKER}\n- none`],
  });
  const result = await outcome;

  assert.ok(
    events.some(
      (event) => event.voice === "skeptic" && event.voiceStatus === "failed",
    ),
  );
  const skeptic = result.takes.find((take) => take.voiceId === "skeptic");
  assert.equal(skeptic?.status, "failed");
  assert.equal(skeptic?.content, "");
  assert.equal(answerText(events), "Collective answer.");
  assert.equal(result.synthesisFellBack, false);
});

test("the turn fails as retryable only when every voice fails", async () => {
  const { outcome } = collectRun({
    direct: new ProviderError("down", 500, false),
    skeptic: new ProviderError("down", 500, false),
    evidence: new ProviderError("down", 500, false),
  });
  await assert.rejects(outcome, (error: unknown) => {
    assert.ok(error instanceof ProviderError);
    assert.equal(error.retryable, true);
    return true;
  });
});

test("a dead synthesis falls back to the strongest take so the turn completes", async () => {
  const { outcome, events } = collectRun({
    direct: ["Direct fallback take."],
    skeptic: ["Skeptic take."],
    evidence: ["Evidence take."],
    synthesis: new ProviderError("synthesis died", 500, false),
  });
  const result = await outcome;
  assert.equal(result.synthesisFellBack, true);
  assert.equal(answerText(events), "Direct fallback take.");
  assert.equal(result.content, "Direct fallback take.");
  assert.deepEqual(result.disagreements, []);
});

test("a voice that overruns its budget keeps its partial take", async () => {
  const { outcome } = collectRun(
    {
      direct: ["Quick answer."],
      skeptic: ["Quick doubt."],
      evidence: (signal) =>
        (async function* () {
          yield "Partial evidence so far.";
          await new Promise<void>((resolve) => {
            if (!signal || signal.aborted) return resolve();
            signal.addEventListener("abort", () => resolve(), { once: true });
          });
        })(),
      synthesis: ["Collective answer.", `\n${DISAGREEMENT_MARKER}\n- none`],
    },
    { voiceTimeoutMs: 60 },
  );
  const result = await outcome;
  const evidence = result.takes.find((take) => take.voiceId === "evidence");
  assert.equal(evidence?.status, "ok");
  assert.equal(evidence?.content, "Partial evidence so far.");
});

// ── Request contract ────────────────────────────────────────────────────────

test("the chat request contract accepts the opt-in flag and rejects junk", () => {
  const base = {
    messages: [
      { id: "m1", role: "user", content: "hi", createdAt: 1, status: "sent" },
    ],
    projectId: "project-1",
  };
  assert.equal(SendVenomMessageBody.safeParse(base).success, true);
  assert.equal(
    SendVenomMessageBody.safeParse({ ...base, deliberate: true }).success,
    true,
  );
  assert.equal(
    SendVenomMessageBody.safeParse({ ...base, deliberate: "yes" }).success,
    false,
  );
});
