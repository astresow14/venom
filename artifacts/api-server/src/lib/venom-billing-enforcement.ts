/**
 * Payer resolution and allowance enforcement for every Venom AI request.
 *
 * Billing follows the space, never the content: a request made inside a
 * shared workspace whose Organization plan is live bills that workspace's
 * allowance; every other request (personal space, or a workspace without a
 * live org plan) bills the caller's personal plan. There is no
 * content-based classification anywhere, by design.
 *
 * Enforcement is server-side, hard, and concurrency-safe. Admission is
 * never read-then-act: a real paid-work admission runs inside a
 * payer-locked transaction that counts durable spend PLUS open
 * reservations, and admits only while the request's own priced worst case
 * still fits the allowance. Reservations are database rows, so parallel
 * requests, parallel server processes, and restarts all see the same
 * pending spend. The worst-case bound is honest because every provider
 * adapter hard-caps output tokens per call.
 *
 * With Stripe unconfigured there is nothing to upgrade to, so enforcement
 * stands down and Venom behaves exactly as before billing existed — payer
 * tagging still happens so history stays truthful, and no reservation rows
 * are ever written. Tests force enforcement on via VENOM_BILLING_ENFORCE=1.
 */

import {
  db,
  venomAllowanceReservationsTable,
  venomSharedWorkspacesTable,
  venomUsageEvents,
} from "@workspace/db";
import { and, eq, gte, isNull, lt, sql } from "drizzle-orm";

import {
  approachingWarnRatio,
  planAllowanceMicros,
  venomPlan,
} from "./venom-billing-plans";
import {
  billingPeriodFor,
  effectivePersonalPlanId,
  getBillingAccount,
  workspaceOrgPlanActive,
  type BillingPeriod,
} from "./venom-billing-store";
import { stripeConfigured } from "./venom-stripe";
import {
  BOUND_CHARS_PER_TOKEN,
  maxCatalogCostMicros,
  PROVIDER_MAX_OUTPUT_TOKENS,
  PROVIDER_MAX_PROMPT_CHARS,
} from "./venom-usage-pricing";
import { venomAllowanceLockSql } from "./venom-usage-store";
import {
  effectiveMemberCapMicros,
  loadMemberAiCapOverride,
  loadWorkspaceAiControls,
  sumMemberWorkspaceBilledMicros,
} from "./venom-workspace-ai-controls";

/** Whether exhausted allowances actually block requests right now. */
export function billingEnforcementActive(): boolean {
  return stripeConfigured() || process.env.VENOM_BILLING_ENFORCE === "1";
}

export type VenomPayer =
  | { kind: "personal"; userId: string }
  | { kind: "workspace"; workspaceId: string };

/**
 * Resolve who pays for a request from the space it runs in. Purely
 * DB-driven: a lapsed Organization plan silently falls back to the caller's
 * personal plan, which is exactly the task's required behavior.
 */
export async function resolveVenomPayer(input: {
  userId: string;
  workspaceId?: string | null;
}): Promise<VenomPayer> {
  if (input.workspaceId) {
    const account = await getBillingAccount("workspace", input.workspaceId);
    if (workspaceOrgPlanActive(account)) {
      return { kind: "workspace", workspaceId: input.workspaceId };
    }
  }
  return { kind: "personal", userId: input.userId };
}

/** Either the root client or a transaction — both share the query API. */
type DbExecutor = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

/** Sum of billed micro-dollars for a payer inside a period. */
export async function sumBilledMicros(
  payer: VenomPayer,
  period: BillingPeriod,
  executor: DbExecutor = db,
): Promise<number> {
  const scope =
    payer.kind === "personal"
      ? and(
          eq(venomUsageEvents.userId, payer.userId),
          isNull(venomUsageEvents.billedWorkspaceId),
        )
      : eq(venomUsageEvents.billedWorkspaceId, payer.workspaceId);
  const rows = await executor
    .select({
      costMicros: sql<string>`coalesce(sum(${venomUsageEvents.costMicros}), 0)::bigint`,
    })
    .from(venomUsageEvents)
    .where(
      and(
        scope,
        gte(venomUsageEvents.occurredAt, period.start),
        lt(venomUsageEvents.occurredAt, period.end),
      ),
    );
  return Number(rows[0]?.costMicros ?? 0);
}

