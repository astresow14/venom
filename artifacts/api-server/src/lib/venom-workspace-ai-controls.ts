/**
 * Workspace admin AI controls: spend caps and model locks that bind only
 * requests billed to the workspace's Organization plan.
 *
 * Design boundaries, all deliberate:
 * - Personal space is untouchable. Every query here filters on
 *   `billedWorkspaceId`, so a member's personal-plan usage is structurally
 *   invisible to admins and never constrained by workspace controls.
 * - Money stays integer micro-dollars on the server, like the usage
 *   ledger. Dollar figures appear only at the API boundary, only for
 *   admins; members learn cap/lock *state*, never figures.
 * - Absence means absence: no controls row = no controls. A member
 *   override row replaces the workspace default entirely — a numeric value
 *   is that member's cap, null is an explicit "no cap" — and deleting the
 *   row restores the default.
 * - Enforcement reads run inside the same payer-locked admission
 *   transaction as the workspace allowance check (never read-then-act),
 *   which is why every loader takes an executor.
 */

import {
  db,
  venomUsageEvents,
  venomWorkspaceAiControlsTable,
  venomWorkspaceMemberAiControlsTable,
} from "@workspace/db";
import { and, eq, gte, lt, sql } from "drizzle-orm";

import type { BillingPeriod } from "./venom-billing-store";
import type { VenomModelCostTier } from "./venom-models";

/** Either the root client or a transaction — both share the query API. */
type DbExecutor = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

/** Policies a workspace may force. "manual" would just hand the choice back. */
export const VENOM_WORKSPACE_FORCEABLE_POLICIES = [
  "auto-cheapest",
  "auto-max-power",
] as const;
export type VenomWorkspaceForcedPolicy =
  (typeof VENOM_WORKSPACE_FORCEABLE_POLICIES)[number];

/** Canonical tier order, cheapest first. */
export const VENOM_COST_TIER_ORDER: readonly VenomModelCostTier[] = [
  "$",
  "$$",
  "$$$",
];

export type VenomWorkspaceAiControls = {
  /** Default monthly cap per member, micro-dollars; null = no cap. */
  defaultMemberCapMicros: number | null;
  /** Policy forced on workspace-billed requests; null = member's own. */
  forcedSelectionPolicy: VenomWorkspaceForcedPolicy | null;
  /** Tiers workspace-billed requests may use; null = all. Never empty. */
  allowedCostTiers: VenomModelCostTier[] | null;
};

export const NO_WORKSPACE_AI_CONTROLS: VenomWorkspaceAiControls =
  Object.freeze({
    defaultMemberCapMicros: null,
    forcedSelectionPolicy: null,
    allowedCostTiers: null,
  });

/** True when any admin control is set at all. */
export function workspaceAiControlsActive(
  controls: VenomWorkspaceAiControls,
): boolean {
  return (
    controls.defaultMemberCapMicros !== null ||
    workspaceModelLockActive(controls)
  );
}

/** True when the workspace locks model choice (policy and/or tiers). */
export function workspaceModelLockActive(
  controls: Pick<
    VenomWorkspaceAiControls,
    "forcedSelectionPolicy" | "allowedCostTiers"
  >,
): boolean {
  return (
    controls.forcedSelectionPolicy !== null ||
    controls.allowedCostTiers !== null
  );
}

/**
 * Defense-in-depth normalization for tier lists (writes and reads alike):
 * keep only real tiers, dedupe, canonical order. Empty and full both
 * normalize to null — "all tiers" has exactly one representation, and a
 * lock can never be stored that allows nothing.
 */
export function normalizeAllowedCostTiers(
  raw: readonly string[] | null | undefined,
): VenomModelCostTier[] | null {
  if (!raw) return null;
  const kept = VENOM_COST_TIER_ORDER.filter((tier) => raw.includes(tier));
  if (kept.length === 0 || kept.length === VENOM_COST_TIER_ORDER.length) {
    return null;
  }
  return [...kept];
}

function normalizeForcedPolicy(
  raw: string | null | undefined,
): VenomWorkspaceForcedPolicy | null {
  return VENOM_WORKSPACE_FORCEABLE_POLICIES.includes(
    raw as VenomWorkspaceForcedPolicy,
  )
    ? (raw as VenomWorkspaceForcedPolicy)
    : null;
}

