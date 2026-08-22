import { sql } from "drizzle-orm";
import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const venomPortfolioAppsTable = pgTable(
  "venom_portfolio_apps",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    clerkUserId: text("clerk_user_id").notNull(),
    name: text("name").notNull(),
    purpose: text("purpose").notNull(),
    brand: text("brand").notNull(),
    status: text("status").notNull().default("draft"),
    detectedStack: jsonb("detected_stack").$type<string[]>().notNull().default([]),
    sourceType: text("source_type").notNull().default("none"),
    currentSourceVersion: integer("current_source_version").notNull().default(0),
    latestImportStatus: text("latest_import_status"),
    sourceUpdatedAt: timestamp("source_updated_at", { withTimezone: true }),
    /**
     * Optional link to one of the owner's Venom workspace projects (plain
     * text id from the workspace blob; projects are not a table). The link
     * tells the parent layer which Brain knowledge and connected sources
     * feed this app.
     */
    linkedProjectId: text("linked_project_id"),
    /** When the owner last dismissed the "new data" improvement suggestion. */
    improvementSuggestionDismissedAt: timestamp(
      "improvement_suggestion_dismissed_at",
      { withTimezone: true },
    ),
    /**
     * The candidate release currently serving this app, or null when nothing
     * is live. Pin-style pointer (no foreign key): it is written only inside
     * the provisioning publish/rollback transactions, so it always reflects
     * what those flows actually promoted — which may lag the newest approved
     * package.
     */
    liveReleaseId: uuid("live_release_id"),
    /**
     * Template lineage: which global build template this app was created
     * from, stamped once at creation and never rewritten. Pin-style (no
     * foreign key) with a denormalized name snapshot so origin display
     * survives anything that happens to the catalog. This is the hook the
     * future learning loop keys on.
     */
    templateId: uuid("template_id"),
    templateName: text("template_name"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    index("venom_portfolio_apps_owner_updated_idx").on(
      table.clerkUserId,
      table.updatedAt,
    ),
  ],
);

export const venomPortfolioSourceConnectionsTable = pgTable(
  "venom_portfolio_source_connections",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    appId: uuid("app_id")
      .notNull()
      .references(() => venomPortfolioAppsTable.id, { onDelete: "cascade" }),
    clerkUserId: text("clerk_user_id").notNull(),
    sourceType: text("source_type").notNull(),
    label: text("label").notNull(),
    status: text("status").notNull().default("connected"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    index("venom_portfolio_source_connections_owner_app_idx").on(
      table.clerkUserId,
      table.appId,
    ),
  ],
);

export type VenomSourceManifest = {
  formatVersion: 1;
  rootKind: "single-project" | "monorepo";
  totalEntries: number;
  safeFileCount: number;
  excludedSensitiveFileCount: number;
  files: string[];
  projectFiles: string[];
  detectedStack: string[];
};

export const venomPortfolioSourceVersionsTable = pgTable(
  "venom_portfolio_source_versions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    appId: uuid("app_id")
      .notNull()
      .references(() => venomPortfolioAppsTable.id, { onDelete: "cascade" }),
    clerkUserId: text("clerk_user_id").notNull(),
    versionNumber: integer("version_number").notNull(),
    sourceType: text("source_type").notNull(),
    packageObjectPath: text("package_object_path").notNull(),
    archiveFilename: text("archive_filename").notNull(),
    archiveBytes: integer("archive_bytes").notNull(),
    checksumSha256: text("checksum_sha256").notNull(),
    manifest: jsonb("manifest").$type<VenomSourceManifest>().notNull(),
    retentionExpiresAt: timestamp("retention_expires_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("venom_portfolio_source_versions_app_version_idx").on(
      table.appId,
      table.versionNumber,
    ),
    uniqueIndex("venom_portfolio_source_versions_package_idx").on(
      table.packageObjectPath,
    ),
    index("venom_portfolio_source_versions_owner_app_idx").on(
      table.clerkUserId,
      table.appId,
    ),
  ],
);

export const venomPortfolioDeploymentLinksTable = pgTable(
  "venom_portfolio_deployment_links",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    appId: uuid("app_id")
      .notNull()
      .references(() => venomPortfolioAppsTable.id, { onDelete: "cascade" }),
    clerkUserId: text("clerk_user_id").notNull(),
    label: text("label").notNull().default("Live deployment"),
    url: text("url").notNull(),
    isPrimary: boolean("is_primary").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    index("venom_portfolio_deployment_links_owner_app_idx").on(
      table.clerkUserId,
      table.appId,
    ),
    uniqueIndex("venom_portfolio_deployment_links_primary_app_idx")
      .on(table.appId)
      .where(sql`${table.isPrimary} = true`),
  ],
);

