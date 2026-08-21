/**
 * Venom provisioning schema.
 *
 * Tracks durable provisioning runs, stage events, and candidate releases
 * for approved build packages. Owner-scoped and pin buildRunId / approvedRevisionId.
 *
 * Security: no credentials, tokens, or full source/package payloads are stored.
 * Source/package references are object paths + checksums only.
 */
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
import { venomBuildRunsTable } from "./venom-build-packages";

// ─── Provisioning Runs ────────────────────────────────────────────────────────

export type ProvisioningRunStatus =
  | "blocked"       // no capable provider, package preserved
  | "queued"
  | "checking_capability"
  | "creating_project"
  | "handing_off"
  | "building"
  | "testing"
  | "candidate_ready"
  | "publishing"
  | "published"
  | "cancelled"
  | "failed";

export type ProvisioningRunStage =
  | "capability_check"
  | "project_setup"
  | "source_handoff"
  | "build"
  | "test"
  | "candidate"
  | "publish";

export const venomProvisioningRunsTable = pgTable(
  "venom_provisioning_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    clerkUserId: text("clerk_user_id").notNull(),
    // Immutable pins — no cascade delete so history is preserved.
    buildRunId: uuid("build_run_id").notNull(),
    approvedRevisionId: uuid("approved_revision_id").notNull(),
    appId: uuid("app_id"),
    sourceVersionId: uuid("source_version_id"),

    // Idempotency: unique per (owner, key)
    idempotencyKey: text("idempotency_key").notNull(),

    // Deployment intent and requested configuration
    targetName: text("target_name").notNull(),
    deploymentIntent: text("deployment_intent").notNull().default("create_candidate"),
    requestedIntegrations: jsonb("requested_integrations")
      .$type<string[]>()
      .notNull()
      .default([]),

    // Run lifecycle
    status: text("status")
      .$type<ProvisioningRunStatus>()
      .notNull()
      .default("queued"),
    stage: text("stage").$type<ProvisioningRunStage>(),
    progress: integer("progress").notNull().default(0),
    attempt: integer("attempt").notNull().default(1),

    // Provider tracking (IDs safe for clients, never credentials).
    // These are reused across retries so a resumed run does not create a
    // duplicate provider project/build/candidate.
    providerProjectId: text("provider_project_id"),
    providerBuildId: text("provider_build_id"),
    providerCandidateId: text("provider_candidate_id"),

    // Stable operation key used to make resource-creating gateway calls
    // idempotent across timeout/restart/retry. Regenerated only when a known
    // terminal build/test failure explicitly requires a fresh provider attempt.
    buildAttemptKey: text("build_attempt_key"),

    // Heartbeat for stale-run detection
    heartbeatAt: timestamp("heartbeat_at", { withTimezone: true }),
    cancelRequested: boolean("cancel_requested").notNull().default(false),

    // Outcome
    failureCode: text("failure_code"),
    failureMessage: text("failure_message"),
    cancelledReason: text("cancelled_reason"),
    blockedReason: text("blocked_reason"),

    // Timestamps
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
    uniqueIndex("venom_prov_runs_owner_idempotency_idx").on(
      table.clerkUserId,
      table.idempotencyKey,
    ),
    index("venom_prov_runs_owner_updated_idx").on(
      table.clerkUserId,
      table.updatedAt,
    ),
    index("venom_prov_runs_build_run_idx").on(
      table.clerkUserId,
      table.buildRunId,
    ),
    index("venom_prov_runs_owner_app_idx").on(
      table.clerkUserId,
      table.appId,
      table.updatedAt,
    ),
    index("venom_prov_runs_status_idx").on(
      table.status,
      table.updatedAt,
    ),
  ],
);

// ─── Provisioning Stage Events ────────────────────────────────────────────────

export type ProvisioningEventType =
  | "queued"
  | "blocked"
  | "capability_checked"
  | "project_created"
  | "project_linked"
  | "source_handed_off"
  | "build_started"
  | "build_complete"
  | "test_started"
  | "test_complete"
  | "candidate_ready"
  | "publish_started"
  | "published"
  | "cancel_requested"
  | "cancelled"
  | "failed"
  | "retried"
  | "heartbeat";

