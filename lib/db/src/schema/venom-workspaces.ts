import { integer, jsonb, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const venomWorkspacesTable = pgTable("venom_workspaces", {
  clerkUserId: text("clerk_user_id").primaryKey(),
  state: jsonb("state").notNull(),
  revision: integer("revision").notNull().default(1),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const insertVenomWorkspaceSchema = createInsertSchema(
  venomWorkspacesTable,
).omit({
  createdAt: true,
  updatedAt: true,
});

export type InsertVenomWorkspace = z.infer<
  typeof insertVenomWorkspaceSchema
>;
export type VenomWorkspace = typeof venomWorkspacesTable.$inferSelect;