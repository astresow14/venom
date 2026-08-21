import {
  bigint,
  boolean,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
} from "drizzle-orm/pg-core";

/**
 * Venom ontology: the server-side knowledge database.
 *
 * Every row is keyed by an owner scope so the same tables can serve
 * individual users today ("user" + clerk user id) and organizations later
 * ("org" + org id) without a second storage system.
 *
 * The rows mirror the client knowledge model exactly (concept clusters with
 * bounded evidence lists, bidirectional same-project links, deletion
 * tombstones) so the store can round-trip through the existing workspace
 * sync without changing what devices see.
 */

export const VENOM_ONTOLOGY_OWNER_TYPE_USER = "user";

/**
 * Owner type for shared (multi-user) workspaces. Rows under this scope are
 * workspace-tier knowledge: they are served only through membership-checked
 * APIs and must never be embedded in a per-user sync snapshot.
 */
export const VENOM_ONTOLOGY_OWNER_TYPE_WORKSPACE = "workspace";
export const venomOntologyConceptsTable = pgTable(
  "venom_ontology_concepts",
  {
    ownerType: text("owner_type").notNull().default(VENOM_ONTOLOGY_OWNER_TYPE_USER),
    ownerId: text("owner_id").notNull(),
    conceptId: text("concept_id").notNull(),
    /** Null means the concept was captured outside any project. */
    projectId: text("project_id"),
    label: text("label").notNull(),
    /** Lower-cased, whitespace-collapsed label used for merge matching. */
    normalizedLabel: text("normalized_label").notNull(),
    category: text("category").notNull(),
    summary: text("summary").notNull(),
    description: text("description"),
    strength: doublePrecision("strength").notNull(),
    mentionCount: integer("mention_count").notNull(),
    x: doublePrecision("x").notNull(),
    y: doublePrecision("y").notNull(),
    /** Client-visible knowledge timestamp (ms since epoch), drives merges. */
    lastUpdatedAt: bigint("last_updated_at", { mode: "number" }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    primaryKey({
      columns: [table.ownerType, table.ownerId, table.conceptId],
    }),
    index("venom_ontology_concepts_owner_project_idx").on(
      table.ownerType,
      table.ownerId,
      table.projectId,
    ),
    index("venom_ontology_concepts_owner_label_idx").on(
      table.ownerType,
      table.ownerId,
      table.normalizedLabel,
    ),
  ],
);

export const venomOntologyLinksTable = pgTable(
  "venom_ontology_links",
  {
    ownerType: text("owner_type").notNull().default(VENOM_ONTOLOGY_OWNER_TYPE_USER),
    ownerId: text("owner_id").notNull(),
    /** Canonical pair ordering: conceptAId < conceptBId. */
    conceptAId: text("concept_a_id").notNull(),
    conceptBId: text("concept_b_id").notNull(),
    projectId: text("project_id"),
    updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
  },
  (table) => [
    primaryKey({
      columns: [
        table.ownerType,
        table.ownerId,
        table.conceptAId,
        table.conceptBId,
      ],
    }),
    index("venom_ontology_links_owner_b_idx").on(
      table.ownerType,
      table.ownerId,
      table.conceptBId,
    ),
  ],
);

export const venomOntologyEvidenceTable = pgTable(
  "venom_ontology_evidence",
  {
    ownerType: text("owner_type").notNull().default(VENOM_ONTOLOGY_OWNER_TYPE_USER),
    ownerId: text("owner_id").notNull(),
    conceptId: text("concept_id").notNull(),
    conversationId: text("conversation_id").notNull(),
    projectId: text("project_id"),
    conversationTitle: text("conversation_title").notNull(),
    /** string[] of cited message ids, bounded to 12 by the write path. */
    messageIds: jsonb("message_ids").notNull(),
    excerpt: text("excerpt").notNull(),
    updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
    /**
     * Clerk user id of the account that initiated the capture which produced
     * this evidence. Null for evidence from before attribution existed (and
     * for client-side filings); readers attribute those to the ontology
     * owner. Deliberately distinct from the owner columns so the future
     * shared-workspace tier can keep facts tied to their original speaker.
     */
    capturedByUserId: text("captured_by_user_id"),
    /** When that capture was filed (ms since epoch); null pre-attribution. */
    capturedAt: bigint("captured_at", { mode: "number" }),
  },
  (table) => [
    primaryKey({
      columns: [
        table.ownerType,
        table.ownerId,
        table.conceptId,
        table.conversationId,
      ],
    }),
    index("venom_ontology_evidence_owner_conversation_idx").on(
      table.ownerType,
      table.ownerId,
      table.conversationId,
    ),
  ],
);

export const venomOntologyTombstonesTable = pgTable(
  "venom_ontology_tombstones",
  {
    ownerType: text("owner_type").notNull().default(VENOM_ONTOLOGY_OWNER_TYPE_USER),
    ownerId: text("owner_id").notNull(),
    conceptId: text("concept_id").notNull(),
    deletedAt: bigint("deleted_at", { mode: "number" }).notNull(),
    /**
     * A replacement retirement (e.g. cluster merge) is permanent; a plain
     * deletion may lose to a strictly newer incoming concept timestamp.
     */
    replaced: boolean("replaced").notNull().default(false),
  },
  (table) => [
    primaryKey({
      columns: [table.ownerType, table.ownerId, table.conceptId],
    }),
  ],
);

/**
 * One row per owner whose workspace-snapshot knowledge has been imported
 * into the ontology store. Its presence is the migration marker: an owner
 * with a row never re-imports from the blob, even when the store is empty.
 */
export const venomOntologyOwnersTable = pgTable(
  "venom_ontology_owners",
  {
    ownerType: text("owner_type").notNull().default(VENOM_ONTOLOGY_OWNER_TYPE_USER),
    ownerId: text("owner_id").notNull(),
    migratedAt: timestamp("migrated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    importedConceptCount: integer("imported_concept_count")
      .notNull()
      .default(0),
  },
  (table) => [
    primaryKey({ columns: [table.ownerType, table.ownerId] }),
  ],
);

export type VenomOntologyConceptRow =
  typeof venomOntologyConceptsTable.$inferSelect;
export type VenomOntologyLinkRow = typeof venomOntologyLinksTable.$inferSelect;
export type VenomOntologyEvidenceRow =
  typeof venomOntologyEvidenceTable.$inferSelect;
export type VenomOntologyTombstoneRow =
  typeof venomOntologyTombstonesTable.$inferSelect;
export type VenomOntologyOwnerRow =
  typeof venomOntologyOwnersTable.$inferSelect;