export const venomProvisioningEventsTable = pgTable(
  "venom_provisioning_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    provisioningRunId: uuid("provisioning_run_id")
      .notNull()
      .references(() => venomProvisioningRunsTable.id, { onDelete: "cascade" }),
    clerkUserId: text("clerk_user_id").notNull(),
    eventType: text("event_type")
      .$type<ProvisioningEventType>()
      .notNull(),
    status: text("status").$type<ProvisioningRunStatus>().notNull(),
    stage: text("stage").$type<ProvisioningRunStage>(),
    progress: integer("progress").notNull(),
    message: text("message").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("venom_prov_events_run_idx").on(
      table.clerkUserId,
      table.provisioningRunId,
      table.createdAt,
    ),
  ],
);

// ─── Candidate Releases ───────────────────────────────────────────────────────

export type CandidateReleaseStatus =
  | "candidate"   // ready for testing/promotion
  | "published"   // currently the primary deployment
  | "superseded"  // replaced by a newer published release
  | "rolled_back" // explicitly rolled back
  | "failed";     // publish failed, prior healthy release preserved

export const venomCandidateReleasesTable = pgTable(
  "venom_candidate_releases",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    clerkUserId: text("clerk_user_id").notNull(),
    // Immutable pins
    provisioningRunId: uuid("provisioning_run_id")
      .notNull()
      .references(() => venomProvisioningRunsTable.id, { onDelete: "restrict" }),
    buildRunId: uuid("build_run_id").notNull(),
    approvedRevisionId: uuid("approved_revision_id").notNull(),
    appId: uuid("app_id"),
    sourceVersionId: uuid("source_version_id"),

    // Exact target name pinned at release creation so app-wide history
    // controls can require the precise target for this historical release.
    targetName: text("target_name").notNull().default(""),

    // Provider-assigned identifiers (client-safe, never credentials)
    providerProjectId: text("provider_project_id"),
    providerCandidateId: text("provider_candidate_id").notNull(),
    providerReleaseId: text("provider_release_id"),

    // Launch URL exposed to clients after provider confirms healthy
    launchUrl: text("launch_url"),

    // Status lifecycle
    status: text("status")
      .$type<CandidateReleaseStatus>()
      .notNull()
      .default("candidate"),

    // Last known healthy state — never overwritten by a failed publish
    lastHealthyStatus: text("last_healthy_status")
      .$type<CandidateReleaseStatus>(),
    lastHealthyAt: timestamp("last_healthy_at", { withTimezone: true }),

    // Provider reported whether rollback is supported
    rollbackSupported: boolean("rollback_supported").notNull().default(false),

    // Idempotency keys for publish and rollback — prevents double-invocation.
    // The key is reserved atomically under an advisory lock BEFORE the provider
    // call. On failure the key is retained so a same-key retry is safe; a
    // different key while an operation is reserved-but-not-complete is a conflict.
    publishIdempotencyKey: text("publish_idempotency_key"),
    rollbackIdempotencyKey: text("rollback_idempotency_key"),

    // Durable in-progress reservation state. When a publish/rollback reserves
    // its key it records the reservation time. A completed operation clears the
    // in-progress flag (publishedAt/rolledBackAt serve as completion markers).
    // These let stale-recovery and same-key retries distinguish "reserved but
    // interrupted" from "completed" without ever reporting a false success.
    publishInProgressAt: timestamp("publish_in_progress_at", {
      withTimezone: true,
    }),
    rollbackInProgressAt: timestamp("rollback_in_progress_at", {
      withTimezone: true,
    }),

    // Audit
    publishedAt: timestamp("published_at", { withTimezone: true }),
    rolledBackAt: timestamp("rolled_back_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    index("venom_cand_releases_owner_run_idx").on(
      table.clerkUserId,
      table.provisioningRunId,
    ),
    index("venom_cand_releases_owner_app_idx").on(
      table.clerkUserId,
      table.appId,
      table.updatedAt,
    ),
    index("venom_cand_releases_owner_build_run_idx").on(
      table.clerkUserId,
      table.buildRunId,
    ),
  ],
);

// ─── Insert schemas and types ─────────────────────────────────────────────────

export const insertVenomProvisioningRunSchema = createInsertSchema(
  venomProvisioningRunsTable,
).omit({ id: true, createdAt: true, updatedAt: true });

export type InsertVenomProvisioningRun = z.infer<
  typeof insertVenomProvisioningRunSchema
>;
export type VenomProvisioningRun =
  typeof venomProvisioningRunsTable.$inferSelect;
export type VenomProvisioningEvent =
  typeof venomProvisioningEventsTable.$inferSelect;
export type VenomCandidateRelease =
  typeof venomCandidateReleasesTable.$inferSelect;
