/**
 * Venom billing accounts: the local mirror of Stripe subscription state.
 *
 * One row per payer — a person or a shared workspace. Rows appear lazily;
 * a missing row means "free tier, never subscribed". Webhooks (and the
 * checkout flow) are the only writers of Stripe-derived fields, so this
 * module is the single place that interprets Stripe's vocabulary. Everything
 * downstream (payer resolution, allowance enforcement, billing UI) reads
 * plan state through the helpers here and stays Stripe-agnostic.
 *
 * Benefit rule: `active`, `trialing`, and `past_due` keep plan benefits —
 * past_due is Stripe's payment-retry window and yanking access on the first
 * failed card attempt would punish a flaky bank, not a lapsed customer.
 * Every other status (canceled, unpaid, incomplete…) drops the payer to the
 * free tier (people) or to uncovered (workspaces).
 */

import { db, venomBillingAccountsTable } from "@workspace/db";
import type { VenomBillingAccountRow } from "@workspace/db";
import { and, eq } from "drizzle-orm";
import type Stripe from "stripe";

import {
  isPersonalPlanId,
  isVenomPlanId,
  venomPlan,
  type VenomPersonalPlanId,
  type VenomPlanId,
} from "./venom-billing-plans";
import { getVenomStripe } from "./venom-stripe";

export type BillingScopeType = "user" | "workspace";

// ─── Reads ───────────────────────────────────────────────────────────────────

export async function getBillingAccount(
  scopeType: BillingScopeType,
  scopeId: string,
): Promise<VenomBillingAccountRow | null> {
  const rows = await db
    .select()
    .from(venomBillingAccountsTable)
    .where(
      and(
        eq(venomBillingAccountsTable.scopeType, scopeType),
        eq(venomBillingAccountsTable.scopeId, scopeId),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

/** Statuses that keep a subscription's benefits flowing. */
export function statusKeepsBenefits(status: string): boolean {
  return status === "active" || status === "trialing" || status === "past_due";
}

/**
 * The personal plan a user's requests actually draw on right now. A paid
 * plan only counts while its subscription keeps benefits; everything else
 * falls back to free.
 */
export function effectivePersonalPlanId(
  account: VenomBillingAccountRow | null,
): VenomPersonalPlanId {
  if (!account) return "free";
  if (!isPersonalPlanId(account.planId)) return "free";
  if (account.planId === "free") return "free";
  return statusKeepsBenefits(account.status) ? account.planId : "free";
}

/** Whether a workspace is covered by a live Organization plan. */
export function workspaceOrgPlanActive(
  account: VenomBillingAccountRow | null,
): boolean {
  return (
    account !== null &&
    account.planId === "org" &&
    statusKeepsBenefits(account.status)
  );
}

export type BillingPeriod = {
  /** Inclusive start. */
  start: Date;
  /** Exclusive end. */
  end: Date;
  /** Where the boundaries came from. */
  source: "stripe" | "calendar";
};

/**
 * The allowance period for a payer: the Stripe billing period when a live
 * subscription reports one that contains `now`, otherwise the current UTC
 * calendar month (free tier, lapsed subscriptions, and webhook lag all land
 * here — a stale period must never widen the spend window).
 */
export function billingPeriodFor(
  account: VenomBillingAccountRow | null,
  now: Date = new Date(),
): BillingPeriod {
  const start = account?.currentPeriodStart ?? null;
  const end = account?.currentPeriodEnd ?? null;
  if (
    account &&
    statusKeepsBenefits(account.status) &&
    start !== null &&
    end !== null &&
    start.getTime() <= now.getTime() &&
    now.getTime() < end.getTime()
  ) {
    return { start, end, source: "stripe" };
  }
  const calendarStart = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1),
  );
  const calendarEnd = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1),
  );
  return { start: calendarStart, end: calendarEnd, source: "calendar" };
}

// ─── Writes ──────────────────────────────────────────────────────────────────

export type StripeSubscriptionState = {
  scopeType: BillingScopeType;
  scopeId: string;
  planId: VenomPlanId;
  status: string;
  stripeCustomerId: string | null;
  stripeSubscriptionId: string | null;
  currentPeriodStart: Date | null;
  currentPeriodEnd: Date | null;
  cancelAtPeriodEnd: boolean;
};

