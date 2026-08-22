import {
  check,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

// ---------------------------------------------------------------------------
// Scheduled source sync alerts
// ---------------------------------------------------------------------------
//
// One row per (user, source) tracks the streak of consecutive *server-side*
// scheduled sync failures for that source. Once the streak crosses the alert
// threshold the row is "triggered" and surfaces through the notification
// bell, so a user who relies on unattended daily syncs hears about a lapsed
// GitHub connection without opening the source card in Settings.
//
// These are deliberately not community notifications: that table is scoped to
// community profiles (NOT NULL thread/reply references, type CHECK), while a
// sync alert must reach users who never touched the community. Rows are
// deleted outright when a sync succeeds again or the source/schedule goes
// away — `readAt` only silences the badge, it never hides the alert while the
// failure persists.

export const venomSourceSyncAlertsTable = pgTable(
  "venom_source_sync_alerts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** Owner of the workspace whose scheduled source keeps failing. */
    clerkUserId: text("clerk_user_id").notNull(),
    /** Deterministic source id as stored in the workspace blob. */
    sourceId: text("source_id").notNull(),
    projectId: text("project_id").notNull(),
    provider: text("provider").notNull(),
    /** Display name snapshot so the nudge can name the source. */
    sourceName: text("source_name").notNull(),
    consecutiveFailures: integer("consecutive_failures").notNull().default(1),
    /** The card-worthy message of the most recent failed attempt. */
    lastError: text("last_error").notNull(),
    firstFailedAt: timestamp("first_failed_at", {
      withTimezone: true,
    }).notNull(),
    lastFailedAt: timestamp("last_failed_at", { withTimezone: true }).notNull(),
    /** Set when the streak crosses the alert threshold; null = not surfaced. */
    triggeredAt: timestamp("triggered_at", { withTimezone: true }),
    /** Badge silencing only — the alert stays listed until a sync succeeds. */
    readAt: timestamp("read_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    uniqueIndex("venom_source_sync_alerts_user_source_idx").on(
      table.clerkUserId,
      table.sourceId,
    ),
    index("venom_source_sync_alerts_user_triggered_idx").on(
      table.clerkUserId,
      table.triggeredAt,
    ),
    check(
      "venom_source_sync_alerts_provider_check",
      sql`${table.provider} IN ('github', 'website')`,
    ),
  ],
);

export type VenomSourceSyncAlert =
  typeof venomSourceSyncAlertsTable.$inferSelect;
