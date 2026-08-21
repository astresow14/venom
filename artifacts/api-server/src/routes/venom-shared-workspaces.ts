/**
 * Shared (multi-user) workspace routes: workspace records, membership with
 * admin/member roles, and the membership-checked reads that serve
 * workspace-tier knowledge and SOPs.
 *
 * Access rules:
 * - Every workspace-scoped route re-checks the caller's CURRENT membership;
 *   a removed member is denied (403 workspace_access_denied) on their next
 *   request, which is also the client's signal to evict cached content.
 * - Only admins add or remove members. The last admin can never be removed.
 * - Workspace content is served exclusively from these authenticated
 *   endpoints; it never rides the per-user sync snapshot.
 */

import { createHash } from "node:crypto";
import { clerkClient, getAuth } from "@clerk/express";
import {
  AddSharedWorkspaceMemberBody,
  AddSharedWorkspaceMemberParams,
  AddSharedWorkspaceMemberResponse,
  CreateSharedWorkspaceBody,
  CreateSharedWorkspaceResponse,
  CreateSharedWorkspaceSopBody,
  CreateSharedWorkspaceSopParams,
  CreateSharedWorkspaceSopResponse,
  GetSharedWorkspaceKnowledgeParams,
  GetSharedWorkspaceKnowledgeResponse,
  ListSharedWorkspaceMembersParams,
  ListSharedWorkspaceMembersResponse,
  ListSharedWorkspaceSopsParams,
  ListSharedWorkspaceSopsResponse,
  ListSharedWorkspacesResponse,
  PublishSharedWorkspaceSopParams,
  PublishSharedWorkspaceSopResponse,
  RemoveSharedWorkspaceMemberParams,
  RemoveSharedWorkspaceMemberResponse,
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
  workspaceSopOwnerKey,
  type SharedWorkspaceMembership,
} from "../lib/workspace-membership";
import {
  loadOntologyConcepts,
  workspaceOwner,
} from "../lib/venom-ontology-store";

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
    createdAt: sop.createdAt,
    updatedAt: sop.updatedAt,
  };
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
    const membership = await requireMembership(
      req,
      res,
      params.data.workspaceId,
    );
    if (!membership) return;
    if (membership.role !== "admin") {
      res.status(403).json(workspaceAccessDeniedBody());
      return;
    }

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
    const membership = await requireMembership(
      req,
      res,
      params.data.workspaceId,
    );
    if (!membership) return;
    if (membership.role !== "admin") {
      res.status(403).json(workspaceAccessDeniedBody());
      return;
    }

    const targetUserId = params.data.memberUserId;
    const removed = await db.transaction(async (tx) => {
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
    const clusters = [...concepts].sort(
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
        eq(
          venomSopsTable.clerkUserId,
          workspaceSopOwnerKey(membership.workspaceId),
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
    if (!sop) {
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

export default router;
