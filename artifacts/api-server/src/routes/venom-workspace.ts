import { getAuth } from "@clerk/express";
import { SaveVenomWorkspaceBody } from "@workspace/api-zod";
import { db, venomWorkspacesTable } from "@workspace/db";
import { and, eq, sql } from "drizzle-orm";
import {
  createVenomWorkspaceRouter,
  type WorkspaceStore,
} from "./venom-workspace-router";

const databaseWorkspaceStore: WorkspaceStore = {
  async get(userId) {
    const [workspace] = await db
      .select()
      .from(venomWorkspacesTable)
      .where(eq(venomWorkspacesTable.clerkUserId, userId))
      .limit(1);
    return workspace;
  },

  async create(userId, state, updatedAt) {
    const [inserted] = await db
      .insert(venomWorkspacesTable)
      .values({
        clerkUserId: userId,
        state,
        revision: 1,
        updatedAt,
      })
      .onConflictDoNothing()
      .returning();
    return inserted;
  },

  async update(userId, state, baseRevision, updatedAt) {
    const [updated] = await db
      .update(venomWorkspacesTable)
      .set({
        state,
        revision: sql`${venomWorkspacesTable.revision} + 1`,
        updatedAt,
      })
      .where(
        and(
          eq(venomWorkspacesTable.clerkUserId, userId),
          eq(venomWorkspacesTable.revision, baseRevision),
        ),
      )
      .returning();
    return updated;
  },
};

export default createVenomWorkspaceRouter({
  resolveUserId: (request) => getAuth(request).userId,
  parseBody: (value) => {
    const parsed = SaveVenomWorkspaceBody.safeParse(value);
    return parsed.success
      ? { success: true, data: parsed.data }
      : { success: false, issues: parsed.error.issues };
  },
  store: databaseWorkspaceStore,
});