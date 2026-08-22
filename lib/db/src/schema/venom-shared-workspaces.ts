import {
  bigint,
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

/**
 * Admin-set AI controls for a workspace, binding only requests billed to
 * this workspace's Organization plan. One row per workspace; no row means
 * no controls. Money is integer micro-dollars like the usage ledger, and
 * the values here are admin-only reads — members learn lock/cap *state*
 * through the billing context, never these figures.
 */
export const venomWorkspaceAiControlsTable = pgTable(
  "venom_workspace_ai_controls",
  {
    workspaceId: uuid("workspace_id")
      .primaryKey()
      .references(() => venomSharedWorkspacesTable.id, { onDelete: "cascade" }),
    /**
     * Default monthly cap on each member's workspace-billed spend, in
     * micro-dollars. Null = no default cap. Zero is a valid, deliberate
     * "no workspace AI for members without an override" setting.
     */
    defaultMemberCapMicros: bigint("default_member_cap_micros", {
      mode: "number",
    }),
    /**
     * Model selection policy forced on workspace-billed requests, beating
     * the member's own policy. Null = members keep their own policy.
     * "manual" is never forceable — it would just hand the choice back.
     */
    forcedSelectionPolicy: text("forced_selection_policy").$type<
      "auto-cheapest" | "auto-max-power"
    >(),
    /**
     * Cost tiers ("$" | "$$" | "$$$") a workspace-billed request may use.
     * Null = all tiers allowed. Writes validate a non-empty subset so a
     * lock can never be saved that allows nothing.
     */
    allowedCostTiers: text("allowed_cost_tiers").array(),
    updatedByClerkUserId: text("updated_by_clerk_user_id").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
);

/**
 * Per-member cap overrides. A row's existence replaces the workspace
 * default for that member: a numeric value is their own cap, and null is
 * an explicit "no cap for this member". Deleting the row returns the
 * member to the workspace default. Rows survive membership loss harmlessly
 * (enforcement only consults them for current members) and are removed in
 * cascade with the workspace.
 */
export const venomWorkspaceMemberAiControlsTable = pgTable(
  "venom_workspace_member_ai_controls",
  {
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => venomSharedWorkspacesTable.id, { onDelete: "cascade" }),
    clerkUserId: text("clerk_user_id").notNull(),
    /** Micro-dollar cap for this member; null = explicitly uncapped. */
    capMicros: bigint("cap_micros", { mode: "number" }),
    updatedByClerkUserId: text("updated_by_clerk_user_id").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    primaryKey({ columns: [table.workspaceId, table.clerkUserId] }),
  ],
);