/** The workspace's controls; absent row = no controls. Never throws inputs at callers: values are normalized on the way out. */
export async function loadWorkspaceAiControls(
  workspaceId: string,
  executor: DbExecutor = db,
): Promise<VenomWorkspaceAiControls> {
  const [row] = await executor
    .select({
      defaultMemberCapMicros:
        venomWorkspaceAiControlsTable.defaultMemberCapMicros,
      forcedSelectionPolicy:
        venomWorkspaceAiControlsTable.forcedSelectionPolicy,
      allowedCostTiers: venomWorkspaceAiControlsTable.allowedCostTiers,
    })
    .from(venomWorkspaceAiControlsTable)
    .where(eq(venomWorkspaceAiControlsTable.workspaceId, workspaceId))
    .limit(1);
  if (!row) return NO_WORKSPACE_AI_CONTROLS;
  return {
    defaultMemberCapMicros:
      typeof row.defaultMemberCapMicros === "number" &&
      Number.isFinite(row.defaultMemberCapMicros) &&
      row.defaultMemberCapMicros >= 0
        ? Math.floor(row.defaultMemberCapMicros)
        : null,
    forcedSelectionPolicy: normalizeForcedPolicy(row.forcedSelectionPolicy),
    allowedCostTiers: normalizeAllowedCostTiers(row.allowedCostTiers),
  };
}

export type VenomMemberAiCapOverride = {
  /** Micro-dollar cap; null = explicitly uncapped for this member. */
  capMicros: number | null;
};

/** This member's override, or null when no override row exists. */
export async function loadMemberAiCapOverride(
  workspaceId: string,
  clerkUserId: string,
  executor: DbExecutor = db,
): Promise<VenomMemberAiCapOverride | null> {
  const [row] = await executor
    .select({ capMicros: venomWorkspaceMemberAiControlsTable.capMicros })
    .from(venomWorkspaceMemberAiControlsTable)
    .where(
      and(
        eq(venomWorkspaceMemberAiControlsTable.workspaceId, workspaceId),
        eq(venomWorkspaceMemberAiControlsTable.clerkUserId, clerkUserId),
      ),
    )
    .limit(1);
  if (!row) return null;
  const capMicros =
    typeof row.capMicros === "number" &&
    Number.isFinite(row.capMicros) &&
    row.capMicros >= 0
      ? Math.floor(row.capMicros)
      : null;
  return { capMicros };
}

/**
 * The cap that actually binds a member: their override when one exists
 * (including the explicit "no cap" null), else the workspace default.
 */
export function effectiveMemberCapMicros(
  controls: VenomWorkspaceAiControls,
  override: VenomMemberAiCapOverride | null,
): number | null {
  if (override) return override.capMicros;
  return controls.defaultMemberCapMicros;
}

/** All override rows for a workspace, for the admin controls payload. */
export async function listMemberAiCapOverrides(
  workspaceId: string,
  executor: DbExecutor = db,
): Promise<Array<{ clerkUserId: string; capMicros: number | null }>> {
  const rows = await executor
    .select({
      clerkUserId: venomWorkspaceMemberAiControlsTable.clerkUserId,
      capMicros: venomWorkspaceMemberAiControlsTable.capMicros,
    })
    .from(venomWorkspaceMemberAiControlsTable)
    .where(eq(venomWorkspaceMemberAiControlsTable.workspaceId, workspaceId));
  return rows.map((row) => ({
    clerkUserId: row.clerkUserId,
    capMicros:
      typeof row.capMicros === "number" &&
      Number.isFinite(row.capMicros) &&
      row.capMicros >= 0
        ? Math.floor(row.capMicros)
        : null,
  }));
}

/** Full-replace write of the workspace-level controls (admin route only). */
export async function saveWorkspaceAiControls(
  workspaceId: string,
  input: VenomWorkspaceAiControls,
  updatedByClerkUserId: string,
): Promise<void> {
  await db
    .insert(venomWorkspaceAiControlsTable)
    .values({
      workspaceId,
      defaultMemberCapMicros: input.defaultMemberCapMicros,
      forcedSelectionPolicy: input.forcedSelectionPolicy,
      allowedCostTiers: input.allowedCostTiers,
      updatedByClerkUserId,
    })
    .onConflictDoUpdate({
      target: venomWorkspaceAiControlsTable.workspaceId,
      set: {
        defaultMemberCapMicros: input.defaultMemberCapMicros,
        forcedSelectionPolicy: input.forcedSelectionPolicy,
        allowedCostTiers: input.allowedCostTiers,
        updatedByClerkUserId,
        updatedAt: new Date(),
      },
    });
}