/** Upsert the full Stripe-derived state for a payer. */
export async function applySubscriptionState(
  state: StripeSubscriptionState,
): Promise<void> {
  const values = {
    scopeType: state.scopeType,
    scopeId: state.scopeId,
    planId: state.planId,
    status: state.status,
    stripeCustomerId: state.stripeCustomerId,
    stripeSubscriptionId: state.stripeSubscriptionId,
    currentPeriodStart: state.currentPeriodStart,
    currentPeriodEnd: state.currentPeriodEnd,
    cancelAtPeriodEnd: state.cancelAtPeriodEnd,
    updatedAt: new Date(),
  };
  await db
    .insert(venomBillingAccountsTable)
    .values(values)
    .onConflictDoUpdate({
      target: [
        venomBillingAccountsTable.scopeType,
        venomBillingAccountsTable.scopeId,
      ],
      set: values,
    });
}

/** Remember which Stripe customer a payer maps to (checkout bootstrap). */
export async function rememberStripeCustomer(
  scopeType: BillingScopeType,
  scopeId: string,
  stripeCustomerId: string,
): Promise<void> {
  await db
    .insert(venomBillingAccountsTable)
    .values({ scopeType, scopeId, stripeCustomerId })
    .onConflictDoUpdate({
      target: [
        venomBillingAccountsTable.scopeType,
        venomBillingAccountsTable.scopeId,
      ],
      set: { stripeCustomerId, updatedAt: new Date() },
    });
}

// ─── Webhook interpretation ──────────────────────────────────────────────────

type ScopeRef = { scopeType: BillingScopeType; scopeId: string };

function scopeFromMetadata(
  metadata: Record<string, string> | null | undefined,
): ScopeRef | null {
  const scopeType = metadata?.venomScopeType;
  const scopeId = metadata?.venomScopeId;
  if ((scopeType === "user" || scopeType === "workspace") && scopeId) {
    return { scopeType, scopeId };
  }
  return null;
}

function planFromMetadata(
  metadata: Record<string, string> | null | undefined,
  scopeType: BillingScopeType,
): VenomPlanId {
  const raw = metadata?.venomPlanId;
  if (raw && isVenomPlanId(raw)) return raw;
  return scopeType === "workspace" ? "org" : "plus";
}

async function findAccountBySubscriptionId(
  subscriptionId: string,
): Promise<VenomBillingAccountRow | null> {
  const rows = await db
    .select()
    .from(venomBillingAccountsTable)
    .where(eq(venomBillingAccountsTable.stripeSubscriptionId, subscriptionId))
    .limit(1);
  return rows[0] ?? null;
}

async function findAccountByCustomerId(
  customerId: string,
): Promise<VenomBillingAccountRow | null> {
  const rows = await db
    .select()
    .from(venomBillingAccountsTable)
    .where(eq(venomBillingAccountsTable.stripeCustomerId, customerId))
    .limit(1);
  return rows[0] ?? null;
}

/**
 * Billing period boundaries from a Stripe subscription. Newer Stripe API
 * versions report the current period on the subscription item; older ones
 * on the subscription itself. Read both shapes so an account-level API
 * version change cannot silently drop periods.
 */
function subscriptionPeriod(sub: Stripe.Subscription): {
  start: Date | null;
  end: Date | null;
} {
  const loose = sub as unknown as {
    current_period_start?: number | null;
    current_period_end?: number | null;
    items?: { data?: Array<Record<string, unknown>> };
  };
  const item = loose.items?.data?.[0] as
    | { current_period_start?: number | null; current_period_end?: number | null }
    | undefined;
  const startSec = item?.current_period_start ?? loose.current_period_start;
  const endSec = item?.current_period_end ?? loose.current_period_end;
  return {
    start: typeof startSec === "number" ? new Date(startSec * 1000) : null,
    end: typeof endSec === "number" ? new Date(endSec * 1000) : null,
  };
}

function idOf(ref: string | { id: string } | null | undefined): string | null {
  if (!ref) return null;
  return typeof ref === "string" ? ref : ref.id;
}

