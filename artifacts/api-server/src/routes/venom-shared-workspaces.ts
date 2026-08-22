/**
 * Shared (multi-user) workspace routes: workspace records, membership with
 * admin/member roles, and the membership-checked reads that serve
 * workspace-tier knowledge and SOPs.
 *
 * Access rules:
 * - Every workspace-scoped route re-checks the caller's CURRENT membership;
 *   a removed member is denied (403 workspace_access_denied) on their next
 *   request, which is also the client's signal to evict cached content.
 * - Only admins add members, remove members, or change a member's role.
 *   Role changes happen in place — membership (and therefore access) never
 *   lapses. The last admin can never be removed or demoted.
 * - Workspace content is served exclusively from these authenticated
 *   endpoints; it never rides the per-user sync snapshot.
 */

import { createHash } from "node:crypto";
import { clerkClient, getAuth } from "@clerk/express";
import {
  AddSharedWorkspaceMemberBody,
  AddSharedWorkspaceMemberParams,
  AddSharedWorkspaceMemberResponse,
  ClearSharedWorkspaceMemberAiCapParams,
  ClearSharedWorkspaceMemberAiCapResponse,
  GetSharedWorkspaceAiControlsParams,
  GetSharedWorkspaceAiControlsResponse,
  GetSharedWorkspaceUsageParams,
  GetSharedWorkspaceUsageResponse,
  SetSharedWorkspaceMemberAiCapBody,
  SetSharedWorkspaceMemberAiCapParams,
  SetSharedWorkspaceMemberAiCapResponse,
  UpdateSharedWorkspaceAiControlsBody,
  UpdateSharedWorkspaceAiControlsParams,
  UpdateSharedWorkspaceAiControlsResponse,
  CreateSharedWorkspaceBody,
  CreateSharedWorkspaceResponse,
  CreateSharedWorkspaceSopBody,
  CreateSharedWorkspaceSopParams,
  CreateSharedWorkspaceSopResponse,
  ExportSharedWorkspaceMarkdownParams,
  GetSharedWorkspaceKnowledgeParams,
  GetSharedWorkspaceKnowledgeResponse,
  GetSharedWorkspaceSettingsParams,
  GetSharedWorkspaceSettingsResponse,
  ListSharedWorkspaceMembersParams,
  ListSharedWorkspaceMembersResponse,
  ListSharedWorkspaceSopsParams,
  ListSharedWorkspaceSopsResponse,
  ListSharedWorkspacesResponse,
  PublishSharedWorkspaceSopParams,
  PublishSharedWorkspaceSopResponse,
  RemoveSharedWorkspaceMemberParams,
  RemoveSharedWorkspaceMemberResponse,
  SetSharedWorkspaceConceptRestrictionBody,
  SetSharedWorkspaceConceptRestrictionParams,
  SetSharedWorkspaceConceptRestrictionResponse,
  SetSharedWorkspaceConceptSensitivityBody,
  SetSharedWorkspaceConceptSensitivityParams,
  SetSharedWorkspaceConceptSensitivityResponse,
  SetSharedWorkspaceEvidenceSensitivityBody,
  SetSharedWorkspaceEvidenceSensitivityParams,
  SetSharedWorkspaceEvidenceSensitivityResponse,
  SetSharedWorkspaceSopRestrictionBody,
  SetSharedWorkspaceSopRestrictionParams,
  SetSharedWorkspaceSopRestrictionResponse,
  SetSharedWorkspaceSopSensitivityBody,
  SetSharedWorkspaceSopSensitivityParams,
  SetSharedWorkspaceSopSensitivityResponse,
  UpdateSharedWorkspaceMemberRoleBody,
  UpdateSharedWorkspaceMemberRoleParams,
  UpdateSharedWorkspaceMemberRoleResponse,
  UpdateSharedWorkspaceSettingsBody,
  UpdateSharedWorkspaceSettingsParams,
  UpdateSharedWorkspaceSettingsResponse,
} from "@workspace/api-zod";
import {
  db,
  venomSharedWorkspaceMembersTable,
  venomSharedWorkspacesTable,
  venomSopRevisionsTable,
  venomSopsTable,
  VENOM_SHARED_WORKSPACE_ROLES,
  type VenomSop,
  type VenomSharedWorkspaceRole,
} from "@workspace/db";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { Router, type IRouter, type Request } from "express";
import { checkSopContentSafety, flattenSopContent } from "../lib/sop-content-safety";
import {
  getSharedWorkspaceMembership,
  workspaceAccessDeniedBody,
  workspaceAdminRequiredBody,
  workspaceSopOwnerKey,
  type SharedWorkspaceMembership,
} from "../lib/workspace-membership";
import {
  loadOntologyConcept,
  loadOntologyConcepts,
  setOntologyConceptRestriction,
  setOntologyConceptSensitivity,
  setOntologyEvidenceSensitivity,
  workspaceOwner,
} from "../lib/venom-ontology-store";
import {
  exportFileName,
  knowledgeMarkdown,
  sopsMarkdown,
} from "../lib/venom-markdown-export";
import {
  approachingWarnRatio,
  planAllowanceMicros,
  venomPlan,
} from "../lib/venom-billing-plans";
import {
  billingPeriodFor,
  getBillingAccount,
  workspaceOrgPlanActive,
} from "../lib/venom-billing-store";
import {
  aiControlMicrosToUsd,
  aiControlUsdToMicros,
  clearMemberAiCapOverride,
  listMemberAiCapOverrides,
  loadWorkspaceAiControls,
  normalizeAllowedCostTiers,
  saveWorkspaceAiControls,
  setMemberAiCapOverride,
  sumWorkspaceBilledMicrosByMember,
} from "../lib/venom-workspace-ai-controls";

const router: IRouter = Router();

const MAX_WORKSPACES_PER_CREATOR = 50;
const MAX_MEMBERS_PER_WORKSPACE = 200;

// ---------------------------------------------------------------------------
// Test seams (auth + account directory), NODE_ENV=test only
// ---------------------------------------------------------------------------

type UserIdResolver = (request: Request) => string | null;
let testUserIdResolver: UserIdResolver | null = null;

function userIdFor(request: Request): string | null {
  if (testUserIdResolver) return testUserIdResolver(request);
  return getAuth(request).userId;
}

export function overrideSharedWorkspaceUserIdResolverForTests(
  resolver: UserIdResolver,
): () => void {
  if (process.env.NODE_ENV !== "test") {
    throw new Error(
      "Shared workspace auth overrides are available only in tests",
    );
  }
  const previous = testUserIdResolver;
  testUserIdResolver = resolver;
  return () => {
    testUserIdResolver = previous;
  };
}

export type SharedWorkspaceUserDirectory = {
  /** Resolve one account; null when no such account exists. */
  getUser: (userId: string) => Promise<{ id: string; name: string | null } | null>;
  /** Best-effort display names for a set of accounts. */
  getUsers: (userIds: string[]) => Promise<Map<string, string | null>>;
};

function clerkDisplayName(user: {
  firstName: string | null;
  lastName: string | null;
  username: string | null;
  primaryEmailAddress: { emailAddress: string } | null;
}): string | null {
  const fullName = [user.firstName, user.lastName]
    .filter((part): part is string => Boolean(part))
    .join(" ")
    .trim();
  if (fullName) return fullName;
  if (user.username) return user.username;
  return user.primaryEmailAddress?.emailAddress ?? null;
}

