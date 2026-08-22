/**
 * Venom plan catalog: names, prices, and monthly AI allowances.
 *
 * Everything here is configuration with sensible placeholder values — the
 * owner adjusts plans through environment variables, never code changes.
 * Prices are what Stripe charges per month; allowances are how many dollars
 * of metered AI usage a period includes before requests hard-block with an
 * upgrade prompt (no overage billing, ever).
 *
 * Two personal tiers (free, plus) and one workspace tier (org) exist. The
 * Organization plan is bought by a workspace admin for the workspace itself;
 * chats inside a covered workspace draw on the workspace allowance instead
 * of any member's personal plan.
 *
 * Values are read lazily on every call so tests (and the owner, without a
 * rebuild) can adjust them via env alone.
 */

export type VenomPersonalPlanId = "free" | "plus";
export type VenomPlanId = VenomPersonalPlanId | "org";

export type VenomPlanDefinition = {
  id: VenomPlanId;
  /** Customer-facing plan name. */
  name: string;
  /** Monthly price in whole dollars charged through Stripe. 0 = free tier. */
  priceUsd: number;
  /** Monthly AI allowance in dollars of metered usage. */
  allowanceUsd: number;
  /** Who this plan can attach to. */
  scope: "user" | "workspace";
};

function envNumber(key: string, fallback: number): number {
  const raw = process.env[key];
  if (raw === undefined || raw.trim() === "") return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) return fallback;
  return parsed;
}

function envName(key: string, fallback: string): string {
  const raw = process.env[key]?.trim();
  return raw ? raw.slice(0, 60) : fallback;
}

export function venomPlan(id: VenomPlanId): VenomPlanDefinition {
  switch (id) {
    case "free":
      return {
        id: "free",
        name: envName("VENOM_PLAN_FREE_NAME", "Free"),
        priceUsd: 0,
        allowanceUsd: envNumber("VENOM_PLAN_FREE_ALLOWANCE_USD", 5),
        scope: "user",
      };
    case "plus":
      return {
        id: "plus",
        name: envName("VENOM_PLAN_PLUS_NAME", "Plus"),
        priceUsd: envNumber("VENOM_PLAN_PLUS_PRICE_USD", 15),
        allowanceUsd: envNumber("VENOM_PLAN_PLUS_ALLOWANCE_USD", 50),
        scope: "user",
      };
    case "org":
      return {
        id: "org",
        name: envName("VENOM_PLAN_ORG_NAME", "Organization"),
        priceUsd: envNumber("VENOM_PLAN_ORG_PRICE_USD", 99),
        allowanceUsd: envNumber("VENOM_PLAN_ORG_ALLOWANCE_USD", 250),
        scope: "workspace",
      };
  }
}

export function isPersonalPlanId(id: string): id is VenomPersonalPlanId {
  return id === "free" || id === "plus";
}

export function isVenomPlanId(id: string): id is VenomPlanId {
  return id === "free" || id === "plus" || id === "org";
}

/** Allowance in micro-dollars, the unit the usage ledger stores. */
export function planAllowanceMicros(plan: VenomPlanDefinition): number {
  return Math.round(plan.allowanceUsd * 1_000_000);
}

/**
 * Fraction of the allowance at which clients start warning that the limit
 * is approaching. Owner-tunable; clamped to a sane band.
 */
export function approachingWarnRatio(): number {
  const ratio = envNumber("VENOM_BILLING_WARN_RATIO", 0.8);
  if (ratio <= 0 || ratio >= 1) return 0.8;
  return ratio;
}
