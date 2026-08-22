/**
 * Venom billing routes: personal plan surface, the composer's payer hint,
 * Stripe checkout/portal bootstrap, workspace Organization-plan management,
 * and the signature-verified Stripe webhook.
 *
 * Boundaries this router enforces:
 * - Money leaves as whole dollars under configured plan names; micro-dollar
 *   ledger math and Stripe vocabulary stay server-side.
 * - Personal summaries cover personally-billed spend only. A member never
 *   sees workspace-billed dollar figures — the workspace surface returns
 *   spend to admins alone; members get plan name and state, nothing else.
 * - With no Stripe keys, every read surface answers gracefully with
 *   `configured: false` and checkout/portal answer 503
 *   `billing_not_configured`; nothing else in Venom changes.
 */

import { Router, type IRouter, type Request, type Response } from "express";
import { getAuth } from "@clerk/express";

import {
  approachingWarnRatio,
  planAllowanceMicros,
  venomPlan,
  type VenomPlanDefinition,
} from "../lib/venom-billing-plans";
import {
  applyStripeEvent,
  billingPeriodFor,
  effectivePersonalPlanId,
  getBillingAccount,
  workspaceOrgPlanActive,
  statusKeepsBenefits,
} from "../lib/venom-billing-store";
import {
  billingEnforcementActive,
  resolveVenomPayer,
  sumBilledMicros,
} from "../lib/venom-billing-enforcement";
import {
  effectiveMemberCapMicros,
  loadMemberAiCapOverride,
  loadWorkspaceAiControls,
  sumMemberWorkspaceBilledMicros,
  workspaceModelLockActive,
} from "../lib/venom-workspace-ai-controls";
import {
  getVenomStripe,
  stripeConfigured,
  stripeWebhookConfigured,
  verifyStripeWebhook,
} from "../lib/venom-stripe";
import { microsToUsd } from "../lib/venom-usage-pricing";
import {
  getSharedWorkspaceMembership,
  isSharedWorkspaceId,
  workspaceAccessDeniedBody,
  workspaceAdminRequiredBody,
  type SharedWorkspaceMembership,
} from "../lib/workspace-membership";
import { db, venomSharedWorkspacesTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import {
  GetSharedWorkspaceBillingParams,
  CreateSharedWorkspaceBillingCheckoutParams,
  CreateSharedWorkspaceBillingPortalParams,
} from "@workspace/api-zod";

export const BILLING_NOT_CONFIGURED_CODE = "billing_not_configured";

function billingNotConfiguredBody(): { error: string; code: string } {
  return {
    error:
      "Billing isn't set up on this server yet. Everything else keeps working.",
    code: BILLING_NOT_CONFIGURED_CODE,
  };
}

/** ok | approaching | exhausted, from spend vs allowance. */
function allowanceState(
  spentMicros: number,
  allowanceMicros: number,
): "ok" | "approaching" | "exhausted" {
  if (spentMicros >= allowanceMicros) return "exhausted";
  if (spentMicros >= allowanceMicros * approachingWarnRatio()) {
    return "approaching";
  }
  return "ok";
}

/** Round dollars for display payloads (cent precision is plenty here). */
function usd(micros: number): number {
  return Math.round(microsToUsd(micros) * 100) / 100;
}

function planPayload(plan: VenomPlanDefinition): {
  id: string;
  name: string;
  priceUsd: number;
  allowanceUsd: number;
} {
  return {
    id: plan.id,
    name: plan.name,
    priceUsd: plan.priceUsd,
    allowanceUsd: plan.allowanceUsd,
  };
}

/**
 * Where Stripe can safely send a customer back after a hosted payment page.
 *
 * Only deployment-configured origins are trusted: the platform's own
 * domain variables plus VENOM_BILLING_RETURN_ORIGINS (comma-separated,
 * for explicitly configured extras such as a local dev origin). Request
 * headers (Origin, Host) are caller-controlled and never join the
 * allowlist — the return address rides into the Stripe-hosted flow, and
 * honoring an attacker's origin would let a payment page redirect to a
 * convincing off-site phish.
 */
function resolveReturnUrl(provided?: string): string | null {
  const allowedOrigins = new Set<string>();
  const addOrigin = (value: string | undefined) => {
    const trimmed = value?.trim();
    if (!trimmed) return;
    try {
      allowedOrigins.add(
        new URL(trimmed.includes("://") ? trimmed : `https://${trimmed}`)
          .origin,
      );
    } catch {
      // A malformed configured value must not widen the allowlist.
    }
  };
  // Insertion order doubles as fallback preference: with no usable URL
  // provided, the customer goes back to the deployment's canonical domain.
  for (const domain of (process.env.REPLIT_DOMAINS ?? "").split(",")) {
    addOrigin(domain);
  }
  addOrigin(process.env.REPLIT_DEV_DOMAIN);
  addOrigin(process.env.REPLIT_EXPO_DEV_DOMAIN);
  for (const origin of (
    process.env.VENOM_BILLING_RETURN_ORIGINS ?? ""
  ).split(",")) {
    addOrigin(origin);
  }

  if (provided) {
    try {
      const url = new URL(provided);
      if (
        (url.protocol === "https:" || url.protocol === "http:") &&
        allowedOrigins.has(url.origin)
      ) {
        return url.toString();
      }
    } catch {
      // fall through to the first-party fallback below
    }
  }
  return allowedOrigins.values().next().value ?? null;
}

/**
 * Stripe persists idempotency keys for 24 hours. Keeping the key stable for a
 * payer and plan makes duplicate clicks, retries, and concurrent requests
 * resolve to one Checkout Session rather than opening subscriptions in
 * parallel. The string contains no customer-entered fields and stays well
 * below Stripe's 255-character limit for our bounded ids.
 */
function checkoutIdempotencyKey(
  scopeType: "user" | "workspace",
  scopeId: string,
  planId: "plus" | "org",
): string {
  return `venom-checkout-v1:${scopeType}:${scopeId}:${planId}`;
}

export type VenomBillingRouterOptions = {
  /** Injectable auth seam for tests. Defaults to Clerk. */
  resolveUserId?: (req: Request) => string | null | undefined;
  /** Injectable membership seam for tests. Defaults to the live table. */
  getMembership?: (
    workspaceId: string,
    userId: string,
  ) => Promise<SharedWorkspaceMembership | null>;
};

export function createVenomBillingRouter(
  options: VenomBillingRouterOptions = {},
): IRouter {
  const resolveUserId =
    options.resolveUserId ?? ((req: Request) => getAuth(req).userId);
  const getMembership = options.getMembership ?? getSharedWorkspaceMembership;

  const router: IRouter = Router();

  // ── Personal plan surface ─────────────────────────────────────────────────

  router.get(
    "/venom/billing/summary",
    async (req: Request, res: Response): Promise<void> => {
      const userId = resolveUserId(req);
      if (!userId) {
        res.status(401).json({ error: "Authentication required" });
        return;
      }
      try {
        const account = await getBillingAccount("user", userId);
        const planId = effectivePersonalPlanId(account);
        const plan = venomPlan(planId);
        const period = billingPeriodFor(planId === "free" ? null : account, new Date());
        const spentMicros = await sumBilledMicros(
          { kind: "personal", userId },
          period,
        );
        const allowanceMicros = planAllowanceMicros(plan);
        res.json({
          configured: stripeConfigured(),
          enforced: billingEnforcementActive(),
          plan: planPayload(plan),
          status: account?.status ?? "none",
          cancelAtPeriodEnd: account?.cancelAtPeriodEnd ?? false,
          periodStart: period.start.toISOString(),
          periodEnd: period.end.toISOString(),
          /** True renewal for paid plans; free allowances reset instead. */
          renews: planId !== "free" && statusKeepsBenefits(account?.status ?? "none"),
          spentUsd: usd(spentMicros),
          remainingUsd: usd(Math.max(0, allowanceMicros - spentMicros)),
          state: allowanceState(spentMicros, allowanceMicros),
          // Omitted (not null) when there is nothing to upgrade to.
          ...(planId === "free"
            ? { upgradePlan: planPayload(venomPlan("plus")) }
            : {}),
          manageable: Boolean(account?.stripeCustomerId) && stripeConfigured(),
        });
      } catch (error) {
        req.log.error({ err: error }, "Venom billing summary failed");
        res.status(500).json({ error: "Billing summary is unavailable" });
      }
    },
  );

  // The composer's payer hint: whose allowance would a message sent right
  // now draw on? Personal figures stay personal; a workspace payer returns
  // plan name and state only — no dollars for members.
  router.get(
    "/venom/billing/context",
    async (req: Request, res: Response): Promise<void> => {
      const userId = resolveUserId(req);
      if (!userId) {
        res.status(401).json({ error: "Authentication required" });
        return;
      }
      const rawWorkspaceId = req.query.workspaceId;
      const workspaceId =
        typeof rawWorkspaceId === "string" && rawWorkspaceId.length > 0
          ? rawWorkspaceId
          : null;
      try {
        if (workspaceId) {
          if (!isSharedWorkspaceId(workspaceId)) {
            res.status(403).json(workspaceAccessDeniedBody());
            return;
          }
          const membership = await getMembership(workspaceId, userId);
          if (!membership) {
            res.status(403).json(workspaceAccessDeniedBody());
            return;
          }
        }
        const payer = await resolveVenomPayer({ userId, workspaceId });
        const enforced = billingEnforcementActive();
        if (payer.kind === "workspace") {
          // Admin AI controls ride the same response the composer already
          // reads: cap state (never figures) and the model lock, so both
          // clients learn "managed by this workspace" from one source.
          const [account, controls, override] = await Promise.all([
            getBillingAccount("workspace", payer.workspaceId),
            loadWorkspaceAiControls(payer.workspaceId),
            loadMemberAiCapOverride(payer.workspaceId, userId),
          ]);
          const plan = venomPlan("org");
          const period = billingPeriodFor(account, new Date());
          const capMicros = effectiveMemberCapMicros(controls, override);
          const [spentMicros, memberSpentMicros] = await Promise.all([
            sumBilledMicros(payer, period),
            enforced && capMicros !== null
              ? sumMemberWorkspaceBilledMicros(
                  payer.workspaceId,
                  userId,
                  period,
                )
              : Promise.resolve(null),
          ]);
          const workspaceRows = await db
            .select({ name: venomSharedWorkspacesTable.name })
            .from(venomSharedWorkspacesTable)
            .where(eq(venomSharedWorkspacesTable.id, payer.workspaceId))
            .limit(1);
          res.json({
            configured: stripeConfigured(),
            enforced,
            payer: "workspace",
            planName: plan.name,
            workspaceId: payer.workspaceId,
            workspaceName: workspaceRows[0]?.name ?? "This workspace",
            state: enforced
              ? allowanceState(spentMicros, planAllowanceMicros(plan))
              : "ok",
            ...(enforced && capMicros !== null && memberSpentMicros !== null
              ? {
                  memberCapState: allowanceState(
                    memberSpentMicros,
                    capMicros,
                  ),
                }
              : {}),
            ...(workspaceModelLockActive(controls)
              ? {
                  modelLock: {
                    forcedSelectionPolicy: controls.forcedSelectionPolicy,
                    allowedCostTiers: controls.allowedCostTiers,
                  },
                }
              : {}),
          });
          return;
        }
        const account = await getBillingAccount("user", userId);
        const planId = effectivePersonalPlanId(account);
        const plan = venomPlan(planId);
        const period = billingPeriodFor(planId === "free" ? null : account, new Date());
        const spentMicros = await sumBilledMicros(payer, period);
        const allowanceMicros = planAllowanceMicros(plan);
        res.json({
          configured: stripeConfigured(),
          enforced,
          payer: "personal",
          planName: plan.name,
          state: enforced
            ? allowanceState(spentMicros, allowanceMicros)
            : "ok",
          remainingUsd: usd(Math.max(0, allowanceMicros - spentMicros)),
        });
      } catch (error) {
        req.log.error({ err: error }, "Venom billing context failed");
        res.status(500).json({ error: "Billing context is unavailable" });
      }
    },
  );

  // ── Stripe-hosted pages (personal) ────────────────────────────────────────

  router.post(
    "/venom/billing/checkout",
    async (req: Request, res: Response): Promise<void> => {
      const userId = resolveUserId(req);
      if (!userId) {
        res.status(401).json({ error: "Authentication required" });
        return;
      }
      const stripe = getVenomStripe();
      if (!stripe) {
        res.status(503).json(billingNotConfiguredBody());
        return;
      }
      const body = (req.body ?? {}) as { planId?: unknown; returnUrl?: unknown };
      // The only personal plan money can buy today. Config, not code,
      // decides its price — but the id set is fixed.
      if (body.planId !== undefined && body.planId !== "plus") {
        res.status(400).json({ error: "Unknown plan" });
        return;
      }
      const plan = venomPlan("plus");
      if (plan.priceUsd <= 0) {
        res.status(400).json({ error: "This plan has no price configured" });
        return;
      }
      const returnUrl = resolveReturnUrl(
        typeof body.returnUrl === "string" ? body.returnUrl : undefined,
      );
      if (!returnUrl) {
        res.status(400).json({ error: "No return URL available" });
        return;
      }
      try {
        const account = await getBillingAccount("user", userId);
        if (
          account &&
          account.planId === "plus" &&
          statusKeepsBenefits(account.status)
        ) {
          res.status(409).json({
            error: "You're already on this plan. Manage it instead.",
            code: "already_subscribed",
          });
          return;
        }
        const metadata = {
          venomScopeType: "user",
          venomScopeId: userId,
          venomPlanId: "plus",
        };
        const session = await stripe.checkout.sessions.create(
          {
            mode: "subscription",
            customer: account?.stripeCustomerId ?? undefined,
            line_items: [
              {
                quantity: 1,
                price_data: {
                  currency: "usd",
                  recurring: { interval: "month" },
                  unit_amount: Math.round(plan.priceUsd * 100),
                  product_data: {
                    name: `Venom ${plan.name}`,
                    description: `Includes $${plan.allowanceUsd} of Venom AI each month`,
                  },
                },
              },
            ],
            allow_promotion_codes: true,
            success_url: `${returnUrl}${returnUrl.includes("?") ? "&" : "?"}billing=success`,
            cancel_url: `${returnUrl}${returnUrl.includes("?") ? "&" : "?"}billing=cancelled`,
            metadata,
            subscription_data: { metadata },
          },
          { idempotencyKey: checkoutIdempotencyKey("user", userId, "plus") },
        );
        if (!session.url) {
          res.status(502).json({ error: "Checkout could not be started" });
          return;
        }
        res.json({ url: session.url });
      } catch (error) {
        req.log.error({ err: error }, "Venom checkout session failed");
        res.status(502).json({ error: "Checkout could not be started" });
      }
    },
  );

  router.post(
    "/venom/billing/portal",
    async (req: Request, res: Response): Promise<void> => {
      const userId = resolveUserId(req);
      if (!userId) {
        res.status(401).json({ error: "Authentication required" });
        return;
      }
      const stripe = getVenomStripe();
      if (!stripe) {
        res.status(503).json(billingNotConfiguredBody());
        return;
      }
      const body = (req.body ?? {}) as { returnUrl?: unknown };
      const returnUrl = resolveReturnUrl(
        typeof body.returnUrl === "string" ? body.returnUrl : undefined,
      );
      try {
        const account = await getBillingAccount("user", userId);
        if (!account?.stripeCustomerId) {
          res.status(409).json({
            error: "There's no subscription to manage yet.",
            code: "not_subscribed",
          });
          return;
        }
        const session = await stripe.billingPortal.sessions.create({
          customer: account.stripeCustomerId,
          return_url: returnUrl ?? undefined,
        });
        res.json({ url: session.url });
      } catch (error) {
        req.log.error({ err: error }, "Venom portal session failed");
        res.status(502).json({ error: "The billing portal is unavailable" });
      }
    },
  );

  // ── Workspace Organization plan ───────────────────────────────────────────

  router.get(
    "/venom/workspaces/:workspaceId/billing",
    async (req: Request, res: Response): Promise<void> => {
      const userId = resolveUserId(req);
      if (!userId) {
        res.status(401).json({ error: "Authentication required" });
        return;
      }
      const params = GetSharedWorkspaceBillingParams.safeParse(req.params);
      if (!params.success) {
        res.status(403).json(workspaceAccessDeniedBody());
        return;
      }
      const workspaceId = params.data.workspaceId;
      const membership = await getMembership(workspaceId, userId);
      if (!membership) {
        res.status(403).json(workspaceAccessDeniedBody());
        return;
      }
      try {
        const account = await getBillingAccount("workspace", workspaceId);
        const covered = workspaceOrgPlanActive(account);
        const plan = venomPlan("org");
        const base = {
          configured: stripeConfigured(),
          enforced: billingEnforcementActive(),
          covered,
          planName: plan.name,
          role: membership.role,
        };
        if (membership.role !== "admin") {
          // Members learn whether the space is covered — never its money.
          res.json(base);
          return;
        }
        const period = billingPeriodFor(account, new Date());
        const spentMicros = covered
          ? await sumBilledMicros({ kind: "workspace", workspaceId }, period)
          : 0;
        const allowanceMicros = planAllowanceMicros(plan);
        res.json({
          ...base,
          plan: planPayload(plan),
          status: account?.status ?? "none",
          cancelAtPeriodEnd: account?.cancelAtPeriodEnd ?? false,
          periodStart: period.start.toISOString(),
          periodEnd: period.end.toISOString(),
          spentUsd: covered ? usd(spentMicros) : 0,
          remainingUsd: covered
            ? usd(Math.max(0, allowanceMicros - spentMicros))
            : plan.allowanceUsd,
          state: covered
            ? allowanceState(spentMicros, allowanceMicros)
            : "ok",
          manageable: Boolean(account?.stripeCustomerId) && stripeConfigured(),
        });
      } catch (error) {
        req.log.error({ err: error }, "Venom workspace billing failed");
        res.status(500).json({ error: "Workspace billing is unavailable" });
      }
    },
  );

  router.post(
    "/venom/workspaces/:workspaceId/billing/checkout",
    async (req: Request, res: Response): Promise<void> => {
      const userId = resolveUserId(req);
      if (!userId) {
        res.status(401).json({ error: "Authentication required" });
        return;
      }
      const params = CreateSharedWorkspaceBillingCheckoutParams.safeParse(
        req.params,
      );
      if (!params.success) {
        res.status(403).json(workspaceAccessDeniedBody());
        return;
      }
      const workspaceId = params.data.workspaceId;
      const membership = await getMembership(workspaceId, userId);
      if (!membership) {
        res.status(403).json(workspaceAccessDeniedBody());
        return;
      }
      if (membership.role !== "admin") {
        res.status(403).json(workspaceAdminRequiredBody());
        return;
      }
      const stripe = getVenomStripe();
      if (!stripe) {
        res.status(503).json(billingNotConfiguredBody());
        return;
      }
      const body = (req.body ?? {}) as { returnUrl?: unknown };
      const returnUrl = resolveReturnUrl(
        typeof body.returnUrl === "string" ? body.returnUrl : undefined,
      );
      if (!returnUrl) {
        res.status(400).json({ error: "No return URL available" });
        return;
      }
      try {
        const account = await getBillingAccount("workspace", workspaceId);
        if (workspaceOrgPlanActive(account)) {
          res.status(409).json({
            error:
              "This workspace is already on the Organization plan. Manage it instead.",
            code: "already_subscribed",
          });
          return;
        }
        const plan = venomPlan("org");
        if (plan.priceUsd <= 0) {
          res.status(400).json({ error: "This plan has no price configured" });
          return;
        }
        const workspaceRows = await db
          .select({ name: venomSharedWorkspacesTable.name })
          .from(venomSharedWorkspacesTable)
          .where(eq(venomSharedWorkspacesTable.id, workspaceId))
          .limit(1);
        const workspaceName = workspaceRows[0]?.name ?? "Shared workspace";
        const metadata = {
          venomScopeType: "workspace",
          venomScopeId: workspaceId,
          venomPlanId: "org",
        };
        const session = await stripe.checkout.sessions.create(
          {
            mode: "subscription",
            customer: account?.stripeCustomerId ?? undefined,
            line_items: [
              {
                quantity: 1,
                price_data: {
                  currency: "usd",
                  recurring: { interval: "month" },
                  unit_amount: Math.round(plan.priceUsd * 100),
                  product_data: {
                    name: `Venom ${plan.name} — ${workspaceName.slice(0, 80)}`,
                    description: `Includes $${plan.allowanceUsd} of Venom AI each month for everyone in the workspace`,
                  },
                },
              },
            ],
            success_url: `${returnUrl}${returnUrl.includes("?") ? "&" : "?"}billing=success`,
            cancel_url: `${returnUrl}${returnUrl.includes("?") ? "&" : "?"}billing=cancelled`,
            metadata,
            subscription_data: { metadata },
          },
          {
            idempotencyKey: checkoutIdempotencyKey(
              "workspace",
              workspaceId,
              "org",
            ),
          },
        );
        if (!session.url) {
          res.status(502).json({ error: "Checkout could not be started" });
          return;
        }
        res.json({ url: session.url });
      } catch (error) {
        req.log.error({ err: error }, "Venom workspace checkout failed");
        res.status(502).json({ error: "Checkout could not be started" });
      }
    },
  );

  router.post(
    "/venom/workspaces/:workspaceId/billing/portal",
    async (req: Request, res: Response): Promise<void> => {
      const userId = resolveUserId(req);
      if (!userId) {
        res.status(401).json({ error: "Authentication required" });
        return;
      }
      const params = CreateSharedWorkspaceBillingPortalParams.safeParse(
        req.params,
      );
      if (!params.success) {
        res.status(403).json(workspaceAccessDeniedBody());
        return;
      }
      const workspaceId = params.data.workspaceId;
      const membership = await getMembership(workspaceId, userId);
      if (!membership) {
        res.status(403).json(workspaceAccessDeniedBody());
        return;
      }
      if (membership.role !== "admin") {
        res.status(403).json(workspaceAdminRequiredBody());
        return;
      }
      const stripe = getVenomStripe();
      if (!stripe) {
        res.status(503).json(billingNotConfiguredBody());
        return;
      }
      const body = (req.body ?? {}) as { returnUrl?: unknown };
      const returnUrl = resolveReturnUrl(
        typeof body.returnUrl === "string" ? body.returnUrl : undefined,
      );
      try {
        const account = await getBillingAccount("workspace", workspaceId);
        if (!account?.stripeCustomerId) {
          res.status(409).json({
            error: "This workspace has no subscription to manage yet.",
            code: "not_subscribed",
          });
          return;
        }
        const session = await stripe.billingPortal.sessions.create({
          customer: account.stripeCustomerId,
          return_url: returnUrl ?? undefined,
        });
        res.json({ url: session.url });
      } catch (error) {
        req.log.error({ err: error }, "Venom workspace portal failed");
        res.status(502).json({ error: "The billing portal is unavailable" });
      }
    },
  );

  return router;
}

/**
 * Stripe webhook: mounted in app.ts BEFORE express.json so the raw bytes
 * survive for signature verification. Unverifiable events are rejected
 * without processing; verified ones update the local mirror idempotently.
 */
export async function handleStripeWebhook(
  req: Request,
  res: Response,
): Promise<void> {
  if (!stripeWebhookConfigured()) {
    res.status(503).json(billingNotConfiguredBody());
    return;
  }
  const signature = req.headers["stripe-signature"];
  if (typeof signature !== "string") {
    res.status(400).json({ error: "Missing Stripe signature" });
    return;
  }
  const raw = req.body;
  if (!Buffer.isBuffer(raw)) {
    res.status(400).json({ error: "Webhook body must be raw bytes" });
    return;
  }
  let event;
  try {
    event = verifyStripeWebhook(raw, signature);
  } catch {
    // Never log payload contents: an unverifiable body is untrusted input.
    res.status(400).json({ error: "Webhook signature verification failed" });
    return;
  }
  try {
    await applyStripeEvent(event);
    res.json({ received: true });
  } catch (error) {
    console.error(
      `[venom-billing] webhook ${event.type} failed to apply`,
      error,
    );
    // 500 asks Stripe to retry — applyStripeEvent is idempotent.
    res.status(500).json({ error: "Webhook processing failed" });
  }
}

const venomBillingRouter: IRouter = createVenomBillingRouter();
export default venomBillingRouter;