async function applyFromSubscription(
  sub: Stripe.Subscription,
  fallbackScope: ScopeRef | null,
): Promise<void> {
  const scope =
    scopeFromMetadata(sub.metadata) ??
    fallbackScope ??
    (await findAccountBySubscriptionId(sub.id).then((account) =>
      account
        ? {
            scopeType: account.scopeType as BillingScopeType,
            scopeId: account.scopeId,
          }
        : null,
    ));
  if (!scope) {
    console.warn(
      `[venom-billing] subscription ${sub.id} carries no Venom scope; ignoring`,
    );
    return;
  }
  const period = subscriptionPeriod(sub);
  await applySubscriptionState({
    scopeType: scope.scopeType,
    scopeId: scope.scopeId,
    planId: planFromMetadata(sub.metadata, scope.scopeType),
    status: sub.status,
    stripeCustomerId: idOf(sub.customer as string | { id: string }),
    stripeSubscriptionId: sub.id,
    currentPeriodStart: period.start,
    currentPeriodEnd: period.end,
    cancelAtPeriodEnd: Boolean(sub.cancel_at_period_end),
  });
}

/**
 * Apply one verified Stripe event to the local mirror. Unknown event types
 * are ignored on purpose — Stripe retries webhooks, so this must stay
 * idempotent and never throw for events it simply doesn't care about.
 */
export async function applyStripeEvent(event: Stripe.Event): Promise<void> {
  switch (event.type) {
    case "checkout.session.completed": {
      const session = event.data.object as Stripe.Checkout.Session;
      if (session.mode !== "subscription") return;
      const scope = scopeFromMetadata(
        session.metadata as Record<string, string> | null,
      );
      const subscriptionId = idOf(
        session.subscription as string | { id: string } | null,
      );
      const customerId = idOf(
        session.customer as string | { id: string } | null,
      );
      if (!scope) {
        console.warn(
          "[venom-billing] checkout session completed without Venom scope metadata; ignoring",
        );
        return;
      }
      if (customerId) {
        await rememberStripeCustomer(scope.scopeType, scope.scopeId, customerId);
      }
      if (!subscriptionId) return;
      // The session payload doesn't carry status/periods; pull the live
      // subscription. Its own created/updated webhooks will land too — both
      // paths write the same normalized state, so order doesn't matter.
      const stripe = getVenomStripe();
      if (!stripe) return;
      try {
        const sub = await stripe.subscriptions.retrieve(subscriptionId);
        await applyFromSubscription(sub, scope);
      } catch (error) {
        console.error(
          `[venom-billing] failed to load subscription ${subscriptionId} after checkout`,
          error,
        );
      }
      return;
    }
    case "customer.subscription.created":
    case "customer.subscription.updated":
    case "customer.subscription.deleted": {
      const eventSubscription = event.data.object as Stripe.Subscription;
      const stripe = getVenomStripe();
      if (!stripe) {
        throw new Error(
          "Stripe client is unavailable while applying a verified subscription event",
        );
      }
      // Stripe does not promise webhook delivery order. Never mirror the
      // event payload directly: a delayed `updated(active)` after `deleted`
      // would otherwise resurrect paid benefits. Fetching the subscription's
      // current canonical state makes every delivery (including retries)
      // converge on what Stripe says now.
      const currentSubscription = await stripe.subscriptions.retrieve(
        eventSubscription.id,
      );
      await applyFromSubscription(currentSubscription, null);
      return;
    }
    case "invoice.payment_failed": {
      // Belt and braces: subscription.updated normally carries past_due
      // too, but a direct signal keeps the mirror honest if that event is
      // delayed. Never resurrects a canceled subscription.
      const invoice = event.data.object as Stripe.Invoice;
      const customerId = idOf(
        invoice.customer as string | { id: string } | null,
      );
      if (!customerId) return;
      const account = await findAccountByCustomerId(customerId);
      if (!account || !statusKeepsBenefits(account.status)) return;
      await db
        .update(venomBillingAccountsTable)
        .set({ status: "past_due", updatedAt: new Date() })
        .where(eq(venomBillingAccountsTable.id, account.id));
      return;
    }
    default:
      return;
  }
}

/** Human copy for a plan's renewal line; shared by summary endpoints. */
export function planDisplayName(planId: VenomPlanId): string {
  return venomPlan(planId).name;
}
