/**
 * venom-voice-decision-store.ts — persistence for restraint decisions.
 *
 * Every speak/stay-quiet decision is recorded with its context signals, and
 * later paired with what actually happened (interrupted reply, re-ask after
 * silence, clean wind-down, ...). This is the evidence trail for tuning the
 * thresholds and the seed of a future training dataset.
 *
 * Retention is bounded and enforced on two independent paths:
 *   - opportunistically on insert (per-user row cap, newest rows win)
 *   - a scheduled global sweep that deletes expired rows regardless of
 *     whether their owner ever uses voice mode again
 * No audio is ever stored; the transcript survives only as a bounded preview.
 */

import { and, eq, inArray, isNull, lt, sql } from "drizzle-orm";
import { db } from "@workspace/db";
import { venomVoiceDecisionsTable } from "@workspace/db/schema";
import { logger } from "./logger";

/** Newest rows kept per user; older ones are pruned on the next insert. */
export const VOICE_DECISION_MAX_ROWS_PER_USER = 500;
/** Rows older than this are pruned regardless of the per-user cap. */
export const VOICE_DECISION_MAX_AGE_DAYS = 90;
/** Longest transcript snippet a row may carry. */
export const VOICE_DECISION_PREVIEW_CHARS = 280;

export type VoiceDecisionRecord = {
  id: string;
  userId: string;
  decision: "respond" | "acknowledge" | "silent";
  windDown: boolean;
  source: "heuristic" | "model" | "fallback";
  talkativeness: string;
  transcript: string;
  signals: Record<string, unknown>;
};

export type VoiceDecisionOutcome =
  | "reply_completed"
  | "reply_interrupted"
  | "user_followed_up"
  | "stayed_quiet"
  | "wound_down"
  | "session_closed";

/** The store shape the voice router depends on (injectable for tests). */
export type VoiceDecisionStore = {
  record(decision: VoiceDecisionRecord): Promise<void>;
  recordOutcome(
    userId: string,
    decisionId: string,
    outcome: VoiceDecisionOutcome,
  ): Promise<{ recorded: boolean }>;
};

/** The moment before which rows have outlived their retention. */
export function voiceDecisionRetentionCutoff(now = Date.now()): Date {
  return new Date(now - VOICE_DECISION_MAX_AGE_DAYS * 24 * 60 * 60 * 1000);
}

/**
 * Delete every decision row older than the retention window, for all users.
 * This is what keeps retention honest for people who tried voice mode once
 * and never came back — the per-insert prune below only ever fires for
 * users who are still active. Failures propagate to the caller.
 */
export async function pruneExpiredVoiceDecisions(
  runner: Pick<typeof db, "delete"> = db,
): Promise<number> {
  const deleted = await runner
    .delete(venomVoiceDecisionsTable)
    .where(
      lt(venomVoiceDecisionsTable.createdAt, voiceDecisionRetentionCutoff()),
    )
    .returning({ id: venomVoiceDecisionsTable.id });
  return deleted.length;
}

const RETENTION_SWEEP_INTERVAL_MS = 6 * 60 * 60 * 1000;
let retentionJobStarted = false;

/**
 * Physically removes expired decision rows at startup and every six hours,
 * so the 90-day bound holds independently of voice-mode traffic.
 */
export function startVoiceDecisionRetentionJob(): void {
  if (retentionJobStarted) return;
  retentionJobStarted = true;

  const sweep = async () => {
    const startedAt = Date.now();
    try {
      const deletedCount = await pruneExpiredVoiceDecisions();
      logger.info(
        {
          deletedCount,
          durationMs: Date.now() - startedAt,
          op: "prune_voice_decisions",
        },
        "Voice decision retention sweep finished",
      );
    } catch (error) {
      logger.error(
        {
          durationMs: Date.now() - startedAt,
          errorType: error instanceof Error ? error.name : "UnknownError",
          op: "prune_voice_decisions",
        },
        "Voice decision retention sweep failed",
      );
    }
  };

  setImmediate(() => void sweep());
  const timer = setInterval(() => void sweep(), RETENTION_SWEEP_INTERVAL_MS);
  timer.unref();
}

async function pruneForUser(userId: string): Promise<void> {
  await db
    .delete(venomVoiceDecisionsTable)
    .where(
      and(
        eq(venomVoiceDecisionsTable.userId, userId),
        lt(venomVoiceDecisionsTable.createdAt, voiceDecisionRetentionCutoff()),
      ),
    );

  // Row cap: find ids beyond the newest N and delete them explicitly.
  // (Two plain queries — correlated raw-SQL subqueries have bitten before.)
  const overflow = await db
    .select({ id: venomVoiceDecisionsTable.id })
    .from(venomVoiceDecisionsTable)
    .where(eq(venomVoiceDecisionsTable.userId, userId))
    .orderBy(
      sql`${venomVoiceDecisionsTable.createdAt} desc`,
      sql`${venomVoiceDecisionsTable.id} desc`,
    )
    .offset(VOICE_DECISION_MAX_ROWS_PER_USER);
  if (overflow.length > 0) {
    await db.delete(venomVoiceDecisionsTable).where(
      inArray(
        venomVoiceDecisionsTable.id,
        overflow.map((row) => row.id),
      ),
    );
  }
}

export const voiceDecisionStore: VoiceDecisionStore = {
  async record(decision) {
    await db.insert(venomVoiceDecisionsTable).values({
      id: decision.id,
      userId: decision.userId,
      decision: decision.decision,
      windDown: decision.windDown,
      source: decision.source,
      talkativeness: decision.talkativeness,
      transcriptPreview: decision.transcript.slice(
        0,
        VOICE_DECISION_PREVIEW_CHARS,
      ),
      transcriptChars: decision.transcript.length,
      signals: decision.signals,
    });
    // record() resolves once the row is durable — the decide route awaits
    // that so an outcome report can never outrun its own decision row. The
    // per-user cap prune stays off that path and is best-effort; the global
    // sweep guarantees the age bound regardless.
    void pruneForUser(decision.userId).catch((error) => {
      console.error(
        "Venom voice decision pruning failed:",
        error instanceof Error ? error.message : error,
      );
    });
  },

  async recordOutcome(userId, decisionId, outcome) {
    // First report wins: a decision's outcome is written exactly once.
    const updated = await db
      .update(venomVoiceDecisionsTable)
      .set({ outcome, outcomeAt: new Date() })
      .where(
        and(
          eq(venomVoiceDecisionsTable.id, decisionId),
          eq(venomVoiceDecisionsTable.userId, userId),
          isNull(venomVoiceDecisionsTable.outcome),
        ),
      )
      .returning({ id: venomVoiceDecisionsTable.id });
    return { recorded: updated.length > 0 };
  },
};
