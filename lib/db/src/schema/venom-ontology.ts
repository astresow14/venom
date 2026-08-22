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

export const VENOM_ONTOLOGY_OWNER_TYPE_ORG = "org";
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
    /**
     * Sensitivity lock. Meaningful on workspace-tier rows: locked items are
     * excluded from exports when the workspace's export policy says so.
     * Enforced server-side; client snapshots can never set or clear it.
     */
    sensitive: boolean("sensitive").notNull().default(false),
    /**
     * Admin-only restriction. Meaningful on workspace-tier rows: restricted
     * concepts (the whole cluster, evidence included) are visible only to
     * workspace admins — filtered out of member reads, member chat context,
     * member citations, and member exports on the server. Only admins may
     * set or clear it; client snapshots can never carry it.
     */
    adminOnly: boolean("admin_only").notNull().default(false),
    /**
     * Author-private "Unsorted" holding state. Meaningful only on personal
     * ("user") rows: extraction files a concept here when the scope
     * classifier is not confident whether it is personal or workspace
     * material. Unsorted concepts sync to the author's own devices like any
     * personal concept, but they are never written to workspace-tier rows —
     * every workspace/org write path strips the flag. Unlike sensitivity, it
     * is a normal synced field: the author's devices may clear it ("keep
     * personal") through the ordinary snapshot merge.
     */
    unsorted: boolean("unsorted").notNull().default(false),
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
    /**
     * Sensitivity lock for a single evidence entry. Same contract as the
     * concept-level flag: server-enforced, export-time only.
     */
    sensitive: boolean("sensitive").notNull().default(false),
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

/**
 * Knowledge move ledger: one row per automatic filing/move notice, pending
 * personal→workspace suggestion, or completed re-file. Rows are author-scoped
 * (userId) — they exist so the author can see where their knowledge went and
 * reverse it with one tap. The payload column carries the snapshots undo
 * needs; it never leaves the server except through the author's own
 * move-notice endpoints.
 */
export const venomKnowledgeMovesTable = pgTable(
  "venom_knowledge_moves",
  {
    id: text("id").primaryKey(),
    /** Author the notice/suggestion belongs to (and the only one who sees it). */
    userId: text("user_id").notNull(),
    /**
     * auto_file  — extraction filed straight into a workspace (undoable);
     * refile     — an automatic move between stores after new knowledge
     *              clarified an item (undoable);
     * suggestion — a proposed personal→workspace move awaiting the author's
     *              explicit accept (accepting widens visibility).
     */
    kind: text("kind").notNull(),
    /**
     * active | undone | expired (notices); pending | accepted | dismissed
     * (suggestions). `expired` is terminal: the undo window closed or the
     * written records changed since, so undo is no longer offered.
     */
    status: text("status").notNull(),
    fromOwnerType: text("from_owner_type").notNull(),
    fromOwnerId: text("from_owner_id").notNull(),
    toOwnerType: text("to_owner_type").notNull(),
    toOwnerId: text("to_owner_id").notNull(),
    /** The shared workspace involved (either side), for display + recheck. */
    workspaceId: text("workspace_id"),
    workspaceName: text("workspace_name"),
    /** Display labels of the concepts this row covers. string[] JSON. */
    labels: jsonb("labels").notNull(),
    /** Kind-specific snapshots for undo/accept; see venom-knowledge-moves.ts. */
    payload: jsonb("payload").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
  },
  (table) => [
    index("venom_knowledge_moves_user_status_idx").on(
      table.userId,
      table.status,
      table.createdAt,
    ),
  ],
);

export type VenomKnowledgeMoveRow =
  typeof venomKnowledgeMovesTable.$inferSelect;

export type VenomOntologyConceptRow =
  typeof venomOntologyConceptsTable.$inferSelect;
export type VenomOntologyLinkRow = typeof venomOntologyLinksTable.$inferSelect;
export type VenomOntologyEvidenceRow =
  typeof venomOntologyEvidenceTable.$inferSelect;
export type VenomOntologyTombstoneRow =
  typeof venomOntologyTombstonesTable.$inferSelect;
export type VenomOntologyOwnerRow =
  typeof venomOntologyOwnersTable.$inferSelect;
