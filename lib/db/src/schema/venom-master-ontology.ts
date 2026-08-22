import {
  bigint,
  boolean,
  doublePrecision,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
} from "drizzle-orm/pg-core";

/**
 * Venom master ontology: the anonymous, cross-tenant knowledge network.
 *
 * Three groups of tables with a strict data-flow boundary between them:
 *
 * 1. Contribution settings — the explicit per-tenant opt-in. A tenant is a
 *    personal Brain ("user" + clerk user id) or a company Brain ("org" +
 *    org id). Nothing is ever read from a tenant that has not opted in.
 *
 * 2. Signal tables — de-identified, concept-level rows emitted when an
 *    opted-in tenant's ontology is filed. Structurally these carry ONLY a
 *    normalized label, a display label, a category, and label pairs. There
 *    are no columns for summaries, evidence, excerpts, conversation ids,
 *    project ids, or message ids, so identifying content cannot be stored
 *    here even by mistake. The tenant tag exists solely for two purposes:
 *    counting distinct tenants (the anonymity threshold) and revoking a
 *    tenant's rows when it opts out.
 *
 * 3. Aggregate tables — what the product actually reads (master Brain map,
 *    suggestions, extraction vocabulary). Rebuilt from signals; a concept
 *    or link row exists here only once it was seen across the minimum
 *    number of distinct tenants, so rare, potentially identifying concepts
 *    never become visible. No tenant columns at all.
 */

export const VENOM_MASTER_TENANT_TYPE_USER = "user";
export const VENOM_MASTER_TENANT_TYPE_ORG = "org";

export const venomMasterContributionSettingsTable = pgTable(
  "venom_master_contribution_settings",
  {
    tenantType: text("tenant_type").notNull(),
    tenantId: text("tenant_id").notNull(),
    /** Off until a user (or a company admin) explicitly turns it on. */
    enabled: boolean("enabled").notNull().default(false),
    /** Who flipped the switch last (a user id; for org tenants, an admin). */
    updatedByUserId: text("updated_by_user_id").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.tenantType, table.tenantId] })],
);

/**
 * One row per (tenant, concept). Upserted on filing, so re-filing the same
 * concept never inflates the distinct-tenant count.
 */
export const venomMasterConceptSignalsTable = pgTable(
  "venom_master_concept_signals",
  {
    tenantType: text("tenant_type").notNull(),
    tenantId: text("tenant_id").notNull(),
    /** Lower-cased, whitespace-collapsed label; the aggregation key. */
    normalizedLabel: text("normalized_label").notNull(),
    /** Sanitized display label as this tenant spells it (bounded). */
    label: text("label").notNull(),
    /** Sanitized lower-case category as this tenant files it (bounded). */
    category: text("category").notNull(),
    lastSeenAt: bigint("last_seen_at", { mode: "number" }).notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.tenantType, table.tenantId, table.normalizedLabel],
    }),
    index("venom_master_concept_signals_label_idx").on(table.normalizedLabel),
  ],
);

/**
 * One row per (tenant, concept pair). Canonical ordering:
 * normalizedLabelA < normalizedLabelB.
 */
export const venomMasterLinkSignalsTable = pgTable(
  "venom_master_link_signals",
  {
    tenantType: text("tenant_type").notNull(),
    tenantId: text("tenant_id").notNull(),
    normalizedLabelA: text("normalized_label_a").notNull(),
    normalizedLabelB: text("normalized_label_b").notNull(),
    lastSeenAt: bigint("last_seen_at", { mode: "number" }).notNull(),
  },
  (table) => [
    primaryKey({
      columns: [
        table.tenantType,
        table.tenantId,
        table.normalizedLabelA,
        table.normalizedLabelB,
      ],
    }),
    index("venom_master_link_signals_pair_idx").on(
      table.normalizedLabelA,
      table.normalizedLabelB,
    ),
  ],
);

/**
 * Aggregate concepts — only rows seen across at least the minimum number of
 * distinct tenants. Carries no tenant traces; `label`/`category` are the
 * most common spellings across contributing tenants.
 */
export const venomMasterConceptsTable = pgTable("venom_master_concepts", {
  normalizedLabel: text("normalized_label").primaryKey(),
  label: text("label").notNull(),
  category: text("category").notNull(),
  /** Distinct tenants that filed this concept (always >= the threshold). */
  tenantCount: integer("tenant_count").notNull(),
  /** Display prevalence in [0, 1]; derived from tenantCount, never a count. */
  strength: doublePrecision("strength").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

/** Aggregate relationship weights between above-threshold concepts. */
export const venomMasterLinksTable = pgTable(
  "venom_master_links",
  {
    normalizedLabelA: text("normalized_label_a").notNull(),
    normalizedLabelB: text("normalized_label_b").notNull(),
    tenantCount: integer("tenant_count").notNull(),
    strength: doublePrecision("strength").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.normalizedLabelA, table.normalizedLabelB] }),
  ],
);

/** Per-user dismissals of "related in the Venom network" suggestions. */
/**
 * Single-row bookkeeping for the master tier — e.g. which identity-policy
 * version last swept the signal tables. Carries no tenant data.
 */
export const venomMasterMetaTable = pgTable("venom_master_meta", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const venomMasterSuggestionDismissalsTable = pgTable(
  "venom_master_suggestion_dismissals",
  {
    userId: text("user_id").notNull(),
    normalizedLabel: text("normalized_label").notNull(),
    dismissedAt: timestamp("dismissed_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.userId, table.normalizedLabel] })],
);

export type VenomMasterContributionSettingRow =
  typeof venomMasterContributionSettingsTable.$inferSelect;
export type VenomMasterConceptSignalRow =
  typeof venomMasterConceptSignalsTable.$inferSelect;
export type VenomMasterLinkSignalRow =
  typeof venomMasterLinkSignalsTable.$inferSelect;
export type VenomMasterConceptRow =
  typeof venomMasterConceptsTable.$inferSelect;
export type VenomMasterLinkRow = typeof venomMasterLinksTable.$inferSelect;
export type VenomMasterSuggestionDismissalRow =
  typeof venomMasterSuggestionDismissalsTable.$inferSelect;
