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
import type {
  VenomBuildPackageRecord,
  VenomBuildTargetType,
} from "./venom-build-packages";

/**
 * Globally available, curated build templates: pre-filled build-run inputs
 * (target type, requirements skeleton, brand direction, acceptance checks,
 * optionally an example approved package) that any account can browse and
 * use as the starting point for a normal portfolio app + build run.
 *
 * Deliberately global — there is no owner column. Users are strictly
 * read-only consumers; writes happen only through the super-admin ops path
 * (seeding at startup plus slug-keyed upserts), mirroring the canon tier.
 * Templates are never hard-deleted, only retired, so template lineage
 * stamped on apps/runs/revisions/iterations stays resolvable forever.
 */
export type VenomBuildTemplateCategory = "app" | "widget";
export type VenomBuildTemplateStatus = "active" | "retired";

export const venomBuildTemplatesTable = pgTable(
  "venom_build_templates",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** Stable ops key: startup seeding and admin upserts address templates by slug. */
    slug: text("slug").notNull(),
    name: text("name").notNull(),
    category: text("category").$type<VenomBuildTemplateCategory>().notNull(),
    description: text("description").notNull(),
    /** Curated copy previewing what using this template produces. */
    previewSummary: text("preview_summary").notNull().default(""),
    targetType: text("target_type").$type<VenomBuildTargetType>().notNull(),
    /** Pre-filled build-run form inputs. */
    targetName: text("target_name").notNull(),
    requirements: text("requirements").notNull(),
    constraints: text("constraints").notNull().default(""),
    brandDirection: text("brand_direction").notNull().default(""),
    /** Suggested acceptance checks, surfaced in previews and generator context. */
    acceptanceChecks: jsonb("acceptance_checks")
      .$type<string[]>()
      .notNull()
      .default([]),
    /** Optional curated example of an approved package this template yields. */
    examplePackage: jsonb("example_package").$type<VenomBuildPackageRecord | null>(),
    status: text("status").$type<VenomBuildTemplateStatus>().notNull().default("active"),
    sortOrder: integer("sort_order").notNull().default(0),
    /** Null for seeded rows; otherwise the super admin who last upserted. */
    updatedByClerkUserId: text("updated_by_clerk_user_id"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    uniqueIndex("venom_build_templates_slug_idx").on(table.slug),
    index("venom_build_templates_status_sort_idx").on(
      table.status,
      table.sortOrder,
    ),
  ],
);

export const insertVenomBuildTemplateSchema = createInsertSchema(
  venomBuildTemplatesTable,
).omit({ id: true, createdAt: true, updatedAt: true });

export type InsertVenomBuildTemplate = z.infer<
  typeof insertVenomBuildTemplateSchema
>;
export type VenomBuildTemplate = typeof venomBuildTemplatesTable.$inferSelect;
