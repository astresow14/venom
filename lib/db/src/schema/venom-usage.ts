import {
  boolean,
  index,
  integer,
  pgTable,
  text,
  timestamp,
} from "drizzle-orm/pg-core";

/**
 * Venom AI usage ledger: one row per completed AI call, attributed to the
 * signed-in account that asked.
 *
 * Token counts come from provider usage metadata when the provider reported
 * it; otherwise a character-based estimate is stored with `estimated` set so
 * every downstream view can say so. Costs are precomputed server-side in
 * micro-dollars (1e-6 USD) from the server-private per-model pricing table —
 * clients only ever see aggregated dollar amounts and Venom-branded aliases,
 * never provider SKUs or per-token rates.
 *
 * Message content never lands here: the ledger stores counts, kinds, and
 * money only. This table is the foundation the subscription-plans and
 * admin-controls work builds on.
 */
export const venomUsageEvents = pgTable(
  "venom_usage_events",
  {
    id: text("id").primaryKey(),
    /** Clerk user id of the account the call is metered against. */
    userId: text("user_id").notNull(),
    occurredAt: timestamp("occurred_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    /** Venom-branded model alias (venom-gpt, …) or venom-voice for audio. */
    modelAlias: text("model_alias").notNull(),
    /** Which AI path made the call: chat | verify_voice | debate_turn | … */
    callKind: text("call_kind").notNull(),
    promptTokens: integer("prompt_tokens").notNull(),
    outputTokens: integer("output_tokens").notNull(),
    /** Cost in micro-dollars (1e-6 USD); integer math avoids float drift. */
    costMicros: integer("cost_micros").notNull(),
    /** True when token counts are estimates, not provider-reported. */
    estimated: boolean("estimated").notNull().default(false),
    /** Shared-workspace context the call ran under, when there was one. */
    workspaceId: text("workspace_id"),
  },
  (table) => [
    // The Usage view reads one account's current month; this composite
    // index keeps that scan tight for a month of history.
    index("venom_usage_events_user_time_idx").on(
      table.userId,
      table.occurredAt,
    ),
  ],
);

export type VenomUsageEventRow = typeof venomUsageEvents.$inferSelect;
export type NewVenomUsageEventRow = typeof venomUsageEvents.$inferInsert;