/** Create or replace one member's cap override (admin route only). */
export async function setMemberAiCapOverride(
  workspaceId: string,
  clerkUserId: string,
  capMicros: number | null,
  updatedByClerkUserId: string,
): Promise<void> {
  await db
    .insert(venomWorkspaceMemberAiControlsTable)
    .values({ workspaceId, clerkUserId, capMicros, updatedByClerkUserId })
    .onConflictDoUpdate({
      target: [
        venomWorkspaceMemberAiControlsTable.workspaceId,
        venomWorkspaceMemberAiControlsTable.clerkUserId,
      ],
      set: { capMicros, updatedByClerkUserId, updatedAt: new Date() },
    });
}

/** Remove one member's override; they fall back to the default. Idempotent. */
export async function clearMemberAiCapOverride(
  workspaceId: string,
  clerkUserId: string,
): Promise<void> {
  await db
    .delete(venomWorkspaceMemberAiControlsTable)
    .where(
      and(
        eq(venomWorkspaceMemberAiControlsTable.workspaceId, workspaceId),
        eq(venomWorkspaceMemberAiControlsTable.clerkUserId, clerkUserId),
      ),
    );
}

/**
 * One member's workspace-billed spend inside a period, micro-dollars.
 * `billedWorkspaceId` (the payer stamp), never `workspaceId` (the context
 * stamp): a chat that merely happened in the workspace while the member's
 * own plan paid is personal spend and must stay invisible here.
 */
export async function sumMemberWorkspaceBilledMicros(
  workspaceId: string,
  clerkUserId: string,
  period: BillingPeriod,
  executor: DbExecutor = db,
): Promise<number> {
  const [row] = await executor
    .select({
      total: sql<string>`COALESCE(SUM(${venomUsageEvents.costMicros}), 0)`,
    })
    .from(venomUsageEvents)
    .where(
      and(
        eq(venomUsageEvents.billedWorkspaceId, workspaceId),
        eq(venomUsageEvents.userId, clerkUserId),
        gte(venomUsageEvents.occurredAt, period.start),
        lt(venomUsageEvents.occurredAt, period.end),
      ),
    );
  const total = Number(row?.total ?? 0);
  return Number.isFinite(total) ? total : 0;
}

/**
 * Workspace-billed spend grouped by the member who spent it, for the
 * admin usage summary. Includes rows from since-removed members — the
 * money was still spent; the route decides how to present them.
 */
export async function sumWorkspaceBilledMicrosByMember(
  workspaceId: string,
  period: BillingPeriod,
  executor: DbExecutor = db,
): Promise<Map<string, number>> {
  const rows = await executor
    .select({
      userId: venomUsageEvents.userId,
      total: sql<string>`COALESCE(SUM(${venomUsageEvents.costMicros}), 0)`,
    })
    .from(venomUsageEvents)
    .where(
      and(
        eq(venomUsageEvents.billedWorkspaceId, workspaceId),
        gte(venomUsageEvents.occurredAt, period.start),
        lt(venomUsageEvents.occurredAt, period.end),
      ),
    )
    .groupBy(venomUsageEvents.userId);
  const byMember = new Map<string, number>();
  for (const row of rows) {
    const total = Number(row.total);
    byMember.set(row.userId, Number.isFinite(total) ? total : 0);
  }
  return byMember;
}

/**
 * Restrict a model catalog to the allowed tiers. Null/absent lock keeps
 * the catalog whole. A lock that would empty the catalog fails open to the
 * full catalog — admins can't save such a lock, but if tier definitions
 * ever drift underneath a saved one, chat must keep working; the caller
 * logs when this happens.
 */
export function filterCatalogByCostTiers<
  T extends { costTier?: VenomModelCostTier },
>(catalog: T[], allowedCostTiers: readonly VenomModelCostTier[] | null): {
  catalog: T[];
  emptied: boolean;
} {
  if (!allowedCostTiers || allowedCostTiers.length === 0) {
    return { catalog, emptied: false };
  }
  const kept = catalog.filter(
    (model) => model.costTier && allowedCostTiers.includes(model.costTier),
  );
  if (kept.length === 0) return { catalog, emptied: true };
  return { catalog: kept, emptied: false };
}

/** Dollars shown to admins; micros never leave the server. */
export function aiControlMicrosToUsd(micros: number): number {
  return Math.round((micros / 1_000_000) * 100) / 100;
}

/** Admin-entered dollars to stored micros. */
export function aiControlUsdToMicros(usd: number): number {
  return Math.round(usd * 1_000_000);
}
