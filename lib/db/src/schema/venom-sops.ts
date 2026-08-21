import {
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { venomPortfolioAppsTable } from "./venom-app-portfolio";

export type VenomSopContentRecord = {
  purpose: string;
  prerequisites: string[];
  inputs: string[];
  guidance: string[];
  requiredApprovals: string[];
  acceptanceChecks: string[];
};

export const venomSopsTable = pgTable(
  "venom_sops",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    clerkUserId: text("clerk_user_id").notNull(),
    title: text("title").notNull(),
    lifecycle: text("lifecycle").notNull().default("draft"),
    category: text("category").notNull(),
    tags: text("tags").array().notNull().default([]),
    provenance: text("provenance").notNull().default("manual"),
    content: jsonb("content").$type<VenomSopContentRecord>().notNull(),
    activeRevisionId: uuid("active_revision_id"),
    activeRevisionNumber: integer("active_revision_number"),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    index("venom_sops_owner_updated_idx").on(
      table.clerkUserId,
      table.updatedAt,
    ),
    index("venom_sops_owner_lifecycle_idx").on(
      table.clerkUserId,
      table.lifecycle,
    ),
  ],
);

export const venomSopRevisionsTable = pgTable(
  "venom_sop_revisions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    sopId: uuid("sop_id")
      .notNull()
      .references(() => venomSopsTable.id, { onDelete: "cascade" }),
    clerkUserId: text("clerk_user_id").notNull(),
    versionNumber: integer("version_number").notNull(),
    title: text("title").notNull(),
    category: text("category").notNull(),
    tags: text("tags").array().notNull().default([]),
    provenance: text("provenance").notNull(),
    content: jsonb("content").$type<VenomSopContentRecord>().notNull(),
    checksumSha256: text("checksum_sha256").notNull(),
    publishedAt: timestamp("published_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("venom_sop_revisions_sop_version_idx").on(
      table.sopId,
      table.versionNumber,
    ),
    index("venom_sop_revisions_owner_sop_idx").on(
      table.clerkUserId,
      table.sopId,
    ),
  ],
);

export const venomSopAppAssignmentsTable = pgTable(
  "venom_sop_app_assignments",
  {
    clerkUserId: text("clerk_user_id").notNull(),
    sopId: uuid("sop_id")
      .notNull()
      .references(() => venomSopsTable.id, { onDelete: "cascade" }),
    appId: uuid("app_id")
      .notNull()
      .references(() => venomPortfolioAppsTable.id, { onDelete: "cascade" }),
    assignedAt: timestamp("assigned_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    primaryKey({
      name: "venom_sop_app_assignments_pk",
      columns: [table.sopId, table.appId],
    }),
    index("venom_sop_app_assignments_owner_app_idx").on(
      table.clerkUserId,
      table.appId,
    ),
  ],
);

export const venomSopProjectSelectionsTable = pgTable(
  "venom_sop_project_selections",
  {
    clerkUserId: text("clerk_user_id").notNull(),
    projectId: text("project_id").notNull(),
    sopId: uuid("sop_id")
      .notNull()
      .references(() => venomSopsTable.id, { onDelete: "cascade" }),
    revisionId: uuid("revision_id")
      .notNull()
      .references(() => venomSopRevisionsTable.id, { onDelete: "cascade" }),
    selectedAt: timestamp("selected_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    primaryKey({
      name: "venom_sop_project_selections_pk",
      columns: [table.clerkUserId, table.projectId, table.sopId],
    }),
    index("venom_sop_project_selections_owner_project_idx").on(
      table.clerkUserId,
      table.projectId,
    ),
  ],
);

export const insertVenomSopSchema = createInsertSchema(venomSopsTable).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export const insertVenomSopRevisionSchema = createInsertSchema(
  venomSopRevisionsTable,
).omit({ id: true, publishedAt: true });

export type InsertVenomSop = z.infer<typeof insertVenomSopSchema>;
export type VenomSop = typeof venomSopsTable.$inferSelect;
export type VenomSopRevision = typeof venomSopRevisionsTable.$inferSelect;
export type VenomSopAppAssignment =
  typeof venomSopAppAssignmentsTable.$inferSelect;
export type VenomSopProjectSelection =
  typeof venomSopProjectSelectionsTable.$inferSelect;