// ─── Reservations ────────────────────────────────────────────────────────────

/** Reservations older than this were leaked by a crash; admission reaps them. */
export const RESERVATION_STALE_MS = 10 * 60 * 1000;

/**
 * Priced worst case of one admitted request, in micro-dollars. Derived from
 * the two ceilings dispatch actually enforces — the prompt-chars cap and
 * the output-token cap every adapter applies — at the priciest catalog
 * rate, because admission happens before the model policy picks a voice.
 * Env-tunable for pricing drift; floored so a bad value cannot reserve $0.
 */
export function requestBoundMicros(): number {
  const raw = Number(process.env.VENOM_BILLING_REQUEST_BOUND_MICROS);
  if (Number.isFinite(raw) && raw >= 1_000) return Math.floor(raw);
  return maxCatalogCostMicros(
    Math.ceil(PROVIDER_MAX_PROMPT_CHARS / BOUND_CHARS_PER_TOKEN),
    PROVIDER_MAX_OUTPUT_TOKENS,
  );
}

/**
 * A caller-supplied bound wins when its route enforces tighter input caps
 * than generic dispatch (voice legs, the short-leashed judge). The floor
 * keeps a buggy zero from reserving nothing.
 */
function effectiveBoundMicros(override?: number): number {
  if (override !== undefined && Number.isFinite(override)) {
    return Math.max(1_000, Math.floor(override));
  }
  return requestBoundMicros();
}

function payerScope(payer: VenomPayer): {
  scopeType: "user" | "workspace";
  scopeId: string;
} {
  return payer.kind === "workspace"
    ? { scopeType: "workspace", scopeId: payer.workspaceId }
    : { scopeType: "user", scopeId: payer.userId };
}

/**
 * Release one admission's reservation. Idempotent and never throws: the
 * settle path (the request's first durable usage insert) usually deleted
 * the row already, and anything a failed release leaks is reaped by age.
 */
export async function releaseVenomAllowanceReservation(
  reservationId: string | null | undefined,
): Promise<void> {
  if (!reservationId) return;
  try {
    await db
      .delete(venomAllowanceReservationsTable)
      .where(eq(venomAllowanceReservationsTable.id, reservationId));
  } catch (error) {
    console.error("[venom-billing] reservation release failed", error);
  }
}

type AdmissionOutcome = {
  spent: number;
  fits: boolean;
  reservationId: string | null;
  /**
   * The requesting member's own workspace-billed spend, present whenever a
   * member identity was passed for a workspace payer (cap or no cap).
   */
  memberSpent?: number;
  /** What refused admission when `fits` is false. */
  blockedBy?: "allowance" | "member_cap";
};

/**
 * For workspace payers: who is asking, and the admin cap that binds them
 * (null capMicros = no cap, identity still stamped on the reservation so
 * concurrent admissions can be counted per member).
 */
type MemberAdmission = {
  clerkUserId: string;
  capMicros: number | null;
};

/**
 * The concurrency-safe core: serialize per payer with an advisory lock,
 * reap stale reservations, and admit only while durable spend + open
 * reservations + this request's own priced bound fit the allowance. Two
 * parallel requests racing for the last slice therefore admit exactly one —
 * across every server process, because the lock and the rows are Postgres'.
 */
