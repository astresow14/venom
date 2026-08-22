import {
  bigint,
  index,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

/**
 * Venom company workspaces (organizations).
 *
 * Identity stays on the auth provider: every user id in these tables is a
 * Clerk user id and invite emails are matched against Clerk-verified email
 * addresses. The managed Clerk instance cannot enable its native
 * organizations feature (403 organization_not_enabled_in_instance), so the
 * org/membership records live here, shaped to mirror Clerk's organization
 * semantics (admin/member roles, email invitations) so a later swap to
 * Clerk-native orgs is a directory change, not a schema rewrite.
 *
 * The shared ontology itself does NOT live here — it lives in the
 * venom_ontology_* tables under owner scope ("org", org id).
 */

export const VENOM_ORG_ROLE_ADMIN = "admin";
export const VENOM_ORG_ROLE_MEMBER = "member";

export const venomOrgsTable = pgTable("venom_orgs", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  createdByUserId: text("created_by_user_id").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const venomOrgMembersTable = pgTable(
  "venom_org_members",
  {
    orgId: text("org_id").notNull(),
    userId: text("user_id").notNull(),
    /** "admin" | "member" */
    role: text("role").notNull().default(VENOM_ORG_ROLE_MEMBER),
    /** Display-name snapshot taken when the membership was created. */
    name: text("name").notNull(),
    email: text("email"),
    addedByUserId: text("added_by_user_id"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.orgId, table.userId] }),
    index("venom_org_members_user_idx").on(table.userId),
  ],
);

export const venomOrgInvitesTable = pgTable(
  "venom_org_invites",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id").notNull(),
    /** Lower-cased invited email; matched against Clerk-verified emails. */
    email: text("email").notNull(),
    role: text("role").notNull().default(VENOM_ORG_ROLE_MEMBER),
    invitedByUserId: text("invited_by_user_id").notNull(),
    invitedByName: text("invited_by_name").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("venom_org_invites_org_email_idx").on(table.orgId, table.email),
    index("venom_org_invites_email_idx").on(table.email),
  ],
);

/**
 * Registry of projects an admin marked company-shared. The project itself
 * still lives in each member's workspace snapshot; this row is what routes
 * knowledge extraction from the project's chats into the org ontology and
 * lets other members mirror the project locally. A project can belong to at
 * most one company, so the project id is the primary key.
 */
export const venomOrgSharedProjectsTable = pgTable(
  "venom_org_shared_projects",
  {
    projectId: text("project_id").primaryKey(),
    orgId: text("org_id").notNull(),
    name: text("name").notNull(),
    description: text("description").notNull().default(""),
    accent: text("accent").notNull().default(""),
    sharedByUserId: text("shared_by_user_id").notNull(),
    sharedByName: text("shared_by_name").notNull(),
    /** Epoch ms; mirrors the client-visible timestamp convention. */
    sharedAt: bigint("shared_at", { mode: "number" }).notNull(),
    updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
  },
  (table) => [index("venom_org_shared_projects_org_idx").on(table.orgId)],
);

/**
 * Company-level knowledge sources connected by admins. The fetched snapshot
 * (summary, chat context, citations) is stored here so every member reads
 * the same evidence; the concepts derived from it are filed into the org
 * ontology under deterministic ids so reconnects replace in place.
 */
export const venomOrgSourcesTable = pgTable(
  "venom_org_sources",
  {
    orgId: text("org_id").notNull(),
    sourceId: text("source_id").notNull(),
    /** "github" | "website" */
    provider: text("provider").notNull(),
    name: text("name").notNull(),
    url: text("url").notNull(),
    summary: text("summary").notNull(),
    context: text("context").notNull(),
    /** SourceCitation[] exactly as served to clients. */
    citations: jsonb("citations").notNull(),
    connectedByUserId: text("connected_by_user_id").notNull(),
    connectedByName: text("connected_by_name").notNull(),
    /** Epoch ms of the last successful fetch. */
    syncedAt: bigint("synced_at", { mode: "number" }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.orgId, table.sourceId] })],
);

/**
 * Contribution audit trail for the company Brain — currently one action,
 * "promoted": a member deliberately lifted a personal concept into the
 * shared layer. Rows are append-only.
 */
export const venomOrgAuditTable = pgTable(
  "venom_org_audit",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id").notNull(),
    /** "promoted" */
    action: text("action").notNull(),
    conceptId: text("concept_id").notNull(),
    conceptLabel: text("concept_label").notNull(),
    actorUserId: text("actor_user_id").notNull(),
    actorName: text("actor_name").notNull(),
    /** Epoch ms. */
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
  },
  (table) => [
    index("venom_org_audit_org_created_idx").on(table.orgId, table.createdAt),
  ],
);

export type VenomOrgRow = typeof venomOrgsTable.$inferSelect;
export type VenomOrgMemberRow = typeof venomOrgMembersTable.$inferSelect;
export type VenomOrgInviteRow = typeof venomOrgInvitesTable.$inferSelect;
export type VenomOrgSharedProjectRow =
  typeof venomOrgSharedProjectsTable.$inferSelect;
export type VenomOrgSourceRow = typeof venomOrgSourcesTable.$inferSelect;
export type VenomOrgAuditRow = typeof venomOrgAuditTable.$inferSelect;