function isClerkMissingUser(error: unknown): boolean {
  const status = (error as { status?: number } | null)?.status;
  return status === 404 || status === 400 || status === 422;
}

const clerkDirectory: SharedWorkspaceUserDirectory = {
  async getUser(userId) {
    try {
      const user = await clerkClient.users.getUser(userId);
      return { id: user.id, name: clerkDisplayName(user) };
    } catch (error) {
      if (isClerkMissingUser(error)) return null;
      throw error;
    }
  },
  async getUsers(userIds) {
    const names = new Map<string, string | null>();
    if (userIds.length === 0) return names;
    const { data } = await clerkClient.users.getUserList({
      userId: userIds,
      limit: Math.min(userIds.length, 500),
    });
    for (const user of data) {
      names.set(user.id, clerkDisplayName(user));
    }
    return names;
  },
};

let userDirectory: SharedWorkspaceUserDirectory = clerkDirectory;

export function overrideSharedWorkspaceUserDirectoryForTests(
  directory: SharedWorkspaceUserDirectory,
): () => void {
  if (process.env.NODE_ENV !== "test") {
    throw new Error(
      "Shared workspace directory overrides are available only in tests",
    );
  }
  const previous = userDirectory;
  userDirectory = directory;
  return () => {
    userDirectory = previous;
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function memberCounts(
  workspaceIds: string[],
): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  if (workspaceIds.length === 0) return counts;
  const rows = await db
    .select({
      workspaceId: venomSharedWorkspaceMembersTable.workspaceId,
      count: sql<number>`COUNT(*)::int`,
    })
    .from(venomSharedWorkspaceMembersTable)
    .where(inArray(venomSharedWorkspaceMembersTable.workspaceId, workspaceIds))
    .groupBy(venomSharedWorkspaceMembersTable.workspaceId);
  for (const row of rows) {
    counts.set(row.workspaceId, row.count);
  }
  return counts;
}

/**
 * Membership gate shared by every workspace-scoped route. Sends the 403
 * eviction signal and returns null when the caller has no current
 * membership (or the workspace id is unknown/malformed).
 */
async function requireMembership(
  req: Request,
  res: Parameters<Parameters<IRouter["get"]>[1]>[1],
  workspaceId: string,
): Promise<SharedWorkspaceMembership | null> {
  const userId = userIdFor(req);
  if (!userId) {
    res.status(401).json({ error: "Unauthorized" });
    return null;
  }
  const membership = await getSharedWorkspaceMembership(workspaceId, userId);
  if (!membership) {
    res.status(403).json(workspaceAccessDeniedBody());
    return null;
  }
  return membership;
}

function workspaceSopPayload(sop: VenomSop) {
  return {
    id: sop.id,
    title: sop.title,
    lifecycle: sop.lifecycle,
    category: sop.category,
    tags: sop.tags,
    provenance: sop.provenance,
    content: sop.content,
    activeRevisionId: sop.activeRevisionId ?? null,
    activeRevisionNumber: sop.activeRevisionNumber ?? null,
    sensitive: sop.sensitive === true,
    // Only admin responses ever carry a true value: restricted SOPs are
    // filtered out of member reads before this payload is built.
    adminOnly: sop.adminOnly === true,
    createdAt: sop.createdAt,
    updatedAt: sop.updatedAt,
  };
}

/**
 * Admin gate for member management and the security-settings routes.
 * Members without the admin role get `workspace_admin_required` —
 * deliberately NOT the access-denied code, which clients treat as
 * membership loss and answer with full cache eviction. A demotion must
 * never feel like removal. Non-members never reach the role check:
 * `requireMembership` already denied them with the opaque body.
 */
async function requireAdminMembership(
  req: Request,
  res: Parameters<Parameters<IRouter["get"]>[1]>[1],
  workspaceId: string,
): Promise<SharedWorkspaceMembership | null> {
  const membership = await requireMembership(req, res, workspaceId);
  if (!membership) return null;
  if (membership.role !== "admin") {
    res.status(403).json(workspaceAdminRequiredBody());
    return null;
  }
  return membership;
}

// ---------------------------------------------------------------------------
// POST /venom/workspaces — create a workspace, caller becomes first admin
// ---------------------------------------------------------------------------
router.post("/venom/workspaces", async (req, res): Promise<void> => {
  const userId = userIdFor(req);
  if (!userId) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  const parsed = CreateSharedWorkspaceBody.safeParse(req.body);
  const name = parsed.success ? parsed.data.name.trim() : "";
  if (!parsed.success || name.length === 0) {
    res.status(400).json({ error: "Workspace name is required" });
    return;
  }

  const [{ count: createdCount }] = await db
    .select({ count: sql<number>`COUNT(*)::int` })
    .from(venomSharedWorkspacesTable)
    .where(eq(venomSharedWorkspacesTable.createdByClerkUserId, userId));
  if (createdCount >= MAX_WORKSPACES_PER_CREATOR) {
    res.status(409).json({ error: "Workspace limit reached" });
    return;
  }

  const workspace = await db.transaction(async (tx) => {
    const [created] = await tx
      .insert(venomSharedWorkspacesTable)
      .values({ name, createdByClerkUserId: userId })
      .returning();
    await tx.insert(venomSharedWorkspaceMembersTable).values({
      workspaceId: created.id,
      clerkUserId: userId,
      role: "admin",
      addedByClerkUserId: userId,
    });
    return created;
  });

  req.log.info(
    { sharedWorkspaceId: workspace.id },
    "Shared workspace created",
  );
  res.status(201).json(
    CreateSharedWorkspaceResponse.parse({
      id: workspace.id,
      name: workspace.name,
      role: "admin",
      memberCount: 1,
      createdAt: workspace.createdAt,
    }),
  );
});

// ---------------------------------------------------------------------------
// GET /venom/workspaces — the caller's workspaces with role + member count
// ---------------------------------------------------------------------------
router.get("/venom/workspaces", async (req, res): Promise<void> => {
  const userId = userIdFor(req);
  if (!userId) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  const rows = await db
    .select({
      id: venomSharedWorkspacesTable.id,
      name: venomSharedWorkspacesTable.name,
      createdAt: venomSharedWorkspacesTable.createdAt,
      role: venomSharedWorkspaceMembersTable.role,
    })
    .from(venomSharedWorkspaceMembersTable)
    .innerJoin(
      venomSharedWorkspacesTable,
      eq(
        venomSharedWorkspaceMembersTable.workspaceId,
        venomSharedWorkspacesTable.id,
      ),
    )
    .where(eq(venomSharedWorkspaceMembersTable.clerkUserId, userId))
    .orderBy(asc(venomSharedWorkspacesTable.createdAt))
    .limit(200);

  const counts = await memberCounts(rows.map((row) => row.id));
  res.json(
    ListSharedWorkspacesResponse.parse(
      rows.map((row) => ({
        id: row.id,
        name: row.name,
        role: row.role,
        memberCount: counts.get(row.id) ?? 1,
        createdAt: row.createdAt,
      })),
    ),
  );
});

// ---------------------------------------------------------------------------
// GET /venom/workspaces/:workspaceId/members — members only
// ---------------------------------------------------------------------------
router.get(
  "/venom/workspaces/:workspaceId/members",
  async (req, res): Promise<void> => {
    const params = ListSharedWorkspaceMembersParams.safeParse(req.params);
    if (!params.success) {
      res.status(403).json(workspaceAccessDeniedBody());
      return;
    }
    const membership = await requireMembership(
      req,
      res,
      params.data.workspaceId,
    );
    if (!membership) return;

    const rows = await db
      .select()
      .from(venomSharedWorkspaceMembersTable)
      .where(
        eq(
          venomSharedWorkspaceMembersTable.workspaceId,
          membership.workspaceId,
        ),
      )
      .orderBy(asc(venomSharedWorkspaceMembersTable.addedAt))
      .limit(MAX_MEMBERS_PER_WORKSPACE);

    // Names are cosmetic; membership must not depend on the directory being up.
    let names = new Map<string, string | null>();
    try {
      names = await userDirectory.getUsers(rows.map((row) => row.clerkUserId));
    } catch (error) {
      req.log.warn(
        { err: error },
        "Shared workspace member name lookup failed",
      );
    }

    res.json(
      ListSharedWorkspaceMembersResponse.parse(
        rows.map((row) => ({
          userId: row.clerkUserId,
          role: row.role,
          name: names.get(row.clerkUserId) ?? null,
          addedAt: row.addedAt,
        })),
      ),
    );
  },
);

// ---------------------------------------------------------------------------
// POST /venom/workspaces/:workspaceId/members — admins only
// ---------------------------------------------------------------------------
router.post(
  "/venom/workspaces/:workspaceId/members",
  async (req, res): Promise<void> => {
    const params = AddSharedWorkspaceMemberParams.safeParse(req.params);
    if (!params.success) {
      res.status(403).json(workspaceAccessDeniedBody());
      return;
    }
    const membership = await requireAdminMembership(
      req,
      res,
      params.data.workspaceId,
    );
    if (!membership) return;

    const parsed = AddSharedWorkspaceMemberBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid member request" });
      return;
    }
    const targetUserId = parsed.data.userId.trim();
    const role: VenomSharedWorkspaceRole =
      parsed.data.role && VENOM_SHARED_WORKSPACE_ROLES.includes(parsed.data.role)
        ? parsed.data.role
        : "member";
    if (!targetUserId) {
      res.status(400).json({ error: "Invalid member request" });
      return;
    }

    const [{ count: currentCount }] = await db
      .select({ count: sql<number>`COUNT(*)::int` })
      .from(venomSharedWorkspaceMembersTable)
      .where(
        eq(
          venomSharedWorkspaceMembersTable.workspaceId,
          membership.workspaceId,
        ),
      );
    if (currentCount >= MAX_MEMBERS_PER_WORKSPACE) {
      res.status(409).json({ error: "Workspace member limit reached" });
      return;
    }

    // Fail closed: only accounts the directory can confirm may be added.
    let account: { id: string; name: string | null } | null;
    try {
      account = await userDirectory.getUser(targetUserId);
    } catch (error) {
      req.log.error(
        { err: error },
        "Shared workspace member account verification failed",
      );
      res
        .status(502)
        .json({ error: "Could not verify that account right now" });
      return;
    }
    if (!account) {
      res.status(404).json({ error: "No account matches that user ID" });
      return;
    }

    const [inserted] = await db
      .insert(venomSharedWorkspaceMembersTable)
      .values({
        workspaceId: membership.workspaceId,
        clerkUserId: account.id,
        role,
        addedByClerkUserId: userIdFor(req) ?? "",
      })
      .onConflictDoNothing()
      .returning();
    if (!inserted) {
      res.status(409).json({ error: "That account is already a member" });
      return;
    }

    req.log.info(
      { sharedWorkspaceId: membership.workspaceId, memberRole: role },
      "Shared workspace member added",
    );
    res.status(201).json(
      AddSharedWorkspaceMemberResponse.parse({
        userId: inserted.clerkUserId,
        role: inserted.role,
        name: account.name,
        addedAt: inserted.addedAt,
      }),
    );
  },
);