export const venomPortfolioImportJobsTable = pgTable(
  "venom_portfolio_import_jobs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    appId: uuid("app_id")
      .notNull()
      .references(() => venomPortfolioAppsTable.id, { onDelete: "cascade" }),
    clerkUserId: text("clerk_user_id").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    archiveFilename: text("archive_filename").notNull(),
    declaredBytes: integer("declared_bytes").notNull(),
    uploadObjectPath: text("upload_object_path").notNull(),
    status: text("status").notNull().default("awaiting_upload"),
    progress: integer("progress").notNull().default(0),
    failureCode: text("failure_code"),
    failureMessage: text("failure_message"),
    sourceVersionId: uuid("source_version_id").references(
      () => venomPortfolioSourceVersionsTable.id,
      { onDelete: "set null" },
    ),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (table) => [
    uniqueIndex("venom_portfolio_import_jobs_owner_idempotency_idx").on(
      table.clerkUserId,
      table.idempotencyKey,
    ),
    uniqueIndex("venom_portfolio_import_jobs_upload_path_idx").on(
      table.uploadObjectPath,
    ),
    index("venom_portfolio_import_jobs_owner_app_idx").on(
      table.clerkUserId,
      table.appId,
      table.createdAt,
    ),
  ],
);

/**
 * One row per approved build package registered against an app: the app's
 * package version history. Rows are written only when a human approves a
 * build run that is pinned to the app, so every version is traceable to an
 * explicit approval.
 */
export const venomPortfolioAppIterationsTable = pgTable(
  "venom_portfolio_app_iterations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    appId: uuid("app_id")
      .notNull()
      .references(() => venomPortfolioAppsTable.id, { onDelete: "cascade" }),
    clerkUserId: text("clerk_user_id").notNull(),
    iterationNumber: integer("iteration_number").notNull(),
    // Immutable pins into the build pipeline. Deliberately no destructive
    // foreign keys: deleting a run must never rewrite an app's recorded
    // history; unresolvable pins fail loudly instead.
    buildRunId: uuid("build_run_id").notNull(),
    revisionId: uuid("revision_id").notNull(),
    packageTitle: text("package_title").notNull(),
    packageChecksum: text("package_checksum").notNull(),
    runKind: text("run_kind").notNull().default("standard"),
    baselineIterationId: uuid("baseline_iteration_id"),
    baselineRevisionId: uuid("baseline_revision_id"),
    /** Template lineage carried from the approved run (no FK). */
    templateId: uuid("template_id"),
    /** Human-readable request or data change that drove this version. */
    reason: text("reason").notNull(),
    changesSummary: text("changes_summary"),
    /**
     * The candidate release this package last shipped as, stamped when
     * provisioning publishes (or restores) it. Historical pin, not a live
     * pointer: it survives supersede/rollback so the row keeps naming the
     * release it went out the door as. Null until provisioning reports one.
     */
    releaseId: uuid("release_id"),
    createdBy: text("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("venom_portfolio_app_iterations_app_number_idx").on(
      table.appId,
      table.iterationNumber,
    ),
    uniqueIndex("venom_portfolio_app_iterations_build_run_idx").on(
      table.buildRunId,
    ),
    index("venom_portfolio_app_iterations_owner_app_idx").on(
      table.clerkUserId,
      table.appId,
      table.createdAt,
    ),
  ],
);

/**
 * Public share state for a portfolio app. One row per app, created the first
 * time the owner enables sharing. The slug is a high-entropy public
 * identifier that is stable for the lifetime of the app: disabling sharing
 * flips `enabled` off (killing the public surface immediately) but keeps the
 * slug reserved so re-enabling restores the same link. Public resolution
 * joins app → liveReleaseId → published release at read time, so rollbacks
 * and republishes change what the link serves without touching this row.
 * No owner identity or provider identifiers ever leave the server from here.
 */
export const venomPortfolioAppSharesTable = pgTable(
  "venom_portfolio_app_shares",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    appId: uuid("app_id")
      .notNull()
      .references(() => venomPortfolioAppsTable.id, { onDelete: "cascade" }),
    clerkUserId: text("clerk_user_id").notNull(),
    slug: text("slug").notNull(),
    enabled: boolean("enabled").notNull().default(false),
    enabledAt: timestamp("enabled_at", { withTimezone: true }),
    disabledAt: timestamp("disabled_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    uniqueIndex("venom_portfolio_app_shares_app_idx").on(table.appId),
    uniqueIndex("venom_portfolio_app_shares_slug_idx").on(table.slug),
    index("venom_portfolio_app_shares_owner_idx").on(table.clerkUserId),
  ],
);

export const insertVenomPortfolioAppSchema = createInsertSchema(
  venomPortfolioAppsTable,
).omit({ id: true, createdAt: true, updatedAt: true });
export const insertVenomPortfolioSourceVersionSchema = createInsertSchema(
  venomPortfolioSourceVersionsTable,
).omit({ id: true, createdAt: true });
export const insertVenomPortfolioImportJobSchema = createInsertSchema(
  venomPortfolioImportJobsTable,
).omit({ id: true, createdAt: true, updatedAt: true });

export type InsertVenomPortfolioApp = z.infer<
  typeof insertVenomPortfolioAppSchema
>;
export type VenomPortfolioApp = typeof venomPortfolioAppsTable.$inferSelect;
export type VenomPortfolioSourceVersion =
  typeof venomPortfolioSourceVersionsTable.$inferSelect;
export type VenomPortfolioImportJob =
  typeof venomPortfolioImportJobsTable.$inferSelect;
export type VenomPortfolioAppIteration =
  typeof venomPortfolioAppIterationsTable.$inferSelect;
export type VenomPortfolioAppShare =
  typeof venomPortfolioAppSharesTable.$inferSelect;
