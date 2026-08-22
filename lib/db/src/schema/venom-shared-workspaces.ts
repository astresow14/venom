import {
  boolean,
  index,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

/**
 * Shared (multi-user) Venom workspaces: the middle tier between a user's
 * personal knowledge and the open network.
 *
 * Membership is the single source of truth for access. Every read of
 * workspace-tier content re-checks these rows, so removing a member revokes
 * their access from the next request onward. Workspace content itself lives
 * in the owner-scoped ontology/SOP tables under owner key
 * ("workspace", <workspace uuid>) and must never be embedded in the per-user
 * sync snapshot — anything in that blob stays on a device forever.
 */

export const VENOM_SHARED_WORKSPACE_ROLES = ["admin", "member"] as const;
export type VenomSharedWorkspaceRole =
  (typeof VENOM_SHARED_WORKSPACE_ROLES)[number];

export const venomSharedWorkspacesTable = pgTable(
  "venom_shared_workspaces",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    createdByClerkUserId: text("created_by_clerk_user_id").notNull(),
    /**
     * Export policy: when false, items marked sensitive never leave the
     * workspace through an export — the server excludes them and states how
     * many were withheld. Safe default is true (export allowed) so existing
     * workspaces keep today's behavior until an admin tightens it.
     */
    allowSensitiveExport: boolean("allow_sensitive_export")
      .notNull()
      .default(true),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    index("venom_shared_workspaces_creator_idx").on(
      table.createdByClerkUserId,
    ),
  ],
);

export const venomSharedWorkspaceMembersTable = pgTable(
  "venom_shared_workspace_members",
  {
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => venomSharedWorkspacesTable.id, { onDelete: "cascade" }),
    clerkUserId: text("clerk_user_id").notNull(),
    role: text("role")
      .$type<VenomSharedWorkspaceRole>()
      .notNull()
      .default("member"),
    addedByClerkUserId: text("added_by_clerk_user_id").notNull(),
    addedAt: timestamp("added_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.workspaceId, table.clerkUserId] }),
    index("venom_shared_workspace_members_user_idx").on(table.clerkUserId),
  ],
);