// ---------------------------------------------------------------------------
// PATCH /venom/workspaces/:workspaceId/members/:memberUserId — admins only
// Changes a member's role in place: no removal, so the member's access and
// device caches never lapse. Demoting the last admin is refused with the
// same 409 rule the remove path enforces.
// ---------------------------------------------------------------------------
router.patch(
  "/venom/workspaces/:workspaceId/members/:memberUserId",
  async (req, res): Promise<void> => {
    const params = UpdateSharedWorkspaceMemberRoleParams.safeParse(req.params);
    if (!params.success) {
      res.status(403).json(workspaceAccessDeniedBody());
      return;
    }
    const membership = await requireAdminMembership(
      req,
      res,
      params.data.workspaceId,
    );
    if (!membership) return;

    const parsed = UpdateSharedWorkspaceMemberRoleBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid role payload" });
      return;
    }
    const nextRole: VenomSharedWorkspaceRole = parsed.data.role;

    const actorUserId = userIdFor(req);
    if (!actorUserId) {
      // Unreachable after requireAdminMembership; kept for type safety.
      res.status(401).json({ error: "Authentication required" });
      return;
    }

    const targetUserId = params.data.memberUserId;
    const result = await db.transaction(async (tx) => {
      // Serialize admin-set mutations per workspace: without this, two
      // concurrent demotions/removals could each read an admin count of
      // two, both commit, and strand the workspace with zero admins.
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtext(${membership.workspaceId}))`,
      );
      // The admin gate ran before this transaction; the caller can have
      // been demoted or removed while parked at the lock. Re-check the
      // acting account under the same serialization before mutating.
      const [actor] = await tx
        .select({ role: venomSharedWorkspaceMembersTable.role })
        .from(venomSharedWorkspaceMembersTable)
        .where(
          and(
            eq(
              venomSharedWorkspaceMembersTable.workspaceId,
              membership.workspaceId,
            ),
            eq(venomSharedWorkspaceMembersTable.clerkUserId, actorUserId),
          ),
        )
        .limit(1);
      if (!actor) {
        return { status: 403 as const, stillMember: false };
      }
      if (actor.role !== "admin") {
        return { status: 403 as const, stillMember: true };
      }
      const [target] = await tx
        .select()
        .from(venomSharedWorkspaceMembersTable)
        .where(
          and(
            eq(
              venomSharedWorkspaceMembersTable.workspaceId,
              membership.workspaceId,
            ),
            eq(venomSharedWorkspaceMembersTable.clerkUserId, targetUserId),
          ),
        )
        .limit(1);
      if (!target) return { status: 404 as const };

      if (target.role === "admin" && nextRole !== "admin") {
        const [{ count: adminCount }] = await tx
          .select({ count: sql<number>`COUNT(*)::int` })
          .from(venomSharedWorkspaceMembersTable)
          .where(
            and(
              eq(
                venomSharedWorkspaceMembersTable.workspaceId,
                membership.workspaceId,
              ),
              eq(venomSharedWorkspaceMembersTable.role, "admin"),
            ),
          );
        if (adminCount <= 1) return { status: 409 as const };
      }

      const [updated] = await tx
        .update(venomSharedWorkspaceMembersTable)
        .set({ role: nextRole })
        .where(
          and(
            eq(
              venomSharedWorkspaceMembersTable.workspaceId,
              membership.workspaceId,
            ),
            eq(venomSharedWorkspaceMembersTable.clerkUserId, targetUserId),
          ),
        )
        .returning();
      return { status: 200 as const, member: updated };
    });

    if (result.status === 403) {
      res
        .status(403)
        .json(
          result.stillMember
            ? workspaceAdminRequiredBody()
            : workspaceAccessDeniedBody(),
        );
      return;
    }
    if (result.status === 404) {
      res.status(404).json({ error: "That account is not a member" });
      return;
    }
    if (result.status === 409) {
      res.status(409).json({ error: "The last admin cannot be demoted" });
      return;
    }

    // Names are cosmetic; a role change must not depend on the directory.
    let name: string | null = null;
    try {
      const names = await userDirectory.getUsers([result.member.clerkUserId]);
      name = names.get(result.member.clerkUserId) ?? null;
    } catch (error) {
      req.log.warn(
        { err: error },
        "Shared workspace member name lookup failed",
      );
    }

    req.log.info(
      { sharedWorkspaceId: membership.workspaceId, memberRole: nextRole },
      "Shared workspace member role updated",
    );
    res.json(
      UpdateSharedWorkspaceMemberRoleResponse.parse({
        userId: result.member.clerkUserId,
        role: result.member.role,
        name,
        addedAt: result.member.addedAt,
      }),
    );
  },
);

// ---------------------------------------------------------------------------
// DELETE /venom/workspaces/:workspaceId/members/:memberUserId — admins only
// ---------------------------------------------------------------------------
router.delete(
  "/venom/workspaces/:workspaceId/members/:memberUserId",
  async (req, res): Promise<void> => {
    const params = RemoveSharedWorkspaceMemberParams.safeParse(req.params);
    if (!params.success) {
      res.status(403).json(workspaceAccessDeniedBody());
      return;
    }
    const membership = await requireAdminMembership(
      req,
      res,
      params.data.workspaceId,
    );
    if (!membership) return;

    const actorUserId = userIdFor(req);
    if (!actorUserId) {
      // Unreachable after requireAdminMembership; kept for type safety.
      res.status(401).json({ error: "Authentication required" });
      return;
    }

    const targetUserId = params.data.memberUserId;
    const removed = await db.transaction(async (tx) => {
      // Serialized with the role-change transaction (see the PATCH route):
      // concurrent admin-removing mutations must re-read the admin count
      // one at a time or two "last admins" could both leave.
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtext(${membership.workspaceId}))`,
      );
      // The admin gate ran before this transaction; re-check the acting
      // account under the lock so a just-demoted or just-removed admin
      // cannot complete an already-authorized removal.
      const [actor] = await tx
        .select({ role: venomSharedWorkspaceMembersTable.role })
        .from(venomSharedWorkspaceMembersTable)
        .where(
          and(
            eq(
              venomSharedWorkspaceMembersTable.workspaceId,
              membership.workspaceId,
            ),
            eq(venomSharedWorkspaceMembersTable.clerkUserId, actorUserId),
          ),
        )
        .limit(1);
      if (!actor) {
        return { status: 403 as const, stillMember: false };
      }
      if (actor.role !== "admin") {
        return { status: 403 as const, stillMember: true };
      }
      const [target] = await tx
        .select()
        .from(venomSharedWorkspaceMembersTable)
        .where(
          and(
            eq(
              venomSharedWorkspaceMembersTable.workspaceId,
              membership.workspaceId,
            ),
            eq(venomSharedWorkspaceMembersTable.clerkUserId, targetUserId),
          ),
        )
        .limit(1);
      if (!target) return { status: 404 as const };

      if (target.role === "admin") {
        const [{ count: adminCount }] = await tx
          .select({ count: sql<number>`COUNT(*)::int` })
          .from(venomSharedWorkspaceMembersTable)
          .where(
            and(
              eq(
                venomSharedWorkspaceMembersTable.workspaceId,
                membership.workspaceId,
              ),
              eq(venomSharedWorkspaceMembersTable.role, "admin"),
            ),
          );
        if (adminCount <= 1) return { status: 409 as const };
      }

      await tx
        .delete(venomSharedWorkspaceMembersTable)
        .where(
          and(
            eq(
              venomSharedWorkspaceMembersTable.workspaceId,
              membership.workspaceId,
            ),
            eq(venomSharedWorkspaceMembersTable.clerkUserId, targetUserId),
          ),
        );
      return { status: 200 as const };
    });

    if (removed.status === 403) {
      res
        .status(403)
        .json(
          removed.stillMember
            ? workspaceAdminRequiredBody()
            : workspaceAccessDeniedBody(),
        );
      return;
    }
    if (removed.status === 404) {
      res.status(404).json({ error: "That account is not a member" });
      return;
    }
    if (removed.status === 409) {
      res
        .status(409)
        .json({ error: "The last admin cannot be removed" });
      return;
    }

    req.log.info(
      { sharedWorkspaceId: membership.workspaceId },
      "Shared workspace member removed",
    );
    res.json(
      RemoveSharedWorkspaceMemberResponse.parse({
        removedUserId: targetUserId,
      }),
    );
  },
);

