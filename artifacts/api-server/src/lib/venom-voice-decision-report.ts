/**
 * venom-voice-decision-report.ts — the pure evidence layer over the voice
 * restraint decision log.
 *
 * Everything here is deterministic and db-free on purpose. The decision
 * store persists rows; this module owns the shared log policy constants
 * (retention bounds, preview cap) plus the read-side shapes — the
 * decisions × outcomes × talkativeness summary the threshold-tuning work
 * reads, and the JSONL training records this log was designed to
 * accumulate. Routes import this statically while the db-backed store stays
 * a lazy import, so db-less environments still bundle the voice router.
 *
 * How to read the aggregates against each heuristic threshold:
 * see venom-voice-restraint-tuning.md (same directory).
 */

import {
  BACKCHANNEL_MAX_WORDS,
  BOT_ANSWER_MAX_WORDS,
  LONG_UTTERANCE_WORDS,
  SHORT_GRATITUDE_MAX_WORDS,
  SHORT_TURN_MAX_WORDS,
  WIND_DOWN_TRAILING_SHORT_TURNS,
} from "./venom-voice-restraint";

// ── Log policy constants ─────────────────────────────────────────────────────
// Declared here (not in the store) so report code and routes can read them
// without dragging in the database client. The store re-exports them.

/** Newest rows kept per user; older ones are pruned on the next insert. */
export const VOICE_DECISION_MAX_ROWS_PER_USER = 500;
/** Rows older than this are pruned regardless of the per-user cap. */
export const VOICE_DECISION_MAX_AGE_DAYS = 90;
/** Longest transcript snippet a row may carry. */
export const VOICE_DECISION_PREVIEW_CHARS = 280;
/**
 * Hard cap on rows one summary/export read will pull — twice the per-user
 * row cap, because the insert-time prune is best-effort and may lag. Reads
 * take the newest rows when the cap bites.
 */
export const VOICE_DECISION_REPORT_MAX_ROWS =
  VOICE_DECISION_MAX_ROWS_PER_USER * 2;

/** One persisted decision row, as the read side sees it. */
export type StoredVoiceDecision = {
  id: string;
  /** respond | acknowledge | silent (historical rows pass through verbatim). */
  decision: string;
  windDown: boolean;
  /** heuristic | model | fallback */
  source: string;
  talkativeness: string;
  transcriptPreview: string;
  transcriptChars: number;
  signals: unknown;
  outcome: string | null;
  outcomeAt: Date | null;
  createdAt: Date;
};

// ── Summary shapes (mirror the OpenAPI contract) ─────────────────────────────

export type VoiceOutcomeRate = {
  /** Decisions whose outcome landed in one of the two buckets compared. */
  settled: number;
  /** How many of those landed in the tracked bucket. */
  hits: number;
  /** hits / settled — null (never 0%) when nothing has settled yet. */
  rate: number | null;
};

export type VoiceDecisionRateBlock = {
  decisions: number;
  withOutcome: number;
  outcomeCoverage: number;
  decisionCounts: { respond: number; acknowledge: number; silent: number };
  sourceCounts: { heuristic: number; model: number; fallback: number };
  windDownFlagged: number;
  /** Silent non-wind-down decisions: re-ask within the window vs stayed quiet. */
  quietRegret: VoiceOutcomeRate;
  /** Spoken (respond/acknowledge) non-wind-down decisions: interrupted vs completed. */
  spokenInterruption: VoiceOutcomeRate;
  /** Wind-down-flagged decisions: session eased closed vs the user re-engaging. */
  windDownClean: VoiceOutcomeRate;
};

export type VoiceDecisionCell = {
  talkativeness: string;
  decision: string;
  windDown: boolean;
  source: string;
  /** A concrete outcome, or "pending" while none has been reported. */
  outcome: string;
  count: number;
};

export type VoiceRestraintThresholds = {
  longUtteranceWords: number;
  backchannelMaxWords: number;
  shortGratitudeMaxWords: number;
  botAnswerMaxWords: number;
  shortTurnMaxWords: number;
  windDownTrailingShortTurns: number;
  retentionDays: number;
  maxRowsPerUser: number;
  transcriptPreviewChars: number;
};

export type VoiceDecisionSummary = {
  windowDays: number;
  since: string;
  generatedAt: string;
  overall: VoiceDecisionRateBlock;
  byTalkativeness: Array<{
    talkativeness: string;
    rates: VoiceDecisionRateBlock;
  }>;
  cells: VoiceDecisionCell[];
  thresholds: VoiceRestraintThresholds;
};

