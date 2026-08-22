/**
 * Venom usage ledger store.
 *
 * `recordVenomUsage` is deliberately fire-and-forget: metering must never
 * fail, slow down, or abort the AI call it observes. Insert failures are
 * logged (call kind + alias only — never message content, provider SKUs, or
 * rates) and dropped.
 *
 * `loadVenomUsageSummary` powers the personal Usage views: the caller's
 * current calendar month (UTC) as totals, a daily series, and a per-model
 * breakdown. All money leaves this module as aggregated dollar numbers;
 * per-token rates stay inside venom-usage-pricing.
 */

import { randomUUID } from "node:crypto";

import { db, venomUsageEvents } from "@workspace/db";
import { and, eq, gte, lt, sql } from "drizzle-orm";

import { buildVenomCatalog } from "./venom-models";
import {
  computeCostMicros,
  microsToUsd,
  VOICE_USAGE_ALIAS,
  VOICE_USAGE_DISPLAY_NAME,
} from "./venom-usage-pricing";

/** Every AI path that meters usage. Server-side only — never in API payloads. */
export type VenomUsageCallKind =
  | "chat"
  | "file_classify"
  | "verify_voice"
  | "verify_synthesis"
  | "debate_turn"
  | "knowledge_extract"
  | "note_improve"
  | "host_profile"
  | "build_package"
  | "voice_judge"
  | "voice_transcribe"
  | "voice_speak";

export type RecordVenomUsageInput = {
  userId: string;
  /** Venom-branded alias (venom-gpt, …) or venom-voice for audio legs. */
  modelAlias: string;
  callKind: VenomUsageCallKind;
  promptTokens: number;
  outputTokens: number;
  estimated: boolean;
  /**
   * Precomputed cost in micro-dollars for flat-priced calls (voice audio).
   * Token-based pricing applies when omitted.
   */
  costMicros?: number;
  workspaceId?: string | null;
  occurredAt?: Date;
};

/** Test seam: awaitable insert. Production paths use recordVenomUsage. */
export async function insertVenomUsage(
  input: RecordVenomUsageInput,
): Promise<void> {
  const promptTokens = Math.max(0, Math.round(input.promptTokens));
  const outputTokens = Math.max(0, Math.round(input.outputTokens));
  await db.insert(venomUsageEvents).values({
    id: randomUUID(),
    userId: input.userId,
    occurredAt: input.occurredAt ?? new Date(),
    modelAlias: input.modelAlias,
    callKind: input.callKind,
    promptTokens,
    outputTokens,
    costMicros:
      input.costMicros ??
      computeCostMicros(input.modelAlias, promptTokens, outputTokens),
    estimated: input.estimated,
    workspaceId: input.workspaceId ?? null,
  });
}

/**
 * Fire-and-forget metering. Never throws, never blocks the observed call.
 */
export function recordVenomUsage(input: RecordVenomUsageInput): void {
  void insertVenomUsage(input).catch((error) => {
    console.error(
      `[venom-usage] failed to record ${input.callKind} usage event`,
      error,
    );
  });
}

// ─── Summary ─────────────────────────────────────────────────────────────────

export type VenomUsageSummaryData = {
  /** Inclusive first day of the period (UTC), YYYY-MM-DD. */
  periodStart: string;
  /** Exclusive end day of the period (UTC), YYYY-MM-DD. */
  periodEnd: string;
  totals: {
    costUsd: number;
    requests: number;
    promptTokens: number;
    outputTokens: number;
  };
  hasEstimates: boolean;
  daily: Array<{ date: string; costUsd: number; requests: number }>;
  models: Array<{
    modelId: string;
    modelName: string;
    costUsd: number;
    requests: number;
    promptTokens: number;
    outputTokens: number;
    hasEstimates: boolean;
  }>;
};

function utcDateString(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** Venom-branded display name for a ledger alias. Never a provider SKU. */
function displayNameFor(alias: string): string {
  if (alias === VOICE_USAGE_ALIAS) return VOICE_USAGE_DISPLAY_NAME;
  const entry = buildVenomCatalog().find((model) => model.id === alias);
  // An alias the catalog no longer carries still has to render somehow;
  // aliases are already client-safe, so the alias itself is the fallback.
  return entry?.name ?? alias;
}

export async function loadVenomUsageSummary(
  userId: string,
  now: Date = new Date(),
): Promise<VenomUsageSummaryData> {
  const periodStart = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1),
  );
  const periodEnd = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1),
  );
  const scope = and(
    eq(venomUsageEvents.userId, userId),
    gte(venomUsageEvents.occurredAt, periodStart),
    lt(venomUsageEvents.occurredAt, periodEnd),
  );

  const dayExpr = sql<string>`to_char(${venomUsageEvents.occurredAt} AT TIME ZONE 'UTC', 'YYYY-MM-DD')`;

  const [modelRows, dailyRows] = await Promise.all([
    db
      .select({
        modelAlias: venomUsageEvents.modelAlias,
        requests: sql<number>`count(*)::int`,
        promptTokens: sql<string>`coalesce(sum(${venomUsageEvents.promptTokens}), 0)::bigint`,
        outputTokens: sql<string>`coalesce(sum(${venomUsageEvents.outputTokens}), 0)::bigint`,
        costMicros: sql<string>`coalesce(sum(${venomUsageEvents.costMicros}), 0)::bigint`,
        hasEstimates: sql<boolean>`bool_or(${venomUsageEvents.estimated})`,
      })
      .from(venomUsageEvents)
      .where(scope)
      .groupBy(venomUsageEvents.modelAlias),
    db
      .select({
        date: dayExpr,
        requests: sql<number>`count(*)::int`,
        costMicros: sql<string>`coalesce(sum(${venomUsageEvents.costMicros}), 0)::bigint`,
      })
      .from(venomUsageEvents)
      .where(scope)
      .groupBy(dayExpr)
      .orderBy(dayExpr),
  ]);

  const models = modelRows
    .map((row) => ({
      modelId: row.modelAlias,
      modelName: displayNameFor(row.modelAlias),
      costUsd: microsToUsd(Number(row.costMicros)),
      requests: row.requests,
      promptTokens: Number(row.promptTokens),
      outputTokens: Number(row.outputTokens),
      hasEstimates: row.hasEstimates,
    }))
    .sort((a, b) => b.costUsd - a.costUsd || a.modelName.localeCompare(b.modelName));

  const totals = models.reduce(
    (acc, model) => {
      acc.costUsd += model.costUsd;
      acc.requests += model.requests;
      acc.promptTokens += model.promptTokens;
      acc.outputTokens += model.outputTokens;
      return acc;
    },
    { costUsd: 0, requests: 0, promptTokens: 0, outputTokens: 0 },
  );
  // Sum in micros happened per model already; re-round the dollar total to
  // micro precision so float noise from adding parsed floats stays invisible.
  totals.costUsd = Math.round(totals.costUsd * 1_000_000) / 1_000_000;

  return {
    periodStart: utcDateString(periodStart),
    periodEnd: utcDateString(periodEnd),
    totals,
    hasEstimates: models.some((model) => model.hasEstimates),
    daily: dailyRows.map((row) => ({
      date: row.date,
      costUsd: microsToUsd(Number(row.costMicros)),
      requests: row.requests,
    })),
    models,
  };
}
