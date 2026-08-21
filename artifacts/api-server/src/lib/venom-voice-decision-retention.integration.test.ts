/**
 * Real-database integration tests for voice-decision retention: the global
 * sweep must delete expired rows for users who never touch voice mode again
 * (prune-on-insert only ever fires for active users), and the real store
 * must accept exactly one outcome per decision row.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { inArray, sql } from "drizzle-orm";
import { db } from "@workspace/db";
import { venomVoiceDecisionsTable } from "@workspace/db/schema";
import {
  pruneExpiredVoiceDecisions,
  voiceDecisionRetentionCutoff,
  voiceDecisionStore,
  VOICE_DECISION_MAX_AGE_DAYS,
} from "./venom-voice-decision-store.js";

const DAY_MS = 24 * 60 * 60 * 1000;

async function ensureVoiceDecisionSchema(): Promise<void> {
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS venom_voice_decisions (
      id text PRIMARY KEY,
      user_id text NOT NULL,
      decision text NOT NULL,
      wind_down boolean NOT NULL DEFAULT false,
      source text NOT NULL,
      talkativeness text NOT NULL,
      transcript_preview text NOT NULL,
      transcript_chars integer NOT NULL,
      signals jsonb NOT NULL,
      outcome text,
      outcome_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now()
    )
  `);
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS venom_voice_decisions_user_created_idx
      ON venom_voice_decisions (user_id, created_at)
  `);
}

function decisionRow(
  userId: string,
  ageDays: number,
): typeof venomVoiceDecisionsTable.$inferInsert {
  return {
    id: `vd-test-${randomUUID()}`,
    userId,
    decision: "silent",
    windDown: false,
    source: "heuristic",
    talkativeness: "balanced",
    transcriptPreview: "okay yeah makes sense",
    transcriptChars: 21,
    signals: { backchannel: true },
    createdAt: new Date(Date.now() - ageDays * DAY_MS),
  };
}

test("the global sweep removes an inactive user's expired rows and keeps fresh ones", async () => {
  await ensureVoiceDecisionSchema();

  const suffix = randomUUID().slice(0, 8);
  // This user tried voice mode once, long ago, and never came back — no
  // insert-time prune will ever run for them again.
  const inactiveUser = `user_voiceRetireed_${suffix}`;
  const activeUser = `user_voiceActive_${suffix}`;

  const expiredInactive = decisionRow(
    inactiveUser,
    VOICE_DECISION_MAX_AGE_DAYS + 1,
  );
  const expiredActive = decisionRow(activeUser, VOICE_DECISION_MAX_AGE_DAYS + 30);
  const freshActive = decisionRow(activeUser, 1);
  const allIds = [expiredInactive.id, expiredActive.id, freshActive.id];

  await db
    .insert(venomVoiceDecisionsTable)
    .values([expiredInactive, expiredActive, freshActive]);

  try {
    assert.ok(
      expiredInactive.createdAt! < voiceDecisionRetentionCutoff(),
      "seeded row really is past the retention cutoff",
    );

    const deletedCount = await pruneExpiredVoiceDecisions(db);
    assert.ok(
      deletedCount >= 2,
      `sweep reported at least our two expired rows (got ${deletedCount})`,
    );

    const survivors = await db
      .select({ id: venomVoiceDecisionsTable.id })
      .from(venomVoiceDecisionsTable)
      .where(inArray(venomVoiceDecisionsTable.id, allIds));
    assert.deepEqual(
      survivors.map((row) => row.id).sort(),
      [freshActive.id],
      "only the fresh row survives; both expired rows are gone, active owner or not",
    );
  } finally {
    await db
      .delete(venomVoiceDecisionsTable)
      .where(inArray(venomVoiceDecisionsTable.id, allIds));
  }
});

test("the real store accepts exactly one outcome per recorded decision", async () => {
  await ensureVoiceDecisionSchema();

  const userId = `user_voiceOutcome_${randomUUID().slice(0, 8)}`;
  const decisionId = `vd-test-${randomUUID()}`;

  await voiceDecisionStore.record({
    id: decisionId,
    userId,
    decision: "acknowledge",
    windDown: false,
    source: "model",
    talkativeness: "chatty",
    transcript: "alright, that settles it then",
    signals: { farewell: false },
  });

  try {
    const first = await voiceDecisionStore.recordOutcome(
      userId,
      decisionId,
      "reply_completed",
    );
    assert.deepEqual(first, { recorded: true });

    const second = await voiceDecisionStore.recordOutcome(
      userId,
      decisionId,
      "reply_interrupted",
    );
    assert.deepEqual(second, { recorded: false }, "first report wins");

    const foreign = await voiceDecisionStore.recordOutcome(
      "user_someoneElse",
      decisionId,
      "session_closed",
    );
    assert.deepEqual(foreign, { recorded: false }, "outcomes are user-scoped");
  } finally {
    await db
      .delete(venomVoiceDecisionsTable)
      .where(inArray(venomVoiceDecisionsTable.id, [decisionId]));
  }
});