// ---------------------------------------------------------------------------
// GET /venom/workspaces/:workspaceId/knowledge — members only
// ---------------------------------------------------------------------------
router.get(
  "/venom/workspaces/:workspaceId/knowledge",
  async (req, res): Promise<void> => {
    const params = GetSharedWorkspaceKnowledgeParams.safeParse(req.params);
    if (!params.success) {
      res.status(403).json(workspaceAccessDeniedBody());
      return;
    }
    const membership = await requireMembership(
      req,
      res,
      params.data.workspaceId,
    );
    if (!membership) return;

    const concepts = await loadOntologyConcepts(
      workspaceOwner(membership.workspaceId),
    );
    // Admin-only clusters are dropped server-side for members, the same
    // per-request pattern as the membership check itself: a member's
    // response never contains the restricted record at all. Unsorted is an
    // author-private personal state — workspace rows never carry it, but if
    // one ever slipped through a write path it must not surface here.
    const visible = (
      membership.role === "admin"
        ? concepts
        : concepts.filter((concept) => concept.adminOnly !== true)
    ).filter((concept) => concept.unsorted !== true);
    const clusters = [...visible].sort(
      (a, b) => b.strength - a.strength || b.lastUpdatedAt - a.lastUpdatedAt,
    );
    res.json(GetSharedWorkspaceKnowledgeResponse.parse({ clusters }));
  },
);

// ---------------------------------------------------------------------------
// Workspace SOPs (members only; stored under the workspace owner key)
// ---------------------------------------------------------------------------

function rejectUnsafeContent(
  title: string,
  category: string,
  tags: string[],
  content: Parameters<typeof flattenSopContent>[0],
): string | null {
  const blob = flattenSopContent(content, title, category, tags);
  const result = checkSopContentSafety(blob);
  if (!result.ok) return result.reason;
  return null;
}

router.get(
  "/venom/workspaces/:workspaceId/sops",
  async (req, res): Promise<void> => {
    const params = ListSharedWorkspaceSopsParams.safeParse(req.params);
    if (!params.success) {
      res.status(403).json(workspaceAccessDeniedBody());
      return;
    }
    const membership = await requireMembership(
      req,
      res,
      params.data.workspaceId,
    );
    if (!membership) return;

    const sops = await db
      .select()
      .from(venomSopsTable)
      .where(
        and(
          eq(
            venomSopsTable.clerkUserId,
            workspaceSopOwnerKey(membership.workspaceId),
          ),
          // Admin-only SOPs are filtered server-side for members, per
          // request, exactly like the membership check.
          ...(membership.role === "admin"
            ? []
            : [eq(venomSopsTable.adminOnly, false)]),
        ),
      )
      .orderBy(desc(venomSopsTable.updatedAt))
      .limit(500);

    res.json(
      ListSharedWorkspaceSopsResponse.parse(sops.map(workspaceSopPayload)),
    );
  },
);

