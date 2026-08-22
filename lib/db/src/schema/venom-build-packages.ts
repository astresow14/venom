import {
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

export type VenomBuildTargetType =
  | "app"
  | "website"
  | "brand"
  | "customer_service_flow";

export type VenomBuildPackageRecord = {
  formatVersion: 1;
  targetType: VenomBuildTargetType;
  title: string;
  productBrief: {
    summary: string;
    audience: string[];
    outcomes: string[];
  };
  functionalScope: string[];
  brandDirection: string[];
  contentRequirements: string[];
  serviceFlowRequirements: string[];
  sourceReferences: Array<{
    appId: string;
    appName: string;
    sourceVersionId: string;
    versionNumber: number;
    checksumSha256: string;
  }>;
  sopReferences: Array<{
    sopId: string;
    revisionId: string;
    revisionNumber: number;
    title: string;
    checksumSha256: string;
  }>;
  dataNeeds: string[];
  integrationNeeds: string[];
  permissionRequests: Array<{
    capability: string;
    reason: string;
    required: boolean;
  }>;
  acceptanceChecks: string[];
  launchConstraints: string[];
};

export const venomBuildRunsTable = pgTable(
  "venom_build_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    clerkUserId: text("clerk_user_id").notNull(),
    correlationId: uuid("correlation_id").notNull().defaultRandom(),
    idempotencyKey: text("idempotency_key").notNull(),
    // These immutable pins intentionally have no destructive foreign key.
    // Source/app deletion must not erase what a durable run was created from.
    appId: uuid("app_id"),
    sourceVersionId: uuid("source_version_id"),
    projectId: text("project_id"),
    targetType: text("target_type").$type<VenomBuildTargetType>().notNull(),
    targetName: text("target_name").notNull(),
    requirements: text("requirements").notNull(),
    constraints: text("constraints").notNull(),
    brandDirection: text("brand_direction").notNull(),
    sopRevisionIds: jsonb("sop_revision_ids").$type<string[]>().notNull().default([]),
    /**
     * "standard" or "app_iteration". Iteration runs improve an existing
     * app from a pinned baseline package instead of a from-scratch brief.
     */
    runKind: text("run_kind").notNull().default("standard"),
    // Immutable baseline pins for app_iteration runs (no destructive FK).
    // If the baseline can no longer be resolved the run fails explicitly
    // with baseline_unresolvable; it never silently starts fresh.
    baselineIterationId: uuid("baseline_iteration_id"),
    baselineRevisionId: uuid("baseline_revision_id"),
    /**
     * Template lineage pin (no destructive FK): the global template this
     * run's request descends from — inherited from the pinned app when it
     * has lineage, otherwise the explicit template the run started from.
     */
    templateId: uuid("template_id"),
    /** Bounded plain-language summary of data changes since the baseline. */
    changesSummary: text("changes_summary"),
    /**
     * The allowance hold (venom_allowance_reservations id) admitted with
     * this run's queue/retry/revise transition. The processor settles it
     * into the run's first ledgered usage event or releases it at a
     * terminal state; a stale id is harmless — settle and release both
     * no-op once the reservation row is gone.
     */
    reservationId: uuid("reservation_id"),
    status: text("status").notNull().default("queued"),
    progress: integer("progress").notNull().default(0),
    attempt: integer("attempt").notNull().default(1),
    currentRevisionNumber: integer("current_revision_number").notNull().default(0),
    approvedRevisionId: uuid("approved_revision_id"),
    pendingRevisionInstruction: text("pending_revision_instruction"),
    failureCode: text("failure_code"),
    failureMessage: text("failure_message"),
    cancelledReason: text("cancelled_reason"),
    startedAt: timestamp("started_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    uniqueIndex("venom_build_runs_owner_idempotency_idx").on(
      table.clerkUserId,
      table.idempotencyKey,
    ),
    index("venom_build_runs_owner_updated_idx").on(
      table.clerkUserId,
      table.updatedAt,
    ),
    index("venom_build_runs_owner_app_idx").on(
      table.clerkUserId,
      table.appId,
      table.updatedAt,
    ),
  ],
);

export const venomBuildPackageRevisionsTable = pgTable(
  "venom_build_package_revisions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    runId: uuid("run_id")
      .notNull()
      .references(() => venomBuildRunsTable.id, { onDelete: "cascade" }),
    clerkUserId: text("clerk_user_id").notNull(),
    revisionNumber: integer("revision_number").notNull(),
    reason: text("reason").notNull(),
    package: jsonb("package").$type<VenomBuildPackageRecord>().notNull(),
    checksumSha256: text("checksum_sha256").notNull(),
    /** Template lineage carried from the run at commit time (no FK). */
    templateId: uuid("template_id"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    approvedBy: text("approved_by"),
  },
  (table) => [
    uniqueIndex("venom_build_revisions_run_number_idx").on(
      table.runId,
      table.revisionNumber,
    ),
    index("venom_build_revisions_owner_run_idx").on(
      table.clerkUserId,
      table.runId,
    ),
  ],
);

export const venomBuildRunEventsTable = pgTable(
  "venom_build_run_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    runId: uuid("run_id")
      .notNull()
      .references(() => venomBuildRunsTable.id, { onDelete: "cascade" }),
    clerkUserId: text("clerk_user_id").notNull(),
    eventType: text("event_type").notNull(),
    status: text("status").notNull(),
    progress: integer("progress").notNull(),
    message: text("message").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("venom_build_events_owner_run_idx").on(
      table.clerkUserId,
      table.runId,
      table.createdAt,
    ),
  ],
);

export const insertVenomBuildRunSchema = createInsertSchema(
  venomBuildRunsTable,
).omit({ id: true, correlationId: true, createdAt: true, updatedAt: true });

export type InsertVenomBuildRun = z.infer<typeof insertVenomBuildRunSchema>;
export type VenomBuildRun = typeof venomBuildRunsTable.$inferSelect;
export type VenomBuildPackageRevision =
  typeof venomBuildPackageRevisionsTable.$inferSelect;
export type VenomBuildRunEvent = typeof venomBuildRunEventsTable.$inferSelect;