async function admitWithinAllowance(
  payer: VenomPayer,
  allowanceMicros: number,
  period: BillingPeriod,
  reserve: boolean,
  now: Date,
  boundMicros?: number,
  member?: MemberAdmission,
): Promise<AdmissionOutcome> {
  const memberWorkspaceId =
    payer.kind === "workspace" && member ? payer.workspaceId : null;
  if (!reserve) {
    // Read-only callers (billing summaries, the composer hint) only need
    // the display state; they must not hold budget.
    const [spent, memberSpent] = await Promise.all([
      sumBilledMicros(payer, period),
      memberWorkspaceId && member
        ? sumMemberWorkspaceBilledMicros(
            memberWorkspaceId,
            member.clerkUserId,
            period,
          )
        : Promise.resolve(undefined),
    ]);
    if (spent >= allowanceMicros) {
      return {
        spent,
        fits: false,
        reservationId: null,
        memberSpent,
        blockedBy: "allowance",
      };
    }
    if (
      member?.capMicros != null &&
      memberSpent !== undefined &&
      memberSpent >= member.capMicros
    ) {
      return {
        spent,
        fits: false,
        reservationId: null,
        memberSpent,
        blockedBy: "member_cap",
      };
    }
    return { spent, fits: true, reservationId: null, memberSpent };
  }
  const { scopeType, scopeId } = payerScope(payer);
  const bound = effectiveBoundMicros(boundMicros);
  return await db.transaction(async (tx): Promise<AdmissionOutcome> => {
    // Shared with reservation settlement (venom-usage-store), which swaps
    // a hold for its spend row under this same lock so the cost can never
    // vanish from both aggregate reads mid-admission. The same payer lock
    // also serializes every member's admission for this workspace, so the
    // member-cap math below is race-free without a second lock.
    await tx.execute(venomAllowanceLockSql(scopeType, scopeId));
    await tx
      .delete(venomAllowanceReservationsTable)
      .where(
        and(
          eq(venomAllowanceReservationsTable.scopeType, scopeType),
          eq(venomAllowanceReservationsTable.scopeId, scopeId),
          lt(
            venomAllowanceReservationsTable.createdAt,
            new Date(now.getTime() - RESERVATION_STALE_MS),
          ),
        ),
      );
    const [spent, reservedRows, memberSpent, memberReservedRows] =
      await Promise.all([
        sumBilledMicros(payer, period, tx),
        tx
          .select({
            reserved: sql<string>`coalesce(sum(${venomAllowanceReservationsTable.reservedMicros}), 0)::bigint`,
          })
          .from(venomAllowanceReservationsTable)
          .where(
            and(
              eq(venomAllowanceReservationsTable.scopeType, scopeType),
              eq(venomAllowanceReservationsTable.scopeId, scopeId),
            ),
          ),
        memberWorkspaceId && member
          ? sumMemberWorkspaceBilledMicros(
              memberWorkspaceId,
              member.clerkUserId,
              period,
              tx,
            )
          : Promise.resolve(undefined),
        memberWorkspaceId && member?.capMicros != null
          ? tx
              .select({
                reserved: sql<string>`coalesce(sum(${venomAllowanceReservationsTable.reservedMicros}), 0)::bigint`,
              })
              .from(venomAllowanceReservationsTable)
              .where(
                and(
                  eq(venomAllowanceReservationsTable.scopeType, scopeType),
                  eq(venomAllowanceReservationsTable.scopeId, scopeId),
                  eq(
                    venomAllowanceReservationsTable.reservedForClerkUserId,
                    member.clerkUserId,
                  ),
                ),
              )
          : Promise.resolve(null),
      ]);
    const reserved = Number(reservedRows[0]?.reserved ?? 0);
    // Hard limit means the whole worst case must fit: a sliver of remaining
    // balance cannot admit a request that could stream past it.
    if (spent + reserved + bound > allowanceMicros) {
      return {
        spent,
        fits: false,
        reservationId: null,
        memberSpent,
        blockedBy: "allowance",
      };
    }
    // The member's admin cap works the same way, against their own durable
    // spend plus their own open holds — two of their requests racing for
    // the last capped slice admit exactly one.
    if (member?.capMicros != null && memberSpent !== undefined) {
      const memberReserved = Number(memberReservedRows?.[0]?.reserved ?? 0);
      if (memberSpent + memberReserved + bound > member.capMicros) {
        return {
          spent,
          fits: false,
          reservationId: null,
          memberSpent,
          blockedBy: "member_cap",
        };
      }
    }
    const inserted = await tx
      .insert(venomAllowanceReservationsTable)
      .values({
        scopeType,
        scopeId,
        reservedMicros: bound,
        reservedForClerkUserId: member?.clerkUserId ?? null,
      })
      .returning({ id: venomAllowanceReservationsTable.id });
    return {
      spent,
      fits: true,
      reservationId: inserted[0]?.id ?? null,
      memberSpent,
    };
  });
}