/** The heuristic thresholds in force, echoed into every summary. */
export function voiceRestraintThresholds(): VoiceRestraintThresholds {
  return {
    longUtteranceWords: LONG_UTTERANCE_WORDS,
    backchannelMaxWords: BACKCHANNEL_MAX_WORDS,
    shortGratitudeMaxWords: SHORT_GRATITUDE_MAX_WORDS,
    botAnswerMaxWords: BOT_ANSWER_MAX_WORDS,
    shortTurnMaxWords: SHORT_TURN_MAX_WORDS,
    windDownTrailingShortTurns: WIND_DOWN_TRAILING_SHORT_TURNS,
    retentionDays: VOICE_DECISION_MAX_AGE_DAYS,
    maxRowsPerUser: VOICE_DECISION_MAX_ROWS_PER_USER,
    transcriptPreviewChars: VOICE_DECISION_PREVIEW_CHARS,
  };
}

// ── Aggregation ──────────────────────────────────────────────────────────────

export const PENDING_OUTCOME = "pending";

const TALKATIVENESS_ORDER = ["chatty", "balanced", "reserved"] as const;
const DECISION_ORDER = ["respond", "acknowledge", "silent"] as const;
const SOURCE_ORDER = ["heuristic", "model", "fallback"] as const;
const OUTCOME_ORDER = [
  "reply_completed",
  "reply_interrupted",
  "user_followed_up",
  "stayed_quiet",
  "wound_down",
  "session_closed",
  PENDING_OUTCOME,
] as const;

/** Canonical values first (in listed order), unknown values after, A→Z. */
function compareCanonical(
  a: string,
  b: string,
  order: readonly string[],
): number {
  const rankA = order.indexOf(a);
  const rankB = order.indexOf(b);
  const safeA = rankA === -1 ? order.length : rankA;
  const safeB = rankB === -1 ? order.length : rankB;
  if (safeA !== safeB) return safeA - safeB;
  return a < b ? -1 : a > b ? 1 : 0;
}

/** hits/settled rounded to 4 decimals; null when nothing settled (no data ≠ 0%). */
function outcomeRate(hits: number, settled: number): VoiceOutcomeRate {
  return {
    settled,
    hits,
    rate: settled === 0 ? null : Math.round((hits / settled) * 10_000) / 10_000,
  };
}

function buildRateBlock(
  rows: readonly StoredVoiceDecision[],
): VoiceDecisionRateBlock {
  const decisionCounts = { respond: 0, acknowledge: 0, silent: 0 };
  const sourceCounts = { heuristic: 0, model: 0, fallback: 0 };
  let withOutcome = 0;
  let windDownFlagged = 0;

  let quietSettled = 0;
  let quietReAsked = 0;
  let spokenSettled = 0;
  let spokenInterrupted = 0;
  let windDownSettled = 0;
  let windDownCleanlyClosed = 0;

  for (const row of rows) {
    if (row.decision in decisionCounts) {
      decisionCounts[row.decision as keyof typeof decisionCounts] += 1;
    }
    if (row.source in sourceCounts) {
      sourceCounts[row.source as keyof typeof sourceCounts] += 1;
    }
    if (row.outcome !== null) withOutcome += 1;
    if (row.windDown) windDownFlagged += 1;

    if (row.windDown) {
      // The goodbye read: did the session actually ease itself closed, or
      // did the user pull it back open?
      if (row.outcome === "wound_down") {
        windDownSettled += 1;
        windDownCleanlyClosed += 1;
      } else if (row.outcome === "user_followed_up") {
        windDownSettled += 1;
      }
    } else if (row.decision === "silent") {
      // The stay-quiet read: silence that provoked a re-ask was regretted.
      if (row.outcome === "user_followed_up") {
        quietSettled += 1;
        quietReAsked += 1;
      } else if (row.outcome === "stayed_quiet") {
        quietSettled += 1;
      }
    } else if (row.decision === "respond" || row.decision === "acknowledge") {
      // The spoke-anyway read: interrupted replies were probably unwanted.
      if (row.outcome === "reply_interrupted") {
        spokenSettled += 1;
        spokenInterrupted += 1;
      } else if (row.outcome === "reply_completed") {
        spokenSettled += 1;
      }
    }
  }

  return {
    decisions: rows.length,
    withOutcome,
    outcomeCoverage:
      rows.length === 0
        ? 0
        : Math.round((withOutcome / rows.length) * 10_000) / 10_000,
    decisionCounts,
    sourceCounts,
    windDownFlagged,
    quietRegret: outcomeRate(quietReAsked, quietSettled),
    spokenInterruption: outcomeRate(spokenInterrupted, spokenSettled),
    windDownClean: outcomeRate(windDownCleanlyClosed, windDownSettled),
  };
}

