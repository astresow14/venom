import { getAuth } from "@clerk/express";
import { SaveVenomWorkspaceBody } from "@workspace/api-zod";
import { db, venomWorkspacesTable } from "@workspace/db";
import { and, eq, sql } from "drizzle-orm";
import {
  createVenomWorkspaceRouter,
  type WorkspaceStore,
} from "./venom-workspace-router";
import { validateVenomBoardState } from "./venom-board-validation";

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
    if (!parsed.success) {
      return { success: false, issues: parsed.error.issues };
    }
    const boardIssues = validateVenomBoardState(parsed.data.state);
    return boardIssues.length > 0
      ? { success: false, issues: boardIssues }
      : { success: true, data: parsed.data };
  },
  store: databaseWorkspaceStore,
});