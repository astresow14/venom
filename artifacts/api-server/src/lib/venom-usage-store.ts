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

import {
  db,
  venomAllowanceReservationsTable,
  venomSharedWorkspacesTable,
  venomUsageEvents,
} from "@workspace/db";
import { and, eq, gte, isNotNull, isNull, lt, sql } from "drizzle-orm";

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
  /**
   * Which workspace's Organization plan paid, from the request's allowance
   * decision. Null/omitted = the caller's personal plan paid.
   */
  billedWorkspaceId?: string | null;
  /**
   * The admission's allowance reservation, settled atomically with this
   * insert: the durable spend row replaces the pending hold in one
   * transaction, so no admission can count both — or neither.
   */
  reservationId?: string | null;
  occurredAt?: Date;
};

/**
 * One advisory lock per payer serializes allowance admission with
 * reservation settlement. Admission sums durable spend and open holds in
 * separate statements; a settlement (spend insert + hold delete) committing
 * between those two reads would make the request's cost vanish from both
 * sums and over-admit past the cap, so both sides take this lock.
 */
export function venomAllowanceLockSql(
  scopeType: "user" | "workspace",
  scopeId: string,
) {
  return sql`select pg_advisory_xact_lock(hashtext(${`venom-allowance:${scopeType}:${scopeId}`}))`;
}

/** Test seam: awaitable insert. Production paths use recordVenomUsage. */
export async function insertVenomUsage(
  input: RecordVenomUsageInput,
): Promise<void> {
  const promptTokens = Math.max(0, Math.round(input.promptTokens));
  const outputTokens = Math.max(0, Math.round(input.outputTokens));
  const values = {
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
    billedWorkspaceId: input.billedWorkspaceId ?? null,
  };
  const reservationId = input.reservationId ?? null;
  if (reservationId) {
    // Settling under the payer's advisory lock makes the swap — spend row
    // in, hold out — a single event to any concurrently admitting request;
    // see venomAllowanceLockSql for why the lock must be shared.
    const scopeType = values.billedWorkspaceId ? "workspace" : "user";
    const scopeId = values.billedWorkspaceId ?? values.userId;
    await db.transaction(async (tx) => {
      await tx.execute(venomAllowanceLockSql(scopeType, scopeId));
      await tx.insert(venomUsageEvents).values(values);
      await tx
        .delete(venomAllowanceReservationsTable)
        .where(eq(venomAllowanceReservationsTable.id, reservationId));
    });
    return;
  }
  await db.insert(venomUsageEvents).values(values);
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
  /**
   * Workspaces whose Organization plan covered some of this member's AI
   * calls during the period. Names only — workspace-billed spend belongs
   * to the workspace, so no dollar figures ever appear here.
   */
  coveredByWorkspaces: Array<{ id: string; name: string }>;
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
  // Personal view = personally billed only. Workspace-billed calls belong
  // to the workspace's ledger; the member sees them solely as a
  // "covered by <workspace>" note below, never as spend figures.
  const scope = and(
    eq(venomUsageEvents.userId, userId),
    isNull(venomUsageEvents.billedWorkspaceId),
    gte(venomUsageEvents.occurredAt, periodStart),
    lt(venomUsageEvents.occurredAt, periodEnd),
  );

  const dayExpr = sql<string>`to_char(${venomUsageEvents.occurredAt} AT TIME ZONE 'UTC', 'YYYY-MM-DD')`;

  const [modelRows, dailyRows, coveredRows] = await Promise.all([
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
    db
      .select({
        id: venomUsageEvents.billedWorkspaceId,
        name: venomSharedWorkspacesTable.name,
      })
      .from(venomUsageEvents)
      .leftJoin(
        venomSharedWorkspacesTable,
        eq(
          venomSharedWorkspacesTable.id,
          sql`${venomUsageEvents.billedWorkspaceId}::uuid`,
        ),
      )
      .where(
        and(
          eq(venomUsageEvents.userId, userId),
          isNotNull(venomUsageEvents.billedWorkspaceId),
          gte(venomUsageEvents.occurredAt, periodStart),
          lt(venomUsageEvents.occurredAt, periodEnd),
        ),
      )
      .groupBy(venomUsageEvents.billedWorkspaceId, venomSharedWorkspacesTable.name),
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

  const coveredByWorkspaces = coveredRows
    .filter((row): row is { id: string; name: string | null } => Boolean(row.id))
    .map((row) => ({
      // A billed workspace that has since been deleted still covered the
      // calls; keep the note honest with a neutral label.
      id: row.id as string,
      name: row.name ?? "A shared workspace",
    }))
    .sort((a, b) => a.name.localeCompare(b.name));

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
    coveredByWorkspaces,
  };
}