export type VenomAllowanceBlockCode =
  | "personal_allowance_exhausted"
  | "workspace_allowance_exhausted"
  | "workspace_member_cap_reached";

export type VenomAllowanceDecision = {
  payer: VenomPayer;
  /** Tag for the usage ledger: which workspace paid, or null for personal. */
  billedWorkspaceId: string | null;
  allowed: boolean;
  /** Present exactly when blocked. */
  blockedCode?: VenomAllowanceBlockCode;
  /** Friendly, situation-specific copy for the blocked state. */
  blockedMessage?: string;
  /** True while allowed but past the approaching-limit warn ratio. */
  approaching: boolean;
  /**
   * The admission's open reservation, present when `reserve` was requested
   * and the request was admitted under active enforcement. The caller MUST
   * hand it to its usage recording (which settles it atomically) and
   * release it on every other outcome; leaked rows are reaped by age.
   */
  reservationId?: string | null;
  /**
   * Where the caller stands against their admin-set member cap, present
   * for workspace payers exactly when such a cap binds them. States only —
   * the figures behind them belong to admins.
   */
  memberCapState?: "ok" | "approaching" | "exhausted";
};

async function workspaceName(workspaceId: string): Promise<string> {
  const rows = await db
    .select({ name: venomSharedWorkspacesTable.name })
    .from(venomSharedWorkspacesTable)
    .where(eq(venomSharedWorkspacesTable.id, workspaceId))
    .limit(1);
  return rows[0]?.name ?? "This workspace";
}

/**
 * The single allowance gate every AI path calls before doing paid work.
 * Resolves the payer, then decides — atomically reserving the request's
 * worst case when `reserve` is set. Never throws for billing reasons — an
 * internal failure fails open (the request proceeds, personally billed)
 * because a broken billing lookup must not take chat down with it.
 */
