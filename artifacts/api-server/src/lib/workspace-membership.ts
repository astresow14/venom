/**
 * Membership checks for shared (multi-user) Venom workspaces.
 *
 * Every read or write of workspace-tier content goes through
 * `getSharedWorkspaceMembership` against the live membership table — never a
 * cached or client-supplied claim — so removing a member revokes their
 * access from their next request onward.
 */

import {
  db,
  venomSharedWorkspaceMembersTable,
  venomSharedWorkspacesTable,
  type VenomSharedWorkspaceRole,
} from "@workspace/db";
import { and, eq } from "drizzle-orm";

export const WORKSPACE_ACCESS_DENIED_CODE = "workspace_access_denied";

/**
 * The one shape clients key eviction on: a 403 with this code means "you are
 * not (or no longer) a member — drop any cached content for this workspace".
 * Unknown workspace ids produce the same body so callers cannot probe which
 * workspaces exist.
 */
export function workspaceAccessDeniedBody(): {
  error: string;
  code: typeof WORKSPACE_ACCESS_DENIED_CODE;
} {
  return {
    error: "You no longer have access to this workspace.",
    code: WORKSPACE_ACCESS_DENIED_CODE,
  };
}

const UUID_PATTERN =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

export function isSharedWorkspaceId(value: string): boolean {
  return UUID_PATTERN.test(value);
}

/**
 * Owner key that files workspace SOPs into the account-keyed SOP tables.
 * Clerk user ids never contain a colon, so the two namespaces cannot collide,
 * and per-account SOP routes can never see workspace rows.
 */
export function workspaceSopOwnerKey(workspaceId: string): string {
  return `workspace:${workspaceId}`;
}

export type SharedWorkspaceMembership = {
  workspaceId: string;
  workspaceName: string;
  role: VenomSharedWorkspaceRole;
};

/**
 * Resolve the caller's CURRENT membership in a workspace, or null when the
 * workspace does not exist or the caller is not a member (deliberately
 * indistinguishable).
 */
export async function getSharedWorkspaceMembership(
  workspaceId: string,
  clerkUserId: string,
): Promise<SharedWorkspaceMembership | null> {
  if (!isSharedWorkspaceId(workspaceId)) return null;
  const [row] = await db
    .select({
      workspaceId: venomSharedWorkspaceMembersTable.workspaceId,
      role: venomSharedWorkspaceMembersTable.role,
      workspaceName: venomSharedWorkspacesTable.name,
    })
    .from(venomSharedWorkspaceMembersTable)
    .innerJoin(
      venomSharedWorkspacesTable,
      eq(
        venomSharedWorkspaceMembersTable.workspaceId,
        venomSharedWorkspacesTable.id,
      ),
    )
    .where(
      and(
        eq(venomSharedWorkspaceMembersTable.workspaceId, workspaceId),
        eq(venomSharedWorkspaceMembersTable.clerkUserId, clerkUserId),
      ),
    )
    .limit(1);
  if (!row) return null;
  return {
    workspaceId: row.workspaceId,
    workspaceName: row.workspaceName,
    role: row.role,
  };
}