export type SummarizeOptions = {
  windowDays: number;
  since: Date;
  /** Injectable for deterministic tests; defaults to now. */
  generatedAt?: Date;
};

/**
 * The decisions × outcomes × talkativeness evidence view over one user's
 * rows: exact counts for every observed combination, headline rates per
 * talkativeness and overall, and the thresholds the numbers argue about.
 */
export function summarizeVoiceDecisions(
  rows: readonly StoredVoiceDecision[],
  options: SummarizeOptions,
): VoiceDecisionSummary {
  const byTalkativeness = new Map<string, StoredVoiceDecision[]>();
  for (const row of rows) {
    const bucket = byTalkativeness.get(row.talkativeness);
    if (bucket) {
      bucket.push(row);
    } else {
      byTalkativeness.set(row.talkativeness, [row]);
    }
  }

  const cellCounts = new Map<string, VoiceDecisionCell>();
  for (const row of rows) {
    const outcome = row.outcome ?? PENDING_OUTCOME;
    const key = [
      row.talkativeness,
      row.decision,
      row.windDown ? "1" : "0",
      row.source,
      outcome,
    ].join("\u0000");
    const cell = cellCounts.get(key);
    if (cell) {
      cell.count += 1;
    } else {
      cellCounts.set(key, {
        talkativeness: row.talkativeness,
        decision: row.decision,
        windDown: row.windDown,
        source: row.source,
        outcome,
        count: 1,
      });
    }
  }

  const cells = [...cellCounts.values()].sort(
    (a, b) =>
      compareCanonical(a.talkativeness, b.talkativeness, TALKATIVENESS_ORDER) ||
      compareCanonical(a.decision, b.decision, DECISION_ORDER) ||
      Number(a.windDown) - Number(b.windDown) ||
      compareCanonical(a.source, b.source, SOURCE_ORDER) ||
      compareCanonical(a.outcome, b.outcome, OUTCOME_ORDER),
  );

  return {
    windowDays: options.windowDays,
    since: options.since.toISOString(),
    generatedAt: (options.generatedAt ?? new Date()).toISOString(),
    overall: buildRateBlock(rows),
    byTalkativeness: [...byTalkativeness.keys()]
      .sort((a, b) => compareCanonical(a, b, TALKATIVENESS_ORDER))
      .map((talkativeness) => ({
        talkativeness,
        rates: buildRateBlock(byTalkativeness.get(talkativeness)!),
      })),
    cells,
    thresholds: voiceRestraintThresholds(),
  };
}

// ── Training export ──────────────────────────────────────────────────────────

/**
 * One JSONL record: exactly what the log stores — signals and bounded
 * preview, decision, layer, talkativeness, and the observed outcome. No
 * user id, no audio, nothing recomputed.
 */
export type VoiceDecisionTrainingRecord = {
  id: string;
  createdAt: string;
  talkativeness: string;
  decision: string;
  windDown: boolean;
  source: string;
  signals: unknown;
  transcriptPreview: string;
  transcriptChars: number;
  outcome: string | null;
  outcomeAt: string | null;
  /** Milliseconds from decision to its outcome report; null while pending. */
  outcomeLatencyMs: number | null;
};

export function voiceDecisionTrainingRecord(
  row: StoredVoiceDecision,
): VoiceDecisionTrainingRecord {
  return {
    id: row.id,
    createdAt: row.createdAt.toISOString(),
    talkativeness: row.talkativeness,
    decision: row.decision,
    windDown: row.windDown,
    source: row.source,
    signals: row.signals ?? null,
    transcriptPreview: row.transcriptPreview,
    transcriptChars: row.transcriptChars,
    outcome: row.outcome,
    outcomeAt: row.outcomeAt ? row.outcomeAt.toISOString() : null,
    outcomeLatencyMs: row.outcomeAt
      ? Math.max(0, row.outcomeAt.getTime() - row.createdAt.getTime())
      : null,
  };
}

/** Rows (oldest first) as newline-terminated JSONL; empty string for none. */
export function voiceDecisionExportJsonl(
  rows: readonly StoredVoiceDecision[],
): string {
  if (rows.length === 0) return "";
  return (
    rows.map((row) => JSON.stringify(voiceDecisionTrainingRecord(row))).join("\n") +
    "\n"
  );
}
