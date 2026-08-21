/**
 * venom-voice-restraint.test.ts — unit tests for the restraint decision core.
 *
 * The hard requirement under test: questions, direct address, commands, and
 * answers to the bot's own question ALWAYS resolve to "respond" — restraint
 * may only quiet remarks that don't invite a reply.
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
  decideFromHeuristics,
  extractVoiceTurnSignals,
  normalizeTalkativeness,
  parseJudgeVerdict,
  pickAcknowledgment,
  LONG_UTTERANCE_WORDS,
  type VoiceRecentTurn,
} from "./venom-voice-restraint";

function decide(
  transcript: string,
  talkativeness: "chatty" | "balanced" | "reserved" = "balanced",
  recentTurns: VoiceRecentTurn[] = [],
) {
  const signals = extractVoiceTurnSignals(transcript, recentTurns);
  return { signals, verdict: decideFromHeuristics(signals, talkativeness) };
}

// ── The hard bias: real requests always get a reply ──────────────────────────

test("questions always respond, at every talkativeness", () => {
  for (const talkativeness of ["chatty", "balanced", "reserved"] as const) {
    for (const transcript of [
      "What's on the board today?",
      "can you summarize that again",
      "is there anything blocked",
      "why did that happen",
      "do you think this plan works",
      "how about the second option",
    ]) {
      const { verdict } = decide(transcript, talkativeness);
      assert.equal(
        verdict.decision,
        "respond",
        `"${transcript}" (${talkativeness}) must respond`,
      );
      assert.equal(verdict.confident, true, "questions skip the judge");
      assert.equal(verdict.windDown, false);
    }
  }
});

test("direct address by name always responds", () => {
  const { verdict, signals } = decide("okay venom run with that", "reserved");
  assert.equal(signals.directAddress, true);
  assert.equal(verdict.decision, "respond");
  assert.equal(verdict.confident, true);
});

test("imperative requests always respond", () => {
  for (const transcript of [
    "add a task for the release notes",
    "summarize the last meeting",
    "remember that the deadline moved",
  ]) {
    const { verdict } = decide(transcript, "reserved");
    assert.equal(verdict.decision, "respond", `"${transcript}" must respond`);
    assert.equal(verdict.confident, true);
  }
});

test("a short reply to the bot's own question is an answer, not filler", () => {
  const recent: VoiceRecentTurn[] = [
    { role: "user", content: "walk me through the options" },
    { role: "assistant", content: "There are two paths. Want the fast one?" },
  ];
  const { verdict, signals } = decide("yeah", "reserved", recent);
  assert.equal(signals.answeringBotQuestion, true);
  assert.equal(verdict.decision, "respond");
  assert.equal(verdict.confident, true);
});

test("long utterances get engagement regardless of mood", () => {
  const transcript =
    "so I moved the launch to Thursday because the vendor slipped and the demo environment is still rebuilding";
  const { signals, verdict } = decide(transcript, "reserved");
  assert.ok(signals.wordCount >= LONG_UTTERANCE_WORDS);
  assert.equal(verdict.decision, "respond");
  assert.equal(verdict.confident, true);
});

// ── Restraint: backchannels, thanks, farewells ───────────────────────────────

test("pure backchannels go silent on balanced and reserved", () => {
  for (const transcript of ["okay yeah", "hm makes sense", "right right", "cool cool"]) {
    for (const talkativeness of ["balanced", "reserved"] as const) {
      const { verdict, signals } = decide(transcript, talkativeness);
      assert.equal(signals.backchannel, true, `"${transcript}" is backchannel`);
      assert.equal(
        verdict.decision,
        "silent",
        `"${transcript}" (${talkativeness}) stays quiet`,
      );
      assert.equal(verdict.confident, true);
    }
  }
});

test("chatty gives backchannels a brief nod instead of silence", () => {
  const { verdict } = decide("okay yeah", "chatty");
  assert.equal(verdict.decision, "acknowledge");
  assert.equal(verdict.confident, true);
});

test("a backchannel after trailing short turns reads as wind-down", () => {
  const dyingMomentum: VoiceRecentTurn[] = [
    { role: "user", content: "what's left on the list" },
    { role: "assistant", content: "Just the review. Nothing else." },
    { role: "user", content: "nice okay" },
    { role: "assistant", content: "Mm-hm." },
  ];
  const { verdict } = decide("alright cool", "balanced", dyingMomentum);
  assert.equal(verdict.decision, "silent");
  assert.equal(verdict.windDown, true, "dying momentum arms wind-down");

  // Fresh momentum: the last user turn was substantial → no wind-down.
  const freshMomentum: VoiceRecentTurn[] = [
    { role: "user", content: "walk me through the whole deploy plan again" },
    { role: "assistant", content: "Sure. Step one is the build." },
  ];
  const fresh = decide("okay yeah", "balanced", freshMomentum);
  assert.equal(fresh.verdict.windDown, false);
});

test("short thanks earns a warm one-liner, not a paragraph", () => {
  const { verdict, signals } = decide("thanks a lot", "balanced");
  assert.equal(signals.gratitude, true);
  assert.equal(verdict.decision, "acknowledge");
  assert.equal(verdict.windDown, false);
  assert.equal(verdict.confident, true);
});

test("gratitude with a question is still a question", () => {
  const { verdict } = decide("thanks — can you also check the logs?", "reserved");
  assert.equal(verdict.decision, "respond");
});

test("farewells wind the session down with at most a closer", () => {
  for (const transcript of [
    "alright good night",
    "gotta go, talk later",
    "that's all for now",
    "bye",
    "later venom",
  ]) {
    for (const talkativeness of ["chatty", "balanced", "reserved"] as const) {
      const { verdict, signals } = decide(transcript, talkativeness);
      assert.equal(signals.farewell, true, `"${transcript}" is a farewell`);
      assert.equal(verdict.decision, "acknowledge");
      assert.equal(verdict.windDown, true, `"${transcript}" winds down`);
      assert.equal(verdict.confident, true);
    }
  }
});

test("'maybe' does not trip the bye detector", () => {
  const { signals } = decide("maybe we should refactor it");
  assert.equal(signals.farewell, false);
});

test("a goodbye phrased as a question still gets a real answer", () => {
  const { verdict } = decide("before I go — is the backup running?");
  assert.equal(verdict.decision, "respond");
  assert.equal(verdict.windDown, false);
});

// ── Ambiguity: where the judge is allowed in ─────────────────────────────────

test("thinking aloud is silent for reserved, uncertain for others", () => {
  const reserved = decide("i wonder if the cache is the problem", "reserved");
  assert.equal(reserved.verdict.decision, "silent");
  assert.equal(reserved.verdict.confident, true);

  const balanced = decide("i wonder if the cache is the problem", "balanced");
  assert.equal(balanced.verdict.confident, false, "balanced defers to judge");

  const chatty = decide("i wonder if the cache is the problem", "chatty");
  assert.equal(chatty.verdict.confident, false);
  assert.equal(chatty.verdict.decision, "respond", "chatty leans respond");
});

test("unclear medium statements: chatty answers, others consult the judge", () => {
  const transcript = "the design still feels a little heavy";
  const chatty = decide(transcript, "chatty");
  assert.equal(chatty.verdict.decision, "respond");
  assert.equal(chatty.verdict.confident, true);

  const balanced = decide(transcript, "balanced");
  assert.equal(balanced.verdict.decision, "respond", "uncertain leans respond");
  assert.equal(balanced.verdict.confident, false);

  const reserved = decide(transcript, "reserved");
  assert.equal(reserved.verdict.confident, false);
});

// ── Helpers ──────────────────────────────────────────────────────────────────

test("normalizeTalkativeness accepts only known levels", () => {
  assert.equal(normalizeTalkativeness("chatty"), "chatty");
  assert.equal(normalizeTalkativeness("reserved"), "reserved");
  assert.equal(normalizeTalkativeness("balanced"), "balanced");
  assert.equal(normalizeTalkativeness("loud"), "balanced");
  assert.equal(normalizeTalkativeness(undefined), "balanced");
  assert.equal(normalizeTalkativeness(42), "balanced");
});

test("parseJudgeVerdict rejects anything but a clean verdict", () => {
  assert.deepEqual(parseJudgeVerdict('{"decision":"silent","windDown":true}'), {
    decision: "silent",
    windDown: true,
  });
  assert.deepEqual(parseJudgeVerdict('{"decision":"respond"}'), {
    decision: "respond",
    windDown: false,
  });
  assert.equal(parseJudgeVerdict('{"decision":"shout"}'), null);
  assert.equal(parseJudgeVerdict("not json"), null);
  assert.equal(parseJudgeVerdict('{"windDown":true}'), null);
});

test("acknowledgment lines match the moment", () => {
  const thanks = extractVoiceTurnSignals("thanks so much");
  const ackForThanks = pickAcknowledgment(thanks, false, "thanks so much", "seed");
  assert.ok(
    ["Anytime.", "Of course.", "Happy to help."].includes(ackForThanks),
    `gratitude pool, got "${ackForThanks}"`,
  );

  const night = extractVoiceTurnSignals("alright good night");
  const closer = pickAcknowledgment(night, true, "alright good night", "seed");
  assert.ok(
    ["Good night.", "Sleep well.", "Rest up."].includes(closer),
    `night closer pool, got "${closer}"`,
  );

  const generic = extractVoiceTurnSignals("gotcha");
  const nod = pickAcknowledgment(generic, false, "gotcha", "seed");
  assert.ok(nod.length > 0 && nod.length <= 40, "nods stay short");

  // Deterministic in the seed: same seed, same line.
  assert.equal(
    pickAcknowledgment(generic, false, "gotcha", "abc"),
    pickAcknowledgment(generic, false, "gotcha", "abc"),
  );
});
