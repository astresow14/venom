import {
  bigint,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

/**
 * Template learning: per-template, de-identified edit signals and the
 * aggregate guidance rebuilt from them.
 *
 * This is an extension of the master ontology's anonymous cross-tenant tier
 * and inherits its exact rules: nothing is written for a tenant that has not
 * explicitly opted in to master contribution, signal rows exist only so
 * distinct tenants can be counted and revoked, and the aggregate table the
 * product reads carries no tenant traces at all.
 *
 * The signal rows are structurally incapable of carrying user text: the only
 * content column is `signalKey`, which must be one of the compiled-in
 * closed-vocabulary keys (e.g. "scope_trimmed", "theme_visual_design").
 * There are no columns for requirements, instructions, package excerpts,
 * run ids, revision ids, or app ids, so raw edit text and identifying
 * references cannot be stored here even by mistake. Reads additionally map
 * keys through the compiled vocabulary, so a row whose key is not in the
 * vocabulary can never surface anywhere.
 */

/**
 * One row per (tenant, template, signal key): "this tenant's edits to
 * packages derived from this template exhibited this concept-level pattern
 * at least once". Deliberately not an event log — repeat occurrences only
 * refresh `lastSeenAt`, so the table cannot grow with usage volume and a
 * single loud tenant counts once toward the anonymity threshold.
 */
export const venomTemplateEditSignalsTable = pgTable(
  "venom_template_edit_signals",
  {
    tenantType: text("tenant_type").notNull(),
    tenantId: text("tenant_id").notNull(),
    /**
     * Lineage pin to the global template catalog (no FK: templates are
     * never hard-deleted, and signals must not block catalog maintenance).
     */
    templateId: uuid("template_id").notNull(),
    /** Closed-vocabulary concept key; never free text. */
    signalKey: text("signal_key").notNull(),
    lastSeenAt: bigint("last_seen_at", { mode: "number" }).notNull(),
  },
  (table) => [
    primaryKey({
      columns: [
        table.tenantType,
        table.tenantId,
        table.templateId,
        table.signalKey,
      ],
    }),
    index("venom_template_edit_signals_template_idx").on(
      table.templateId,
      table.signalKey,
    ),
  ],
);

/**
 * Aggregate per-template guidance — only signal keys seen across at least
 * the master minimum number of distinct tenants. Rebuilt wholesale from the
 * signal table by the master aggregate rebuild; no tenant columns.
 */
export const venomTemplateGuidanceTable = pgTable(
  "venom_template_guidance",
  {
    templateId: uuid("template_id").notNull(),
    signalKey: text("signal_key").notNull(),
    /** Distinct tenants that filed this signal (always >= the threshold). */
    tenantCount: integer("tenant_count").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.templateId, table.signalKey] })],
);

export type VenomTemplateEditSignalRow =
  typeof venomTemplateEditSignalsTable.$inferSelect;
export type VenomTemplateGuidanceRow =
  typeof venomTemplateGuidanceTable.$inferSelect;
