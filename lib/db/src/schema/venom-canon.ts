import {
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

/**
 * Venom's canon: the curated global teaching tier.
 *
 * Canon entries are domain-tagged principles taught by trusted humans in
 * ordinary chat ("store these as core branding principles"). They feed every
 * user's answers as bounded reference data — never as instructions — so the
 * write path is locked behind the super admin role below.
 *
 * This tier is authored downward by named people with full provenance. It is
 * deliberately distinct from the anonymous aggregated master ontology, which
 * folds de-identified signals upward from many tenants.
 */

/**
 * Platform-level super admins, designated server-side by account id.
 *
 * Membership in this table is the single source of truth for the role:
 * every privileged request re-checks these rows, and clients only ever see
 * a derived boolean on their own identity. The role is never granted by
 * matching an email at request time — bootstrap resolves the configured
 * owner email to its auth-provider account once and stores the durable
 * account id here.
 */
export const venomSuperAdminsTable = pgTable("venom_super_admins", {
  clerkUserId: text("clerk_user_id").primaryKey(),
  /** Admin who granted the role; null marks the bootstrap designation. */
  grantedByClerkUserId: text("granted_by_clerk_user_id"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export type VenomSuperAdminRow = typeof venomSuperAdminsTable.$inferSelect;

export const VENOM_CANON_TEACHING_STATUSES = ["active", "retired"] as const;
export type VenomCanonTeachingStatus =
  (typeof VENOM_CANON_TEACHING_STATUSES)[number];

export const venomCanonTeachingsTable = pgTable(
  "venom_canon_teachings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** Normalized lowercase skill domain, e.g. "branding", "songwriting". */
    domain: text("domain").notNull(),
    title: text("title").notNull(),
    /** Distilled principle statements (bounded string array). */
    principles: jsonb("principles").$type<string[]>().notNull(),
    /** Retired entries stay for the audit trail but stop influencing answers. */
    status: text("status")
      .$type<VenomCanonTeachingStatus>()
      .notNull()
      .default("active"),
    /** Provenance: the super admin who taught this entry. */
    taughtByClerkUserId: text("taught_by_clerk_user_id").notNull(),
    /** Chat the teaching came from; ids are client-scoped and advisory. */
    conversationId: text("conversation_id"),
    conversationTitle: text("conversation_title"),
    lastEditedByClerkUserId: text("last_edited_by_clerk_user_id"),
    retiredByClerkUserId: text("retired_by_clerk_user_id"),
    retiredAt: timestamp("retired_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    index("venom_canon_teachings_domain_idx").on(table.domain),
    index("venom_canon_teachings_status_idx").on(table.status),
  ],
);

export type VenomCanonTeachingRow =
  typeof venomCanonTeachingsTable.$inferSelect;
