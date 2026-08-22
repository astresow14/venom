import {
  boolean,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

/**
 * Venom subscription billing accounts: one row per payer.
 *
 * A payer is either a person (`scopeType "user"`, scopeId = Clerk user id)
 * or a shared workspace on the Organization plan (`scopeType "workspace"`,
 * scopeId = workspace uuid). Billing follows the space a conversation lives
 * in — never its content — so these two scope types are the only payers that
 * can ever exist.
 *
 * Rows are created lazily (first billing read or first checkout) and mirror
 * Stripe subscription state via signature-verified webhooks. A missing row
 * simply means the payer is on the built-in free tier. Stripe identifiers
 * live here so portal/checkout sessions can be reattached to the same
 * customer; secret keys never touch the database.
 */
export const venomBillingAccountsTable = pgTable(
  "venom_billing_accounts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** "user" | "workspace" — the only two payers billing can attach to. */
    scopeType: text("scope_type").notNull(),
    /** Clerk user id or shared-workspace uuid, depending on scopeType. */
    scopeId: text("scope_id").notNull(),
    /** Plan id from the server-side plan config (free | plus | org). */
    planId: text("plan_id").notNull().default("free"),
    /**
     * Stripe subscription status mirror: none | active | trialing |
     * past_due | canceled | unpaid | incomplete | incomplete_expired.
     * "none" means no Stripe subscription has ever existed for this payer.
     */
    status: text("status").notNull().default("none"),
    stripeCustomerId: text("stripe_customer_id"),
    stripeSubscriptionId: text("stripe_subscription_id"),
    /** Current paid period, mirrored from Stripe; null on the free tier. */
    currentPeriodStart: timestamp("current_period_start", {
      withTimezone: true,
    }),
    currentPeriodEnd: timestamp("current_period_end", { withTimezone: true }),
    cancelAtPeriodEnd: boolean("cancel_at_period_end").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    uniqueIndex("venom_billing_accounts_scope_idx").on(
      table.scopeType,
      table.scopeId,
    ),
    // Webhooks look accounts up by the Stripe ids they carry.
    index("venom_billing_accounts_customer_idx").on(table.stripeCustomerId),
    index("venom_billing_accounts_subscription_idx").on(
      table.stripeSubscriptionId,
    ),
  ],
);

export type VenomBillingAccountRow =
  typeof venomBillingAccountsTable.$inferSelect;
export type NewVenomBillingAccountRow =
  typeof venomBillingAccountsTable.$inferInsert;

/**
 * In-flight allowance reservations: the pending half of the hard-limit
 * bookkeeping. Admitting a paid AI request inserts a row for the request's
 * priced worst case inside a payer-locked transaction; the first durable
 * usage insert (or the request's own release hook) deletes it. Rows live in
 * the database — not process memory — so restarts and parallel server
 * instances all see the same pending spend. Rows leaked by a crash are
 * reaped during admission once they age out.
 */
export const venomAllowanceReservationsTable = pgTable(
  "venom_allowance_reservations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** "user" | "workspace" — same payer vocabulary as billing accounts. */
    scopeType: text("scope_type").notNull(),
    scopeId: text("scope_id").notNull(),
    /** Priced worst case of the admitted request, micro-dollars. */
    reservedMicros: integer("reserved_micros").notNull(),
    /**
     * When a workspace pays, the member whose admitted request holds this
     * reservation. Lets per-member cap admission count that member's own
     * open holds under the same payer lock, so two parallel requests can't
     * slip past a member cap together. Null for personal-payer holds and
     * rows that predate member caps.
     */
    reservedForClerkUserId: text("reserved_for_clerk_user_id"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    // Admission sums one payer's open reservations and reaps stale ones.
    index("venom_allowance_reservations_scope_idx").on(
      table.scopeType,
      table.scopeId,
      table.createdAt,
    ),
  ],
);

export type VenomAllowanceReservationRow =
  typeof venomAllowanceReservationsTable.$inferSelect;
