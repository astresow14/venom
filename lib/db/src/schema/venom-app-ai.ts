import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import { venomPortfolioAppsTable } from "./venom-app-portfolio";

/**
 * Whitelabeled AI for provisioned apps.
 *
 * Each portfolio app can hold at most one *active* gateway credential. The
 * credential's plaintext exists only transiently in server memory during
 * minting and provider delivery — this table stores a SHA-256 hash plus a
 * short display prefix for owner UIs. A leaked credential authenticates only
 * the Venom AI gateway for its one app; it grants nothing else.
 *
 * `venom_ai_ledger_entries` is the canonical usage ledger: one row per
 * gateway AI call with owner, app, alias, token counts, and precomputed cost
 * basis in micro-dollars. It is deliberately shaped so future billing work
 * (subscription plans, allowances) can price directly on top of it, and so
 * the in-product chat paths can migrate onto it later (appId/credentialId
 * are nullable for that reason). Message content never lands here.
 */

export const venomAppAiCredentialsTable = pgTable(
  "venom_app_ai_credentials",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    appId: uuid("app_id")
      .notNull()
      .references(() => venomPortfolioAppsTable.id, { onDelete: "cascade" }),
    /** Owner the credential's spend is metered against. */
    clerkUserId: text("clerk_user_id").notNull(),
    /** SHA-256 hex of the full token. The plaintext is never stored. */
    tokenHash: text("token_hash").notNull(),
    /** First characters of the token (vak_ + 8) for owner-facing display. */
    displayPrefix: text("display_prefix").notNull(),
    status: text("status", { enum: ["active", "revoked"] })
      .notNull()
      .default("active"),
    /**
     * When the plaintext reached the provisioned app's secret storage via
     * the provider boundary. Null = minted but not yet delivered (delivery
     * happens at the next provisioning handoff).
     */
    deliveredAt: timestamp("delivered_at", { withTimezone: true }),
    /** Provider project the secret was delivered to. Not itself a secret. */
    deliveredProviderProjectId: text("delivered_provider_project_id"),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    uniqueIndex("venom_app_ai_credentials_token_hash_idx").on(table.tokenHash),
    // DB backstop for the one-active-credential invariant. Minting also
    // serializes per app with an advisory lock; this index makes a racing
    // second insert fail instead of leaving two live tokens.
    uniqueIndex("venom_app_ai_credentials_one_active_idx")
      .on(table.appId)
      .where(sql`${table.status} = 'active'`),
    index("venom_app_ai_credentials_app_idx").on(table.appId, table.status),
    index("venom_app_ai_credentials_owner_idx").on(table.clerkUserId),
  ],
);

/**
 * In-flight spend reservations for the AI gateway's cap gate.
 *
 * A row exists only while a gateway call is running: the gate inserts it
 * (inside the same locked transaction that checks the caps) before the
 * provider is dispatched, and settlement deletes it in the transaction that
 * writes the ledger row. Summing settled ledger cost + open reservations
 * makes the cap check concurrency-safe — parallel calls cannot all pass the
 * same below-cap read. Rows older than the reaper threshold are treated as
 * leaked (crashed process, failed settlement) and reaped by the next gate.
 */
export const venomAppAiReservationsTable = pgTable(
  "venom_app_ai_reservations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    appId: uuid("app_id")
      .notNull()
      .references(() => venomPortfolioAppsTable.id, { onDelete: "cascade" }),
    clerkUserId: text("clerk_user_id").notNull(),
    /** Reserved headroom in micro-dollars while the call is in flight. */
    amountMicros: integer("amount_micros").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("venom_app_ai_reservations_app_idx").on(table.appId, table.createdAt),
  ],
);

export const venomAppAiSettingsTable = pgTable(
  "venom_app_ai_settings",
  {
    appId: uuid("app_id")
      .primaryKey()
      .references(() => venomPortfolioAppsTable.id, { onDelete: "cascade" }),
    clerkUserId: text("clerk_user_id").notNull(),
    /**
     * Owner-set monthly spend cap in micro-dollars. Null = no owner cap; the
     * global safety cap still applies server-side.
     */
    monthlyCapMicros: bigint("monthly_cap_micros", { mode: "number" }),
    /** Instant kill switch: paused apps get a distinct machine-readable error. */
    paused: boolean("paused").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [index("venom_app_ai_settings_owner_idx").on(table.clerkUserId)],
);

export const venomAiLedgerEntriesTable = pgTable(
  "venom_ai_ledger_entries",
  {
    id: text("id").primaryKey(),
    /** Clerk user id of the account the call is metered against. */
    clerkUserId: text("clerk_user_id").notNull(),
    /** App whose gateway credential made the call. Null once non-app paths migrate on. */
    appId: uuid("app_id"),
    /** Credential that authenticated the call, for audit; null for non-gateway rows. */
    credentialId: uuid("credential_id"),
    occurredAt: timestamp("occurred_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    /** Which AI path made the call. Gateway chat is "chat_completion". */
    callKind: text("call_kind").notNull(),
    /** Venom-branded model alias (venom-gpt, …) — never a provider SKU. */
    modelAlias: text("model_alias").notNull(),
    promptTokens: integer("prompt_tokens").notNull(),
    outputTokens: integer("output_tokens").notNull(),
    /** True when token counts are estimates, not provider-reported. */
    estimated: boolean("estimated").notNull().default(false),
    /** Cost basis in micro-dollars (1e-6 USD); integer math avoids float drift. */
    costMicros: integer("cost_micros").notNull(),
  },
  (table) => [
    // Cap enforcement + the app detail usage panel read one app's month.
    index("venom_ai_ledger_app_time_idx").on(table.appId, table.occurredAt),
    // Owner totals aggregate a month across all of one owner's apps.
    index("venom_ai_ledger_owner_time_idx").on(
      table.clerkUserId,
      table.occurredAt,
    ),
  ],
);

export type VenomAppAiCredential =
  typeof venomAppAiCredentialsTable.$inferSelect;
export type NewVenomAppAiCredential =
  typeof venomAppAiCredentialsTable.$inferInsert;
export type VenomAppAiSettings = typeof venomAppAiSettingsTable.$inferSelect;
export type NewVenomAppAiSettings =
  typeof venomAppAiSettingsTable.$inferInsert;
export type VenomAppAiReservation =
  typeof venomAppAiReservationsTable.$inferSelect;
export type VenomAiLedgerEntry = typeof venomAiLedgerEntriesTable.$inferSelect;
export type NewVenomAiLedgerEntry =
  typeof venomAiLedgerEntriesTable.$inferInsert;