export async function checkVenomAllowance(input: {
  userId: string;
  workspaceId?: string | null;
  now?: Date;
  /** Real paid-work admission; read-only callers only inspect allowance. */
  reserve?: boolean;
  /**
   * Priced worst case of THIS request, when the caller enforces tighter
   * input/output caps than generic dispatch. Defaults to the dispatch-wide
   * worst case (`requestBoundMicros`).
   */
  boundMicros?: number;
}): Promise<VenomAllowanceDecision> {
  const now = input.now ?? new Date();
  try {
    const payer = await resolveVenomPayer(input);
    const billedWorkspaceId =
      payer.kind === "workspace" ? payer.workspaceId : null;
    if (!billingEnforcementActive()) {
      return { payer, billedWorkspaceId, allowed: true, approaching: false };
    }

    if (payer.kind === "workspace") {
      const [account, controls, override] = await Promise.all([
        getBillingAccount("workspace", payer.workspaceId),
        loadWorkspaceAiControls(payer.workspaceId),
        loadMemberAiCapOverride(payer.workspaceId, input.userId),
      ]);
      const capMicros = effectiveMemberCapMicros(controls, override);
      const plan = venomPlan("org");
      const allowance = planAllowanceMicros(plan);
      const period = billingPeriodFor(account, now);
      const outcome = await admitWithinAllowance(
        payer,
        allowance,
        period,
        input.reserve === true,
        now,
        input.boundMicros,
        { clerkUserId: input.userId, capMicros },
      );
      // Cap states are computed against durable spend so the composer's
      // read-only checks agree with admissions; a block by the cap itself
      // is "exhausted" regardless (requests are being refused right now).
      const memberCapState: VenomAllowanceDecision["memberCapState"] =
        capMicros === null
          ? undefined
          : outcome.blockedBy === "member_cap" ||
              (outcome.memberSpent ?? 0) >= capMicros
            ? "exhausted"
            : (outcome.memberSpent ?? 0) >= capMicros * approachingWarnRatio()
              ? "approaching"
              : "ok";
      if (!outcome.fits) {
        const name = await workspaceName(payer.workspaceId);
        if (outcome.blockedBy === "member_cap") {
          return {
            payer,
            billedWorkspaceId,
            allowed: false,
            blockedCode: "workspace_member_cap_reached",
            blockedMessage:
              `You've reached your AI limit in ${name} for this period. ` +
              `This member limit was set by the workspace's admins — your ` +
              `personal plan and personal space aren't affected. An admin ` +
              `can raise it from the workspace's usage controls.`,
            approaching: false,
            memberCapState,
          };
        }
        return {
          payer,
          billedWorkspaceId,
          allowed: false,
          blockedCode: "workspace_allowance_exhausted",
          blockedMessage:
            `${name} has used its ${plan.name} plan's included AI for this period. ` +
            `This is the workspace's limit — your personal plan is fine. ` +
            `A workspace admin can manage the plan from workspace settings.`,
          approaching: false,
          memberCapState,
        };
      }
      return {
        payer,
        billedWorkspaceId,
        allowed: true,
        approaching:
          outcome.spent >= allowance * approachingWarnRatio() ||
          memberCapState === "approaching",
        reservationId: outcome.reservationId,
        memberCapState,
      };
    }

    const account = await getBillingAccount("user", payer.userId);
    const planId = effectivePersonalPlanId(account);
    const plan = venomPlan(planId);
    const allowance = planAllowanceMicros(plan);
    const period = billingPeriodFor(planId === "free" ? null : account, now);
    const outcome = await admitWithinAllowance(
      payer,
      allowance,
      period,
      input.reserve === true,
      now,
    );
    if (!outcome.fits) {
      const resetDay = period.end.toISOString().slice(0, 10);
      return {
        payer,
        billedWorkspaceId,
        allowed: false,
        blockedCode: "personal_allowance_exhausted",
        blockedMessage:
          planId === "free"
            ? `You've used all of the ${plan.name} plan's included AI for this period. ` +
              `Upgrade to keep going — or your allowance resets on ${resetDay}.`
            : `You've used all of the ${plan.name} plan's included AI for this period. ` +
              `Your allowance resets on ${resetDay}.`,
        approaching: false,
      };
    }
    return {
      payer,
      billedWorkspaceId,
      allowed: true,
      approaching: outcome.spent >= allowance * approachingWarnRatio(),
      reservationId: outcome.reservationId,
    };
  } catch (error) {
    console.error("[venom-billing] allowance check failed open", error);
    return {
      payer: { kind: "personal", userId: input.userId },
      billedWorkspaceId: null,
      allowed: true,
      approaching: false,
    };
  }
}

/** Standard JSON body for a blocked request; clients key off `code`. */
export function allowanceBlockedBody(decision: VenomAllowanceDecision): {
  error: string;
  code: VenomAllowanceBlockCode;
} {
  return {
    error:
      decision.blockedMessage ??
      "This request would exceed the current plan's included AI.",
    code: decision.blockedCode ?? "personal_allowance_exhausted",
  };
}