router.post(
  "/venom/workspaces/:workspaceId/sops",
  async (req, res): Promise<void> => {
    const params = CreateSharedWorkspaceSopParams.safeParse(req.params);
    if (!params.success) {
      res.status(403).json(workspaceAccessDeniedBody());
      return;
    }
    const membership = await requireMembership(
      req,
      res,
      params.data.workspaceId,
    );
    if (!membership) return;

    const parsed = CreateSharedWorkspaceSopBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid SOP data" });
      return;
    }

    const { title, category, tags, provenance, content } = parsed.data;
    const unsafeReason = rejectUnsafeContent(title, category, tags, content);
    if (unsafeReason) {
      req.log.warn(
        { sopRejectionReason: unsafeReason },
        "Workspace SOP content rejected by safety check",
      );
      res
        .status(400)
        .json({ error: "SOP content contains disallowed sensitive data" });
      return;
    }

    const [sop] = await db
      .insert(venomSopsTable)
      .values({
        clerkUserId: workspaceSopOwnerKey(membership.workspaceId),
        title: title.trim(),
        category,
        tags,
        provenance,
        content,
        lifecycle: "draft",
      })
      .returning();

    req.log.info(
      { sopId: sop.id, sharedWorkspaceId: membership.workspaceId },
      "Workspace SOP created",
    );
    res
      .status(201)
      .json(CreateSharedWorkspaceSopResponse.parse(workspaceSopPayload(sop)));
  },
);

