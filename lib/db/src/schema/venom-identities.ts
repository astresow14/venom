import { pgTable, text, timestamp } from "drizzle-orm/pg-core";

/**
 * Per-user identity records: who Venom recognizes each authenticated
 * account as, resolved from the auth provider (Clerk) on first
 * authenticated use and refreshed when stale.
 *
 * The display name and email are personal data:
 * - bounded before writing (VENOM_IDENTITY_BOUNDS in the api-server lib);
 * - never written to logs;
 * - removed when the auth provider reports the user gone (a refresh that
 *   finds the Clerk user deleted deletes this row, and a boot + periodic
 *   retention sweep re-verifies rows unrefreshed for 30 days so a deleted
 *   account's data cannot linger just because nobody resolved it again).
 *
 * Knowledge evidence stores only the opaque `capturedByUserId`; joining it
 * to a person happens through this table at read time, so deleting a row
 * here removes the personal data everywhere it could surface.
 */
export const venomIdentitiesTable = pgTable("venom_identities", {
  clerkUserId: text("clerk_user_id").primaryKey(),
  /** "First Last" from the auth account; null when the account has none. */
  displayName: text("display_name"),
  /** Primary email of the auth account; null when unavailable. */
  email: text("email"),
  /** Sign-in provider slug, e.g. "google" or "password". */
  provider: text("provider"),
  /** Last successful resolve from the auth provider; drives staleness. */
  refreshedAt: timestamp("refreshed_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export type VenomIdentityRow = typeof venomIdentitiesTable.$inferSelect;
