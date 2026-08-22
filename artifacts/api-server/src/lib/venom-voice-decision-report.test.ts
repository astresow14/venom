/**
 * venom-voice-decision-report.test.ts — unit tests for the pure evidence
 * layer: rate classification (which outcomes settle which metric), the
 * decisions × outcomes × talkativeness cell matrix, threshold echoing, and
 * the JSONL training records.
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
  PENDING_OUTCOME,
  summarizeVoiceDecisions,
  voiceDecisionExportJsonl,
  voiceDecisionTrainingRecord,
  voiceRestraintThresholds,
  VOICE_DECISION_MAX_AGE_DAYS,
  VOICE_DECISION_MAX_ROWS_PER_USER,
  VOICE_DECISION_PREVIEW_CHARS,
  VOICE_DECISION_REPORT_MAX_ROWS,
  type StoredVoiceDecision,
} from "./venom-voice-decision-report";
import {
  BACKCHANNEL_MAX_WORDS,
  BOT_ANSWER_MAX_WORDS,
  LONG_UTTERANCE_WORDS,
  SHORT_GRATITUDE_MAX_WORDS,
  SHORT_TURN_MAX_WORDS,
  WIND_DOWN_TRAILING_SHORT_TURNS,
} from "./venom-voice-restraint";

const SINCE = new Date("2026-07-22T00:00:00.000Z");
const GENERATED_AT = new Date("2026-08-21T09:30:00.000Z");
const OPTIONS = { windowDays: 30, since: SINCE, generatedAt: GENERATED_AT };

let sequence = 0;
function row(
  overrides: Partial<StoredVoiceDecision> = {},
): StoredVoiceDecision {
  sequence += 1;
  return {
    id: `vd-${sequence}`,
    decision: "silent",
    windDown: false,
    source: "heuristic",
    talkativeness: "balanced",
    transcriptPreview: "okay yeah",
    transcriptChars: 9,
    signals: { backchannel: true },
    outcome: null,
    outcomeAt: null,
    createdAt: new Date("2026-08-10T10:00:00.000Z"),
    ...overrides,
  };
}

test("an empty log summarizes to zeros and null rates, never fake 0%", () => {
  const summary = summarizeVoiceDecisions([], OPTIONS);

  assert.equal(summary.windowDays, 30);
  assert.equal(summary.since, SINCE.toISOString());
  assert.equal(summary.generatedAt, GENERATED_AT.toISOString());
  assert.equal(summary.overall.decisions, 0);
  assert.equal(summary.overall.withOutcome, 0);
  assert.equal(summary.overall.outcomeCoverage, 0);
  assert.deepEqual(summary.overall.quietRegret, {
    settled: 0,
    hits: 0,
    rate: null,
  });
  assert.deepEqual(summary.overall.spokenInterruption, {
    settled: 0,
    hits: 0,
    rate: null,
  });
  assert.deepEqual(summary.overall.windDownClean, {
    settled: 0,
    hits: 0,
    rate: null,
  });
  assert.deepEqual(summary.byTalkativeness, []);
  assert.deepEqual(summary.cells, []);
  assert.deepEqual(summary.thresholds, voiceRestraintThresholds());
});

test("thresholds echo the restraint constants and log policy verbatim", () => {
  assert.deepEqual(voiceRestraintThresholds(), {
    longUtteranceWords: LONG_UTTERANCE_WORDS,
    backchannelMaxWords: BACKCHANNEL_MAX_WORDS,
    shortGratitudeMaxWords: SHORT_GRATITUDE_MAX_WORDS,
    botAnswerMaxWords: BOT_ANSWER_MAX_WORDS,
    shortTurnMaxWords: SHORT_TURN_MAX_WORDS,
    windDownTrailingShortTurns: WIND_DOWN_TRAILING_SHORT_TURNS,
    retentionDays: VOICE_DECISION_MAX_AGE_DAYS,
    maxRowsPerUser: VOICE_DECISION_MAX_ROWS_PER_USER,
    transcriptPreviewChars: VOICE_DECISION_PREVIEW_CHARS,
  });
  assert.equal(
    VOICE_DECISION_REPORT_MAX_ROWS,
    VOICE_DECISION_MAX_ROWS_PER_USER * 2,
    "report reads absorb prune lag by allowing twice the per-user cap",
  );
});

test("each metric settles only on its own decision slice", () => {
  const summary = summarizeVoiceDecisions(
    [
      // Quiet regret: silent, no wind-down.
      row({ outcome: "user_followed_up", outcomeAt: new Date() }),
      row({ outcome: "stayed_quiet", outcomeAt: new Date() }),
      row({ outcome: "stayed_quiet", outcomeAt: new Date() }),
      // A silent wind-down goodbye belongs to the wind-down read instead —
      // its re-engagement settles windDownClean, not quietRegret.
      row({
        windDown: true,
        outcome: "user_followed_up",
        outcomeAt: new Date(),
      }),
      // Spoken decisions: one interrupted, one completed, one pending.
      row({
        decision: "respond",
        outcome: "reply_interrupted",
        outcomeAt: new Date(),
      }),
      row({
        decision: "acknowledge",
        outcome: "reply_completed",
        outcomeAt: new Date(),
      }),
      row({ decision: "respond" }),
      // session_closed carries an outcome but settles no rate.
      row({ outcome: "session_closed", outcomeAt: new Date() }),
      // Unknown historical values are counted but never mis-bucketed.
      row({
        decision: "mystery",
        source: "oracle",
        outcome: "session_closed",
        outcomeAt: new Date(),
      }),
    ],
    OPTIONS,
  );

  assert.equal(summary.overall.decisions, 9);
  assert.equal(summary.overall.withOutcome, 8);
  assert.equal(summary.overall.outcomeCoverage, 0.8889);
  assert.deepEqual(summary.overall.decisionCounts, {
    respond: 2,
    acknowledge: 1,
    silent: 5,
  });
  assert.deepEqual(summary.overall.sourceCounts, {
    heuristic: 8,
    model: 0,
    fallback: 0,
  });
  assert.equal(summary.overall.windDownFlagged, 1);
  // 1 re-ask vs 2 stayed quiet → 1/3, rounded to 4 decimals.
  assert.deepEqual(summary.overall.quietRegret, {
    settled: 3,
    hits: 1,
    rate: 0.3333,
  });
  assert.deepEqual(summary.overall.spokenInterruption, {
    settled: 2,
    hits: 1,
    rate: 0.5,
  });
  // The goodbye was pulled back open: settled once, zero clean closes — a
  // real 0%, distinct from the null "no data yet".
  assert.deepEqual(summary.overall.windDownClean, {
    settled: 1,
    hits: 0,
    rate: 0,
  });
});

test("cells count duplicate combinations and sort canonically", () => {
  const shuffled = [
    row({ talkativeness: "verbose" }), // unknown level sorts last
    row({ decision: "respond", source: "fallback" }),
    row({ outcome: "stayed_quiet", outcomeAt: new Date() }),
    row({ decision: "respond", source: "model" }),
    row({ talkativeness: "chatty", windDown: true, outcome: "wound_down", outcomeAt: new Date() }),
    row({ outcome: "stayed_quiet", outcomeAt: new Date() }), // duplicate tuple
  ];
  const summary = summarizeVoiceDecisions(shuffled, OPTIONS);

  assert.deepEqual(summary.cells, [
    {
      talkativeness: "chatty",
      decision: "silent",
      windDown: true,
      source: "heuristic",
      outcome: "wound_down",
      count: 1,
    },
    {
      talkativeness: "balanced",
      decision: "respond",
      windDown: false,
      source: "model",
      outcome: PENDING_OUTCOME,
      count: 1,
    },
    {
      talkativeness: "balanced",
      decision: "respond",
      windDown: false,
      source: "fallback",
      outcome: PENDING_OUTCOME,
      count: 1,
    },
    {
      talkativeness: "balanced",
      decision: "silent",
      windDown: false,
      source: "heuristic",
      outcome: "stayed_quiet",
      count: 2,
    },
    {
      talkativeness: "verbose",
      decision: "silent",
      windDown: false,
      source: "heuristic",
      outcome: PENDING_OUTCOME,
      count: 1,
    },
  ]);

  assert.deepEqual(
    summary.byTalkativeness.map((entry) => entry.talkativeness),
    ["chatty", "balanced", "verbose"],
    "canonical levels first, unknown levels after",
  );
});

test("training records map the row verbatim and derive only latency", () => {
  const createdAt = new Date("2026-08-10T10:00:00.000Z");
  const settled = voiceDecisionTrainingRecord(
    row({
      id: "vd-settled",
      decision: "acknowledge",
      source: "model",
      talkativeness: "chatty",
      transcriptPreview: "thanks, that helps",
      transcriptChars: 18,
      signals: { gratitude: true, wordCount: 3 },
      outcome: "reply_completed",
      createdAt,
      outcomeAt: new Date(createdAt.getTime() + 4_500),
    }),
  );
  assert.deepEqual(settled, {
    id: "vd-settled",
    createdAt: "2026-08-10T10:00:00.000Z",
    talkativeness: "chatty",
    decision: "acknowledge",
    windDown: false,
    source: "model",
    signals: { gratitude: true, wordCount: 3 },
    transcriptPreview: "thanks, that helps",
    transcriptChars: 18,
    outcome: "reply_completed",
    outcomeAt: "2026-08-10T10:00:04.500Z",
    outcomeLatencyMs: 4500,
  });

  const pending = voiceDecisionTrainingRecord(row({ id: "vd-pending" }));
  assert.equal(pending.outcome, null);
  assert.equal(pending.outcomeAt, null);
  assert.equal(pending.outcomeLatencyMs, null);

  // A clock-skewed outcome can never report negative latency.
  const skewed = voiceDecisionTrainingRecord(
    row({
      outcome: "stayed_quiet",
      createdAt,
      outcomeAt: new Date(createdAt.getTime() - 1_000),
    }),
  );
  assert.equal(skewed.outcomeLatencyMs, 0);
});

test("JSONL export is one parseable line per row, newline-terminated", () => {
  assert.equal(voiceDecisionExportJsonl([]), "");

  const jsonl = voiceDecisionExportJsonl([
    row({ id: "vd-a" }),
    row({ id: "vd-b", outcome: "stayed_quiet", outcomeAt: new Date() }),
  ]);
  assert.ok(jsonl.endsWith("\n"));
  const lines = jsonl.trimEnd().split("\n");
  assert.equal(lines.length, 2);
  const parsed = lines.map((line) => JSON.parse(line) as { id: string });
  assert.deepEqual(
    parsed.map((record) => record.id),
    ["vd-a", "vd-b"],
  );
});