router.post(
  "/venom/workspaces/:workspaceId/sops/:sopId/publish",
  async (req, res): Promise<void> => {
    const params = PublishSharedWorkspaceSopParams.safeParse(req.params);
    if (!params.success) {
      res.status(403).json(workspaceAccessDeniedBody());
      return;
    }
    const membership = await requireMembership(
      req,
      res,
      params.data.workspaceId,
    );
    if (!membership) return;

    const ownerKey = workspaceSopOwnerKey(membership.workspaceId);
    const [sop] = await db
      .select()
      .from(venomSopsTable)
      .where(
        and(
          eq(venomSopsTable.id, params.data.sopId),
          eq(venomSopsTable.clerkUserId, ownerKey),
        ),
      )
      .limit(1);
    // A restricted SOP simply does not exist for members — the same 404 an
    // unknown id gets, so the response leaks nothing about it.
    if (!sop || (sop.adminOnly && membership.role !== "admin")) {
      res.status(404).json({ error: "SOP not found" });
      return;
    }
    if (sop.lifecycle === "archived") {
      res.status(409).json({ error: "Archived SOPs cannot be published" });
      return;
    }

    const unsafeReason = rejectUnsafeContent(
      sop.title,
      sop.category,
      sop.tags,
      sop.content,
    );
    if (unsafeReason) {
      req.log.warn(
        { sopId: sop.id, sopRejectionReason: unsafeReason },
        "Workspace SOP publish rejected by safety check",
      );
      res
        .status(400)
        .json({ error: "SOP content contains disallowed sensitive data" });
      return;
    }

    const checksum = createHash("sha256")
      .update(
        JSON.stringify({
          title: sop.title,
          category: sop.category,
          tags: [...sop.tags].sort(),
          provenance: sop.provenance,
          content: sop.content,
        }),
      )
      .digest("hex");
    const lockKey = BigInt(
      "0x" + createHash("sha256").update(sop.id).digest("hex").slice(0, 15),
    );

    const revision = await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(${lockKey})`);
      const [maxRow] = await tx
        .select({
          max: sql<number>`COALESCE(MAX(${venomSopRevisionsTable.versionNumber}), 0)`,
        })
        .from(venomSopRevisionsTable)
        .where(eq(venomSopRevisionsTable.sopId, sop.id));
      const nextVersion = (maxRow?.max ?? 0) + 1;

      const [rev] = await tx
        .insert(venomSopRevisionsTable)
        .values({
          sopId: sop.id,
          clerkUserId: ownerKey,
          versionNumber: nextVersion,
          title: sop.title,
          category: sop.category,
          tags: sop.tags,
          provenance: sop.provenance,
          content: sop.content,
          checksumSha256: checksum,
        })
        .returning();

      await tx
        .update(venomSopsTable)
        .set({
          lifecycle: "active",
          activeRevisionId: rev.id,
          activeRevisionNumber: rev.versionNumber,
        })
        .where(
          and(
            eq(venomSopsTable.id, sop.id),
            eq(venomSopsTable.clerkUserId, ownerKey),
          ),
        );
      return rev;
    });

    req.log.info(
      {
        sopId: sop.id,
        revisionId: revision.id,
        versionNumber: revision.versionNumber,
        sharedWorkspaceId: membership.workspaceId,
      },
      "Workspace SOP revision published",
    );
    res.json(
      PublishSharedWorkspaceSopResponse.parse({
        id: revision.id,
        versionNumber: revision.versionNumber,
        provenance: revision.provenance,
        checksumSha256: revision.checksumSha256,
        title: revision.title,
        category: revision.category,
        tags: revision.tags,
        content: revision.content,
        publishedAt: revision.publishedAt,
      }),
    );
  },
);

// ---------------------------------------------------------------------------
// Workspace security settings (admins only)
// ---------------------------------------------------------------------------

router.get(
  "/venom/workspaces/:workspaceId/settings",
  async (req, res): Promise<void> => {
    const params = GetSharedWorkspaceSettingsParams.safeParse(req.params);
    if (!params.success) {
      res.status(403).json(workspaceAccessDeniedBody());
      return;
    }
    const membership = await requireAdminMembership(
      req,
      res,
      params.data.workspaceId,
    );
    if (!membership) return;

    const [workspace] = await db
      .select({
        allowSensitiveExport: venomSharedWorkspacesTable.allowSensitiveExport,
      })
      .from(venomSharedWorkspacesTable)
      .where(eq(venomSharedWorkspacesTable.id, membership.workspaceId))
      .limit(1);
    if (!workspace) {
      res.status(403).json(workspaceAccessDeniedBody());
      return;
    }
    res.json(
      GetSharedWorkspaceSettingsResponse.parse({
        allowSensitiveExport: workspace.allowSensitiveExport,
      }),
    );
  },
);

router.put(
  "/venom/workspaces/:workspaceId/settings",
  async (req, res): Promise<void> => {
    const params = UpdateSharedWorkspaceSettingsParams.safeParse(req.params);
    if (!params.success) {
      res.status(403).json(workspaceAccessDeniedBody());
      return;
    }
    const membership = await requireAdminMembership(
      req,
      res,
      params.data.workspaceId,
    );
    if (!membership) return;

    const parsed = UpdateSharedWorkspaceSettingsBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid settings payload" });
      return;
    }

    const [updated] = await db
      .update(venomSharedWorkspacesTable)
      .set({ allowSensitiveExport: parsed.data.allowSensitiveExport })
      .where(eq(venomSharedWorkspacesTable.id, membership.workspaceId))
      .returning({
        allowSensitiveExport: venomSharedWorkspacesTable.allowSensitiveExport,
      });
    if (!updated) {
      res.status(403).json(workspaceAccessDeniedBody());
      return;
    }

    req.log.info(
      {
        sharedWorkspaceId: membership.workspaceId,
        allowSensitiveExport: updated.allowSensitiveExport,
      },
      "Workspace export policy updated",
    );
    res.json(
      UpdateSharedWorkspaceSettingsResponse.parse({
        allowSensitiveExport: updated.allowSensitiveExport,
      }),
    );
  },
);

// ---------------------------------------------------------------------------
// Workspace AI spend & model controls (admins only)
//
// Everything below concerns ONLY usage billed to this workspace's
// Organization plan. Members' personal-space usage and settings are
// structurally out of reach: usage reads filter on the ledger's payer
// stamp, and the controls bind at admission/dispatch time only when the
// workspace is the resolved payer. Members learn cap and lock *state*
// through the billing context; the dollar figures below are admin-only.
// ---------------------------------------------------------------------------

/** The admin controls payload the GET and every controls write return. */
async function aiControlsPayload(workspaceId: string): Promise<{
  defaultMemberCapUsd: number | null;
  forcedSelectionPolicy: "auto-cheapest" | "auto-max-power" | null;
  allowedCostTiers: ("$" | "$$" | "$$$")[] | null;
  memberOverrides: Array<{
    clerkUserId: string;
    name: string;
    capUsd: number | null;
  }>;
}> {
  const [controls, overrides] = await Promise.all([
    loadWorkspaceAiControls(workspaceId),
    listMemberAiCapOverrides(workspaceId),
  ]);
  // Names are cosmetic; controls must not depend on the directory being up.
  let names = new Map<string, string | null>();
  try {
    names = await userDirectory.getUsers(
      overrides.map((override) => override.clerkUserId),
    );
  } catch {
    // Ids still identify the rows.
  }
  return {
    defaultMemberCapUsd:
      controls.defaultMemberCapMicros === null
        ? null
        : aiControlMicrosToUsd(controls.defaultMemberCapMicros),
    forcedSelectionPolicy: controls.forcedSelectionPolicy,
    allowedCostTiers: controls.allowedCostTiers
      ? [...controls.allowedCostTiers]
      : null,
    memberOverrides: overrides
      .map((override) => ({
        clerkUserId: override.clerkUserId,
        name: names.get(override.clerkUserId) ?? override.clerkUserId,
        capUsd:
          override.capMicros === null
            ? null
            : aiControlMicrosToUsd(override.capMicros),
      }))
      .sort((a, b) => a.name.localeCompare(b.name)),
  };
}

router.get(
  "/venom/workspaces/:workspaceId/ai-controls",
  async (req, res): Promise<void> => {
    const params = GetSharedWorkspaceAiControlsParams.safeParse(req.params);
    if (!params.success) {
      res.status(403).json(workspaceAccessDeniedBody());
      return;
    }
    const membership = await requireAdminMembership(
      req,
      res,
      params.data.workspaceId,
    );
    if (!membership) return;
    res.json(
      GetSharedWorkspaceAiControlsResponse.parse(
        await aiControlsPayload(membership.workspaceId),
      ),
    );
  },
);

router.put(
  "/venom/workspaces/:workspaceId/ai-controls",
  async (req, res): Promise<void> => {
    const params = UpdateSharedWorkspaceAiControlsParams.safeParse(req.params);
    if (!params.success) {
      res.status(403).json(workspaceAccessDeniedBody());
      return;
    }
    const membership = await requireAdminMembership(
      req,
      res,
      params.data.workspaceId,
    );
    if (!membership) return;
    const userId = userIdFor(req);
    if (!userId) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }

    const parsed = UpdateSharedWorkspaceAiControlsBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid controls payload" });
      return;
    }
    // Full-replace semantics: what arrives is exactly what stands. The
    // schema already rejects "manual" as a forced policy and empty tier
    // lists; normalization additionally collapses "every tier" to null so
    // an all-checked lock isn't stored as a restriction.
    await saveWorkspaceAiControls(
      membership.workspaceId,
      {
        defaultMemberCapMicros:
          parsed.data.defaultMemberCapUsd === null
            ? null
            : aiControlUsdToMicros(parsed.data.defaultMemberCapUsd),
        forcedSelectionPolicy: parsed.data.forcedSelectionPolicy,
        allowedCostTiers: normalizeAllowedCostTiers(
          parsed.data.allowedCostTiers,
        ),
      },
      userId,
    );

    req.log.info(
      { sharedWorkspaceId: membership.workspaceId },
      "Workspace AI controls updated",
    );
    res.json(
      UpdateSharedWorkspaceAiControlsResponse.parse(
        await aiControlsPayload(membership.workspaceId),
      ),
    );
  },
);

router.put(
  "/venom/workspaces/:workspaceId/ai-controls/members/:memberUserId",
  async (req, res): Promise<void> => {
    const params = SetSharedWorkspaceMemberAiCapParams.safeParse(req.params);
    if (!params.success) {
      res.status(403).json(workspaceAccessDeniedBody());
      return;
    }
    const membership = await requireAdminMembership(
      req,
      res,
      params.data.workspaceId,
    );
    if (!membership) return;
    const userId = userIdFor(req);
    if (!userId) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }

    const parsed = SetSharedWorkspaceMemberAiCapBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid cap payload" });
      return;
    }
    // Overrides are for people currently in the workspace; a removed
    // member's stale row is harmless but must not be creatable.
    const target = await getSharedWorkspaceMembership(
      membership.workspaceId,
      params.data.memberUserId,
    );
    if (!target) {
      res
        .status(404)
        .json({ error: "That account is not a member of this workspace" });
      return;
    }

    await setMemberAiCapOverride(
      membership.workspaceId,
      params.data.memberUserId,
      parsed.data.capUsd === null
        ? null
        : aiControlUsdToMicros(parsed.data.capUsd),
      userId,
    );
    req.log.info(
      { sharedWorkspaceId: membership.workspaceId },
      "Workspace member AI cap set",
    );
    res.json(
      SetSharedWorkspaceMemberAiCapResponse.parse(
        await aiControlsPayload(membership.workspaceId),
      ),
    );
  },
);

router.delete(
  "/venom/workspaces/:workspaceId/ai-controls/members/:memberUserId",
  async (req, res): Promise<void> => {
    const params = ClearSharedWorkspaceMemberAiCapParams.safeParse(req.params);
    if (!params.success) {
      res.status(403).json(workspaceAccessDeniedBody());
      return;
    }
    const membership = await requireAdminMembership(
      req,
      res,
      params.data.workspaceId,
    );
    if (!membership) return;

    // Idempotent: clearing an absent override (or one left by a removed
    // member) simply lands on "workspace default".
    await clearMemberAiCapOverride(
      membership.workspaceId,
      params.data.memberUserId,
    );
    req.log.info(
      { sharedWorkspaceId: membership.workspaceId },
      "Workspace member AI cap cleared",
    );
    res.json(
      ClearSharedWorkspaceMemberAiCapResponse.parse(
        await aiControlsPayload(membership.workspaceId),
      ),
    );
  },
);

router.get(
  "/venom/workspaces/:workspaceId/usage",
  async (req, res): Promise<void> => {
    const params = GetSharedWorkspaceUsageParams.safeParse(req.params);
    if (!params.success) {
      res.status(403).json(workspaceAccessDeniedBody());
      return;
    }
    const membership = await requireAdminMembership(
      req,
      res,
      params.data.workspaceId,
    );
    if (!membership) return;

    try {
      const account = await getBillingAccount(
        "workspace",
        membership.workspaceId,
      );
      const plan = venomPlan("org");
      const period = billingPeriodFor(account, new Date());
      const [byMember, memberRows, controls, overrides] = await Promise.all([
        sumWorkspaceBilledMicrosByMember(membership.workspaceId, period),
        db
          .select({
            clerkUserId: venomSharedWorkspaceMembersTable.clerkUserId,
            role: venomSharedWorkspaceMembersTable.role,
          })
          .from(venomSharedWorkspaceMembersTable)
          .where(
            eq(
              venomSharedWorkspaceMembersTable.workspaceId,
              membership.workspaceId,
            ),
          ),
        loadWorkspaceAiControls(membership.workspaceId),
        listMemberAiCapOverrides(membership.workspaceId),
      ]);
      // Names are cosmetic; the summary must not depend on the directory.
      let names = new Map<string, string | null>();
      try {
        names = await userDirectory.getUsers(
          memberRows.map((row) => row.clerkUserId),
        );
      } catch {
        // Ids still identify the rows.
      }
      const overrideByMember = new Map(
        overrides.map((override) => [override.clerkUserId, override]),
      );
      const warnRatio = approachingWarnRatio();
      const members = memberRows
        .map((row) => {
          const spentMicros = byMember.get(row.clerkUserId) ?? 0;
          const override = overrideByMember.get(row.clerkUserId) ?? null;
          const capMicros = override
            ? override.capMicros
            : controls.defaultMemberCapMicros;
          const capSource: "default" | "override" | null = override
            ? "override"
            : controls.defaultMemberCapMicros !== null
              ? "default"
              : null;
          const capState =
            capMicros === null
              ? ("ok" as const)
              : spentMicros >= capMicros
                ? ("exhausted" as const)
                : spentMicros >= capMicros * warnRatio
                  ? ("approaching" as const)
                  : ("ok" as const);
          return {
            clerkUserId: row.clerkUserId,
            name: names.get(row.clerkUserId) ?? row.clerkUserId,
            role: row.role,
            spentUsd: aiControlMicrosToUsd(spentMicros),
            capUsd: capMicros === null ? null : aiControlMicrosToUsd(capMicros),
            ...(capSource ? { capSource } : {}),
            capState,
            spentMicros,
          };
        })
        .sort(
          (a, b) =>
            b.spentMicros - a.spentMicros || a.name.localeCompare(b.name),
        )
        .map(({ spentMicros: _spentMicros, ...member }) => member);
      // The total sums every billed row this period — including ones from
      // since-removed members — so it always matches what the plan spent.
      let totalMicros = 0;
      for (const micros of byMember.values()) totalMicros += micros;
      res.json(
        GetSharedWorkspaceUsageResponse.parse({
          covered: workspaceOrgPlanActive(account),
          periodStart: period.start.toISOString(),
          periodEnd: period.end.toISOString(),
          totalUsd: aiControlMicrosToUsd(totalMicros),
          allowanceUsd: aiControlMicrosToUsd(planAllowanceMicros(plan)),
          members,
        }),
      );
    } catch (error) {
      req.log.error({ err: error }, "Workspace usage summary failed");
      res.status(500).json({ error: "Usage is unavailable right now" });
    }
  },
);

// ---------------------------------------------------------------------------
// Sensitivity locks (any member may lock or unlock)
// ---------------------------------------------------------------------------

router.patch(
  "/venom/workspaces/:workspaceId/knowledge/:conceptId/sensitivity",
  async (req, res): Promise<void> => {
    const params = SetSharedWorkspaceConceptSensitivityParams.safeParse(
      req.params,
    );
    if (!params.success) {
      res.status(403).json(workspaceAccessDeniedBody());
      return;
    }
    const membership = await requireMembership(
      req,
      res,
      params.data.workspaceId,
    );
    if (!membership) return;

    const parsed = SetSharedWorkspaceConceptSensitivityBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid sensitivity payload" });
      return;
    }

    const owner = workspaceOwner(membership.workspaceId);
    // A restricted cluster simply does not exist for members — the same 404
    // an unknown id gets, so a member can neither see nor relabel it.
    const existing = await loadOntologyConcept(owner, params.data.conceptId);
    if (
      !existing ||
      (existing.adminOnly === true && membership.role !== "admin")
    ) {
      res.status(404).json({ error: "Knowledge cluster not found" });
      return;
    }
    const changed = await setOntologyConceptSensitivity(
      owner,
      params.data.conceptId,
      parsed.data.sensitive,
    );
    const cluster = changed
      ? await loadOntologyConcept(owner, params.data.conceptId)
      : null;
    if (!cluster) {
      res.status(404).json({ error: "Knowledge cluster not found" });
      return;
    }

    req.log.info(
      {
        sharedWorkspaceId: membership.workspaceId,
        conceptId: params.data.conceptId,
        sensitive: parsed.data.sensitive,
      },
      "Workspace knowledge sensitivity updated",
    );
    res.json(SetSharedWorkspaceConceptSensitivityResponse.parse(cluster));
  },
);

router.patch(
  "/venom/workspaces/:workspaceId/knowledge/:conceptId/evidence/:conversationId/sensitivity",
  async (req, res): Promise<void> => {
    const params = SetSharedWorkspaceEvidenceSensitivityParams.safeParse(
      req.params,
    );
    if (!params.success) {
      res.status(403).json(workspaceAccessDeniedBody());
      return;
    }
    const membership = await requireMembership(
      req,
      res,
      params.data.workspaceId,
    );
    if (!membership) return;

    const parsed = SetSharedWorkspaceEvidenceSensitivityBody.safeParse(
      req.body,
    );
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid sensitivity payload" });
      return;
    }

    const owner = workspaceOwner(membership.workspaceId);
    // Evidence rides its cluster: restricted for members means the whole
    // cluster (evidence included) does not exist for them.
    const existing = await loadOntologyConcept(owner, params.data.conceptId);
    if (
      !existing ||
      (existing.adminOnly === true && membership.role !== "admin")
    ) {
      res.status(404).json({ error: "Evidence entry not found" });
      return;
    }
    const changed = await setOntologyEvidenceSensitivity(
      owner,
      params.data.conceptId,
      params.data.conversationId,
      parsed.data.sensitive,
    );
    const cluster = changed
      ? await loadOntologyConcept(owner, params.data.conceptId)
      : null;
    if (!cluster) {
      res.status(404).json({ error: "Evidence entry not found" });
      return;
    }

    req.log.info(
      {
        sharedWorkspaceId: membership.workspaceId,
        conceptId: params.data.conceptId,
        conversationId: params.data.conversationId,
        sensitive: parsed.data.sensitive,
      },
      "Workspace evidence sensitivity updated",
    );
    res.json(SetSharedWorkspaceEvidenceSensitivityResponse.parse(cluster));
  },
);

router.patch(
  "/venom/workspaces/:workspaceId/sops/:sopId/sensitivity",
  async (req, res): Promise<void> => {
    const params = SetSharedWorkspaceSopSensitivityParams.safeParse(req.params);
    if (!params.success) {
      res.status(403).json(workspaceAccessDeniedBody());
      return;
    }
    const membership = await requireMembership(
      req,
      res,
      params.data.workspaceId,
    );
    if (!membership) return;

    const parsed = SetSharedWorkspaceSopSensitivityBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid sensitivity payload" });
      return;
    }

    // Deliberately no updatedAt bump: a lock is metadata about the SOP, not
    // an edit, so it must not reshuffle recency-ordered lists. The column
    // carries an $onUpdate default that fires whenever it is omitted from
    // set(), so it is pinned to its current value explicitly. For members
    // the WHERE clause also skips restricted SOPs, so those fall into the
    // same 404 as an unknown id.
    const [updated] = await db
      .update(venomSopsTable)
      .set({
        sensitive: parsed.data.sensitive,
        updatedAt: sql`${venomSopsTable.updatedAt}`,
      })
      .where(
        and(
          eq(venomSopsTable.id, params.data.sopId),
          eq(
            venomSopsTable.clerkUserId,
            workspaceSopOwnerKey(membership.workspaceId),
          ),
          ...(membership.role === "admin"
            ? []
            : [eq(venomSopsTable.adminOnly, false)]),
        ),
      )
      .returning();
    if (!updated) {
      res.status(404).json({ error: "SOP not found" });
      return;
    }

    req.log.info(
      {
        sharedWorkspaceId: membership.workspaceId,
        sopId: updated.id,
        sensitive: parsed.data.sensitive,
      },
      "Workspace SOP sensitivity updated",
    );
    res.json(
      SetSharedWorkspaceSopSensitivityResponse.parse(
        workspaceSopPayload(updated),
      ),
    );
  },
);

// ---------------------------------------------------------------------------
// Admin-only restrictions (only admins may set or clear; restricted items
// never reach non-admin members through any read, chat, or export path)
// ---------------------------------------------------------------------------

router.patch(
  "/venom/workspaces/:workspaceId/knowledge/:conceptId/restriction",
  async (req, res): Promise<void> => {
    const params = SetSharedWorkspaceConceptRestrictionParams.safeParse(
      req.params,
    );
    if (!params.success) {
      res.status(403).json(workspaceAccessDeniedBody());
      return;
    }
    const membership = await requireAdminMembership(
      req,
      res,
      params.data.workspaceId,
    );
    if (!membership) return;

    const parsed = SetSharedWorkspaceConceptRestrictionBody.safeParse(
      req.body,
    );
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid restriction payload" });
      return;
    }

    const owner = workspaceOwner(membership.workspaceId);
    const changed = await setOntologyConceptRestriction(
      owner,
      params.data.conceptId,
      parsed.data.adminOnly,
    );
    const cluster = changed
      ? await loadOntologyConcept(owner, params.data.conceptId)
      : null;
    if (!cluster) {
      res.status(404).json({ error: "Knowledge cluster not found" });
      return;
    }

    req.log.info(
      {
        sharedWorkspaceId: membership.workspaceId,
        conceptId: params.data.conceptId,
        adminOnly: parsed.data.adminOnly,
      },
      "Workspace knowledge restriction updated",
    );
    res.json(SetSharedWorkspaceConceptRestrictionResponse.parse(cluster));
  },
);

router.patch(
  "/venom/workspaces/:workspaceId/sops/:sopId/restriction",
  async (req, res): Promise<void> => {
    const params = SetSharedWorkspaceSopRestrictionParams.safeParse(req.params);
    if (!params.success) {
      res.status(403).json(workspaceAccessDeniedBody());
      return;
    }
    const membership = await requireAdminMembership(
      req,
      res,
      params.data.workspaceId,
    );
    if (!membership) return;

    const parsed = SetSharedWorkspaceSopRestrictionBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid restriction payload" });
      return;
    }

    // Same contract as the sensitivity lock: metadata, not an edit, so no
    // updatedAt bump and no reshuffling of recency-ordered lists. updatedAt
    // is pinned explicitly because its $onUpdate default fires whenever the
    // column is omitted from set().
    const [updated] = await db
      .update(venomSopsTable)
      .set({
        adminOnly: parsed.data.adminOnly,
        updatedAt: sql`${venomSopsTable.updatedAt}`,
      })
      .where(
        and(
          eq(venomSopsTable.id, params.data.sopId),
          eq(
            venomSopsTable.clerkUserId,
            workspaceSopOwnerKey(membership.workspaceId),
          ),
        ),
      )
      .returning();
    if (!updated) {
      res.status(404).json({ error: "SOP not found" });
      return;
    }

    req.log.info(
      {
        sharedWorkspaceId: membership.workspaceId,
        sopId: updated.id,
        adminOnly: parsed.data.adminOnly,
      },
      "Workspace SOP restriction updated",
    );
    res.json(
      SetSharedWorkspaceSopRestrictionResponse.parse(
        workspaceSopPayload(updated),
      ),
    );
  },
);

// ---------------------------------------------------------------------------
// GET /venom/workspaces/:workspaceId/export/:kind — markdown download
// (members only; the workspace's export policy is enforced right here)
// ---------------------------------------------------------------------------

router.get(
  "/venom/workspaces/:workspaceId/export/:kind",
  async (req, res): Promise<void> => {
    const params = ExportSharedWorkspaceMarkdownParams.safeParse(req.params);
    if (!params.success) {
      res.status(403).json(workspaceAccessDeniedBody());
      return;
    }
    const membership = await requireMembership(
      req,
      res,
      params.data.workspaceId,
    );
    if (!membership) return;

    const [workspace] = await db
      .select({
        name: venomSharedWorkspacesTable.name,
        allowSensitiveExport: venomSharedWorkspacesTable.allowSensitiveExport,
      })
      .from(venomSharedWorkspacesTable)
      .where(eq(venomSharedWorkspacesTable.id, membership.workspaceId))
      .limit(1);
    if (!workspace) {
      res.status(403).json(workspaceAccessDeniedBody());
      return;
    }

    const options = {
      scopeTitle: `Workspace "${workspace.name}"`,
      allowSensitive: workspace.allowSensitiveExport,
      // Admin-only items leave the workspace only in an admin's export;
      // a member's file states how many were withheld.
      includeRestricted: membership.role === "admin",
    };
    let result;
    if (params.data.kind === "brain") {
      const clusters = await loadOntologyConcepts(
        workspaceOwner(membership.workspaceId),
      );
      result = knowledgeMarkdown(clusters, options);
    } else {
      const sops = await db
        .select()
        .from(venomSopsTable)
        .where(
          eq(
            venomSopsTable.clerkUserId,
            workspaceSopOwnerKey(membership.workspaceId),
          ),
        )
        .orderBy(desc(venomSopsTable.updatedAt))
        .limit(500);
      result = sopsMarkdown(
        sops.filter((sop) => sop.lifecycle !== "archived"),
        options,
      );
    }

    req.log.info(
      {
        sharedWorkspaceId: membership.workspaceId,
        exportKind: params.data.kind,
        withheldCount: result.withheldCount,
        restrictedWithheldCount: result.restrictedWithheldCount,
        allowSensitiveExport: workspace.allowSensitiveExport,
      },
      "Workspace markdown export generated",
    );
    res.setHeader("Content-Type", "text/markdown; charset=utf-8");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${exportFileName(workspace.name, params.data.kind)}"`,
    );
    res.send(result.markdown);
  },
);

export default router;
