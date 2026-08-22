/**
 * Stripe access for Venom billing.
 *
 * Keys live only in Replit secrets (STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET)
 * and are read lazily — with no keys configured every billing surface
 * reports a graceful "not set up" state and the rest of Venom keeps working.
 *
 * The rest of the server talks to Stripe through the narrow
 * `VenomStripeClient` surface below so tests can inject a fake without
 * network access, and webhook verification goes through a seam for the same
 * reason. Production always verifies signatures with the real SDK.
 */

import Stripe from "stripe";

/** The only Stripe operations Venom uses; fakes implement exactly this. */
export type VenomStripeClient = {
  checkout: {
    sessions: {
      create: (
        params: Stripe.Checkout.SessionCreateParams,
        options?: Stripe.RequestOptions,
      ) => Promise<{ id: string; url: string | null }>;
    };
  };
  billingPortal: {
    sessions: {
      create: (
        params: Stripe.BillingPortal.SessionCreateParams,
      ) => Promise<{ url: string }>;
    };
  };
  subscriptions: {
    retrieve: (id: string) => Promise<Stripe.Subscription>;
  };
};

let realClient: Stripe | null = null;
let clientOverride: VenomStripeClient | null = null;
let configuredOverride: boolean | null = null;

/** Test seam: replace the Stripe client (and force "configured" on). */
export function overrideVenomStripeForTests(
  client: VenomStripeClient | null,
): void {
  clientOverride = client;
  configuredOverride = client === null ? null : true;
  if (client === null) realClient = null;
}

/** Whether billing is set up at all (checkout/portal can be offered). */
export function stripeConfigured(): boolean {
  if (configuredOverride !== null) return configuredOverride;
  return Boolean(process.env.STRIPE_SECRET_KEY);
}

/** Whether webhooks can be verified; without this, events are rejected. */
export function stripeWebhookConfigured(): boolean {
  return webhookVerifierOverride !== null
    ? true
    : Boolean(
        process.env.STRIPE_SECRET_KEY && process.env.STRIPE_WEBHOOK_SECRET,
      );
}

export function getVenomStripe(): VenomStripeClient | null {
  if (clientOverride) return clientOverride;
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) return null;
  if (!realClient) {
    realClient = new Stripe(key);
  }
  return realClient;
}

export type StripeWebhookVerifier = (
  rawBody: Buffer,
  signature: string,
) => Stripe.Event;

let webhookVerifierOverride: StripeWebhookVerifier | null = null;

/** Test seam: bypass real signature math while keeping the verify call. */
export function overrideStripeWebhookVerifierForTests(
  verifier: StripeWebhookVerifier | null,
): void {
  webhookVerifierOverride = verifier;
}

/**
 * Verify and parse a webhook payload. Throws on any signature problem —
 * callers translate that into a 400 without processing the event.
 */
export function verifyStripeWebhook(
  rawBody: Buffer,
  signature: string,
): Stripe.Event {
  if (webhookVerifierOverride) return webhookVerifierOverride(rawBody, signature);
  const key = process.env.STRIPE_SECRET_KEY;
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!key || !secret) {
    throw new Error("Stripe webhook secret is not configured");
  }
  if (!realClient) realClient = new Stripe(key);
  return realClient.webhooks.constructEvent(rawBody, signature, secret);
}
