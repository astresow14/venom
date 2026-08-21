import { createHash } from "node:crypto";
import { getAuth } from "@clerk/express";
import {
  ArchiveVenomSopParams,
  ArchiveVenomSopResponse,
  AssignVenomSopAppsBody,
  AssignVenomSopAppsParams,
  AssignVenomSopAppsResponse,
  CreateVenomSopBody,
  CreateVenomSopResponse,
  DuplicateVenomSopParams,
  DuplicateVenomSopResponse,
  GetVenomSopParams,
  GetVenomSopResponse,
  ListVenomProjectSopsParams,
  ListVenomProjectSopsResponse,
  ListVenomSopRevisionsParams,
  ListVenomSopRevisionsResponse,
  ListVenomSopsQueryParams,
  ListVenomSopsResponse,
  PublishVenomSopParams,
  PublishVenomSopResponse,
  SelectVenomProjectSopsBody,
  SelectVenomProjectSopsParams,
  SelectVenomProjectSopsResponse,
  UpdateVenomSopBody,
  UpdateVenomSopParams,
  UpdateVenomSopResponse,
} from "@workspace/api-zod";
import {
  db,
  venomPortfolioAppsTable,
  venomSopAppAssignmentsTable,
  venomSopProjectSelectionsTable,
  venomSopRevisionsTable,
  venomSopsTable,
  venomWorkspacesTable,
  type VenomSop,
  type VenomSopAppAssignment,
  type VenomSopContentRecord,
  type VenomSopProjectSelection,
} from "@workspace/db";
import { and, desc, eq, ilike, inArray, or, sql } from "drizzle-orm";
import { Router, type IRouter, type Request } from "express";
import { checkSopContentSafety, flattenSopContent } from "../lib/sop-content-safety.js";
import {
  buildSopReferenceBundleResult,
  MAX_SOP_REFERENCE_CHARS,
} from "../lib/sop-reference.js";

const router: IRouter = Router();
type UserIdResolver = (request: Request) => string | null;
let testUserIdResolver: UserIdResolver | null = null;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function userIdFor(request: Request): string | null {
  if (testUserIdResolver) return testUserIdResolver(request);
  return getAuth(request).userId;
}

export function overrideVenomSopUserIdResolverForTests(
  resolver: UserIdResolver,
): () => void {
  if (process.env.NODE_ENV !== "test") {
    throw new Error("SOP route auth overrides are available only in tests");
  }
  const previous = testUserIdResolver;
  testUserIdResolver = resolver;
  return () => {
    testUserIdResolver = previous;
  };
}

function sopPayload(
  sop: VenomSop,
  appIds: string[],
) {
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
    appIds,
    createdAt: sop.createdAt,
    updatedAt: sop.updatedAt,
    archivedAt: sop.archivedAt ?? null,
  };
}

async function ownedSop(userId: string, sopId: string) {
  const [sop] = await db
    .select()
    .from(venomSopsTable)
    .where(
      and(
        eq(venomSopsTable.id, sopId),
        eq(venomSopsTable.clerkUserId, userId),
      ),
    )
    .limit(1);
  return sop;
}

async function sopAppIds(userId: string, sopId: string): Promise<string[]> {
  const rows = await db
    .select({ appId: venomSopAppAssignmentsTable.appId })
    .from(venomSopAppAssignmentsTable)
    .where(
      and(
        eq(venomSopAppAssignmentsTable.clerkUserId, userId),
        eq(venomSopAppAssignmentsTable.sopId, sopId),
      ),
    );
  return rows.map((r) => r.appId);
}

function computeChecksum(
  title: string,
  category: string,
  tags: string[],
  provenance: string,
  content: VenomSopContentRecord,
): string {
  const canonical = JSON.stringify({ title, category, tags: [...tags].sort(), provenance, content });
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

// ---------------------------------------------------------------------------
// Safety check helper (no body logging)
// ---------------------------------------------------------------------------
function rejectUnsafeContent(
  title: string,
  category: string,
  tags: string[],
  content: VenomSopContentRecord,
): string | null {
  const blob = flattenSopContent(content, title, category, tags);
  const result = checkSopContentSafety(blob);
  if (!result.ok) {
    return result.reason;
  }
  return null;
}

// ---------------------------------------------------------------------------
// GET /venom/sops  — list/search
// ---------------------------------------------------------------------------
router.get("/venom/sops", async (req, res): Promise<void> => {
  const userId = userIdFor(req);
  if (!userId) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  const params = ListVenomSopsQueryParams.safeParse(req.query);
  if (!params.success) {
    res.status(400).json({ error: "Invalid query parameters" });
    return;
  }

  const { query, lifecycle, appId } = params.data;

  // Build conditions
  const conditions = [eq(venomSopsTable.clerkUserId, userId)];

  if (lifecycle) {
    conditions.push(eq(venomSopsTable.lifecycle, lifecycle));
  }

  if (appId) {
    conditions.push(
      sql`(
        NOT EXISTS (
          SELECT 1
          FROM ${venomSopAppAssignmentsTable}
          WHERE ${venomSopAppAssignmentsTable.sopId} = ${venomSopsTable.id}
            AND ${venomSopAppAssignmentsTable.clerkUserId} = ${userId}
        )
        OR EXISTS (
          SELECT 1
          FROM ${venomSopAppAssignmentsTable}
          WHERE ${venomSopAppAssignmentsTable.sopId} = ${venomSopsTable.id}
            AND ${venomSopAppAssignmentsTable.clerkUserId} = ${userId}
            AND ${venomSopAppAssignmentsTable.appId} = ${appId}
        )
      )`,
    );
  }

  if (query) {
    const like = `%${query}%`;
    conditions.push(
      or(
        ilike(venomSopsTable.title, like),
        ilike(venomSopsTable.category, like),
        sql`array_to_string(${venomSopsTable.tags}, ' ') ILIKE ${like}`,
        sql`(${venomSopsTable.content}->>'purpose') ILIKE ${like}`,
      )!,
    );
  }

  const sops = await db
    .select()
    .from(venomSopsTable)
    .where(and(...conditions))
    .orderBy(desc(venomSopsTable.updatedAt))
    .limit(500);

  if (sops.length === 0) {
    res.json(ListVenomSopsResponse.parse([]));
    return;
  }

  // Bulk fetch assignments
  const allSopIds = sops.map((s) => s.id);
  const allAssignments = await db
    .select({ sopId: venomSopAppAssignmentsTable.sopId, appId: venomSopAppAssignmentsTable.appId })
    .from(venomSopAppAssignmentsTable)
    .where(
      and(
        eq(venomSopAppAssignmentsTable.clerkUserId, userId),
        inArray(venomSopAppAssignmentsTable.sopId, allSopIds),
      ),
    );

  const assignmentMap = new Map<string, string[]>();
  for (const a of allAssignments) {
    const list = assignmentMap.get(a.sopId) ?? [];
    list.push(a.appId);
    assignmentMap.set(a.sopId, list);
  }

  res.json(
    ListVenomSopsResponse.parse(
      sops.map((sop) => sopPayload(sop, assignmentMap.get(sop.id) ?? [])),
    ),
  );
});

// ---------------------------------------------------------------------------
// POST /venom/sops  — create
// ---------------------------------------------------------------------------
router.post("/venom/sops", async (req, res): Promise<void> => {
  const userId = userIdFor(req);
  if (!userId) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  const parsed = CreateVenomSopBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid SOP data" });
    return;
  }

  const { title, category, tags, provenance, content } = parsed.data;

  const unsafeReason = rejectUnsafeContent(title, category, tags, content);
  if (unsafeReason) {
    req.log.warn({ sopRejectionReason: unsafeReason }, "SOP content rejected by safety check");
    res.status(400).json({ error: "SOP content contains disallowed sensitive data" });
    return;
  }

  const [sop] = await db
    .insert(venomSopsTable)
    .values({
      clerkUserId: userId,
      title: title.trim(),
      category,
      tags,
      provenance,
      content,
      lifecycle: "draft",
    })
    .returning();

  req.log.info({ sopId: sop.id }, "SOP created");

  res.status(201).json(CreateVenomSopResponse.parse(sopPayload(sop, [])));
});

// ---------------------------------------------------------------------------
// GET /venom/sops/:sopId  — get detail
// ---------------------------------------------------------------------------
router.get("/venom/sops/:sopId", async (req, res): Promise<void> => {
  const userId = userIdFor(req);
  if (!userId) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  const params = GetVenomSopParams.safeParse(req.params);
  if (!params.success) {
    res.status(404).json({ error: "SOP not found" });
    return;
  }

  const sop = await ownedSop(userId, params.data.sopId);
  if (!sop) {
    res.status(404).json({ error: "SOP not found" });
    return;
  }

  const [revisions, assignments] = await Promise.all([
    db
      .select()
      .from(venomSopRevisionsTable)
      .where(
        and(
          eq(venomSopRevisionsTable.sopId, sop.id),
          eq(venomSopRevisionsTable.clerkUserId, userId),
        ),
      )
      .orderBy(desc(venomSopRevisionsTable.versionNumber))
      .limit(500),
    db
      .select()
      .from(venomSopAppAssignmentsTable)
      .where(
        and(
          eq(venomSopAppAssignmentsTable.clerkUserId, userId),
          eq(venomSopAppAssignmentsTable.sopId, sop.id),
        ),
      )
      .limit(100),
  ]);

  res.json(
    GetVenomSopResponse.parse({
      sop: sopPayload(sop, assignments.map((a) => a.appId)),
      revisions: revisions.map((r) => ({
        id: r.id,
        versionNumber: r.versionNumber,
        provenance: r.provenance,
        checksumSha256: r.checksumSha256,
        title: r.title,
        category: r.category,
        tags: r.tags,
        content: r.content,
        publishedAt: r.publishedAt,
      })),
      assignments: assignments.map((a) => ({
        appId: a.appId,
        assignedAt: a.assignedAt,
      })),
    }),
  );
});

// ---------------------------------------------------------------------------
// PATCH /venom/sops/:sopId  — update draft
// ---------------------------------------------------------------------------
router.patch("/venom/sops/:sopId", async (req, res): Promise<void> => {
  const userId = userIdFor(req);
  if (!userId) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  const params = UpdateVenomSopParams.safeParse(req.params);
  if (!params.success) {
    res.status(404).json({ error: "SOP not found" });
    return;
  }

  const parsed = UpdateVenomSopBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid SOP data" });
    return;
  }

  const sop = await ownedSop(userId, params.data.sopId);
  if (!sop) {
    res.status(404).json({ error: "SOP not found" });
    return;
  }

  if (sop.lifecycle === "archived") {
    res.status(409).json({ error: "Archived SOPs cannot be modified" });
    return;
  }

  const { title, category, tags, provenance, content } = parsed.data;

  const unsafeReason = rejectUnsafeContent(title, category, tags, content);
  if (unsafeReason) {
    req.log.warn({ sopId: sop.id, sopRejectionReason: unsafeReason }, "SOP update rejected by safety check");
    res.status(400).json({ error: "SOP content contains disallowed sensitive data" });
    return;
  }

  const [updated] = await db
    .update(venomSopsTable)
    .set({
      title: title.trim(),
      category,
      tags,
      provenance,
      content,
    })
    .where(
      and(
        eq(venomSopsTable.id, sop.id),
        eq(venomSopsTable.clerkUserId, userId),
      ),
    )
    .returning();

  if (!updated) {
    res.status(404).json({ error: "SOP not found" });
    return;
  }

  const appIds = await sopAppIds(userId, sop.id);
  req.log.info({ sopId: sop.id }, "SOP updated");

  res.json(UpdateVenomSopResponse.parse(sopPayload(updated, appIds)));
});

// ---------------------------------------------------------------------------
// POST /venom/sops/:sopId/publish  — publish immutable revision
// ---------------------------------------------------------------------------
router.post("/venom/sops/:sopId/publish", async (req, res): Promise<void> => {
  const userId = userIdFor(req);
  if (!userId) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  const params = PublishVenomSopParams.safeParse(req.params);
  if (!params.success) {
    res.status(404).json({ error: "SOP not found" });
    return;
  }

  const sop = await ownedSop(userId, params.data.sopId);
  if (!sop) {
    res.status(404).json({ error: "SOP not found" });
    return;
  }

  if (sop.lifecycle === "archived") {
    res.status(409).json({ error: "Archived SOPs cannot be published" });
    return;
  }

  const unsafeReason = rejectUnsafeContent(sop.title, sop.category, sop.tags, sop.content);
  if (unsafeReason) {
    req.log.warn({ sopId: sop.id, sopRejectionReason: unsafeReason }, "SOP publish rejected by safety check");
    res.status(400).json({ error: "SOP content contains disallowed sensitive data" });
    return;
  }

  const checksum = computeChecksum(sop.title, sop.category, sop.tags, sop.provenance, sop.content);
  const t0 = Date.now();

  // Advisory lock key: hash sopId into a bigint for pg_advisory_xact_lock
  // Using crc32-like fold of the uuid bytes into a signed bigint
  const lockKey = BigInt(
    "0x" +
      createHash("sha256")
        .update(sop.id)
        .digest("hex")
        .slice(0, 15), // 60 bits — safe in pg bigint range
  );

  const revision = await db.transaction(async (tx) => {
    // Acquire advisory lock to prevent concurrent publish races
    await tx.execute(sql`SELECT pg_advisory_xact_lock(${lockKey})`);

    // Compute next version number atomically
    const [maxRow] = await tx
      .select({ max: sql<number>`COALESCE(MAX(${venomSopRevisionsTable.versionNumber}), 0)` })
      .from(venomSopRevisionsTable)
      .where(eq(venomSopRevisionsTable.sopId, sop.id));

    const nextVersion = (maxRow?.max ?? 0) + 1;

    const [rev] = await tx
      .insert(venomSopRevisionsTable)
      .values({
        sopId: sop.id,
        clerkUserId: userId,
        versionNumber: nextVersion,
        title: sop.title,
        category: sop.category,
        tags: sop.tags,
        provenance: sop.provenance,
        content: sop.content,
        checksumSha256: checksum,
      })
      .returning();

    // Update SOP with new active revision + lifecycle
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
          eq(venomSopsTable.clerkUserId, userId),
        ),
      );

    return rev;
  });

  const durationMs = Date.now() - t0;
  req.log.info(
    { sopId: sop.id, revisionId: revision.id, versionNumber: revision.versionNumber, durationMs },
    "SOP revision published",
  );

  res.json(
    PublishVenomSopResponse.parse({
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
});

// ---------------------------------------------------------------------------
// POST /venom/sops/:sopId/duplicate  — duplicate into new draft
// ---------------------------------------------------------------------------
router.post("/venom/sops/:sopId/duplicate", async (req, res): Promise<void> => {
  const userId = userIdFor(req);
  if (!userId) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  const params = DuplicateVenomSopParams.safeParse(req.params);
  if (!params.success) {
    res.status(404).json({ error: "SOP not found" });
    return;
  }

  const sop = await ownedSop(userId, params.data.sopId);
  if (!sop) {
    res.status(404).json({ error: "SOP not found" });
    return;
  }

  const [duplicate] = await db
    .insert(venomSopsTable)
    .values({
      clerkUserId: userId,
      title: `${sop.title} (copy)`,
      category: sop.category,
      tags: sop.tags,
      provenance: sop.provenance,
      content: sop.content,
      lifecycle: "draft",
    })
    .returning();

  req.log.info({ originalSopId: sop.id, newSopId: duplicate.id }, "SOP duplicated");

  res.status(201).json(DuplicateVenomSopResponse.parse(sopPayload(duplicate, [])));
});

// ---------------------------------------------------------------------------
// POST /venom/sops/:sopId/archive  — archive
// ---------------------------------------------------------------------------
router.post("/venom/sops/:sopId/archive", async (req, res): Promise<void> => {
  const userId = userIdFor(req);
  if (!userId) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  const params = ArchiveVenomSopParams.safeParse(req.params);
  if (!params.success) {
    res.status(404).json({ error: "SOP not found" });
    return;
  }

  const sop = await ownedSop(userId, params.data.sopId);
  if (!sop) {
    res.status(404).json({ error: "SOP not found" });
    return;
  }

  if (sop.lifecycle === "archived") {
    res.status(409).json({ error: "SOP is already archived" });
    return;
  }

  const now = new Date();

  // Archive SOP + remove all project selections in a transaction
  const [archived] = await db.transaction(async (tx) => {
    // Remove all project selections for this SOP
    await tx
      .delete(venomSopProjectSelectionsTable)
      .where(
        and(
          eq(venomSopProjectSelectionsTable.sopId, sop.id),
          eq(venomSopProjectSelectionsTable.clerkUserId, userId),
        ),
      );

    return tx
      .update(venomSopsTable)
      .set({
        lifecycle: "archived",
        archivedAt: now,
      })
      .where(
        and(
          eq(venomSopsTable.id, sop.id),
          eq(venomSopsTable.clerkUserId, userId),
        ),
      )
      .returning();
  });

  const appIds = await sopAppIds(userId, sop.id);
  req.log.info({ sopId: sop.id }, "SOP archived");

  res.json(ArchiveVenomSopResponse.parse(sopPayload(archived, appIds)));
});

// ---------------------------------------------------------------------------
// PUT /venom/sops/:sopId/apps  — assign/replace app assignments
// ---------------------------------------------------------------------------
router.put("/venom/sops/:sopId/apps", async (req, res): Promise<void> => {
  const userId = userIdFor(req);
  if (!userId) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  const params = AssignVenomSopAppsParams.safeParse(req.params);
  if (!params.success) {
    res.status(404).json({ error: "SOP not found" });
    return;
  }

  const parsed = AssignVenomSopAppsBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid app assignment data" });
    return;
  }

  const sop = await ownedSop(userId, params.data.sopId);
  if (!sop) {
    res.status(404).json({ error: "SOP not found" });
    return;
  }

  const { appIds } = parsed.data;

  // Validate all appIds are owned by user
  if (appIds.length > 0) {
    const ownedApps = await db
      .select({ id: venomPortfolioAppsTable.id })
      .from(venomPortfolioAppsTable)
      .where(
        and(
          eq(venomPortfolioAppsTable.clerkUserId, userId),
          inArray(venomPortfolioAppsTable.id, appIds),
        ),
      );

    const ownedAppIds = new Set(ownedApps.map((a) => a.id));
    const unowned = appIds.filter((id) => !ownedAppIds.has(id));
    if (unowned.length > 0) {
      req.log.warn(
        { sopId: sop.id, unownedCount: unowned.length },
        "SOP app assignment rejected: unowned apps",
      );
      res.status(400).json({ error: "One or more app IDs are not valid for this account" });
      return;
    }
  }

  // Replace all assignments atomically
  const assignments: VenomSopAppAssignment[] = await db.transaction(async (tx) => {
    await tx
      .delete(venomSopAppAssignmentsTable)
      .where(
        and(
          eq(venomSopAppAssignmentsTable.clerkUserId, userId),
          eq(venomSopAppAssignmentsTable.sopId, sop.id),
        ),
      );

    if (appIds.length === 0) {
      return [];
    }

    return tx
      .insert(venomSopAppAssignmentsTable)
      .values(
        appIds.map((appId) => ({
          clerkUserId: userId,
          sopId: sop.id,
          appId,
        })),
      )
      .returning();
  });

  req.log.info({ sopId: sop.id, appCount: assignments.length }, "SOP app assignments updated");

  res.json(
    AssignVenomSopAppsResponse.parse(
      assignments.map((a) => ({ appId: a.appId, assignedAt: a.assignedAt })),
    ),
  );
});

// ---------------------------------------------------------------------------
// GET /venom/sops/:sopId/revisions  — list revisions
// ---------------------------------------------------------------------------
router.get("/venom/sops/:sopId/revisions", async (req, res): Promise<void> => {
  const userId = userIdFor(req);
  if (!userId) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  const params = ListVenomSopRevisionsParams.safeParse(req.params);
  if (!params.success) {
    res.status(404).json({ error: "SOP not found" });
    return;
  }

  const sop = await ownedSop(userId, params.data.sopId);
  if (!sop) {
    res.status(404).json({ error: "SOP not found" });
    return;
  }

  const revisions = await db
    .select()
    .from(venomSopRevisionsTable)
    .where(
      and(
        eq(venomSopRevisionsTable.sopId, sop.id),
        eq(venomSopRevisionsTable.clerkUserId, userId),
      ),
    )
    .orderBy(desc(venomSopRevisionsTable.versionNumber))
    .limit(500);

  res.json(
    ListVenomSopRevisionsResponse.parse(
      revisions.map((r) => ({
        id: r.id,
        versionNumber: r.versionNumber,
        provenance: r.provenance,
        checksumSha256: r.checksumSha256,
        title: r.title,
        category: r.category,
        tags: r.tags,
        content: r.content,
        publishedAt: r.publishedAt,
      })),
    ),
  );
});

// ---------------------------------------------------------------------------
// GET /venom/projects/:projectId/sops  — list project SOP selections
// ---------------------------------------------------------------------------
router.get("/venom/projects/:projectId/sops", async (req, res): Promise<void> => {
  const userId = userIdFor(req);
  if (!userId) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  const params = ListVenomProjectSopsParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: "Invalid project ID" });
    return;
  }

  const { projectId } = params.data;

  // Verify project belongs to user's workspace
  const [workspace] = await db
    .select({ state: venomWorkspacesTable.state })
    .from(venomWorkspacesTable)
    .where(eq(venomWorkspacesTable.clerkUserId, userId))
    .limit(1);

  if (!workspace) {
    res.status(404).json({ error: "Project not found" });
    return;
  }

  const workspaceState = workspace.state as { projects?: Array<{ id: string }> } | null;
  const projectExists =
    Array.isArray(workspaceState?.projects) &&
    workspaceState.projects.some((p) => p.id === projectId);

  if (!projectExists) {
    res.status(404).json({ error: "Project not found" });
    return;
  }

  const selections = await db
    .select({
      sopId: venomSopProjectSelectionsTable.sopId,
      revisionId: venomSopProjectSelectionsTable.revisionId,
      selectedAt: venomSopProjectSelectionsTable.selectedAt,
      versionNumber: venomSopRevisionsTable.versionNumber,
      title: venomSopRevisionsTable.title,
      category: venomSopRevisionsTable.category,
      purpose: sql<string>`(${venomSopRevisionsTable.content}->>'purpose')`,
    })
    .from(venomSopProjectSelectionsTable)
    .innerJoin(
      venomSopRevisionsTable,
      eq(venomSopProjectSelectionsTable.revisionId, venomSopRevisionsTable.id),
    )
    .where(
      and(
        eq(venomSopProjectSelectionsTable.clerkUserId, userId),
        eq(venomSopProjectSelectionsTable.projectId, projectId),
      ),
    )
    .limit(30);

  res.json(
    ListVenomProjectSopsResponse.parse(
      selections.map((s) => ({
        sopId: s.sopId,
        revisionId: s.revisionId,
        revisionNumber: s.versionNumber,
        title: s.title,
        category: s.category,
        purpose: s.purpose,
        selectedAt: s.selectedAt,
      })),
    ),
  );
});

// ---------------------------------------------------------------------------
// PUT /venom/projects/:projectId/sops  — select active revision SOPs
// ---------------------------------------------------------------------------
router.put("/venom/projects/:projectId/sops", async (req, res): Promise<void> => {
  const userId = userIdFor(req);
  if (!userId) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  const params = SelectVenomProjectSopsParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: "Invalid project ID" });
    return;
  }

  const parsed = SelectVenomProjectSopsBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid SOP selection data" });
    return;
  }

  const { projectId } = params.data;
  const { sopIds } = parsed.data;

  // Verify project belongs to user's workspace
  const [workspace] = await db
    .select({ state: venomWorkspacesTable.state })
    .from(venomWorkspacesTable)
    .where(eq(venomWorkspacesTable.clerkUserId, userId))
    .limit(1);

  if (!workspace) {
    res.status(404).json({ error: "Project not found" });
    return;
  }

  const workspaceState = workspace.state as { projects?: Array<{ id: string }> } | null;
  const projectExists =
    Array.isArray(workspaceState?.projects) &&
    workspaceState.projects.some((p) => p.id === projectId);

  if (!projectExists) {
    res.status(404).json({ error: "Project not found" });
    return;
  }

  if (sopIds.length === 0) {
    // Clear all selections for this project
    await db
      .delete(venomSopProjectSelectionsTable)
      .where(
        and(
          eq(venomSopProjectSelectionsTable.clerkUserId, userId),
          eq(venomSopProjectSelectionsTable.projectId, projectId),
        ),
      );

    req.log.info({ projectId, selectionCount: 0 }, "Project SOP selections cleared");
    res.json(SelectVenomProjectSopsResponse.parse([]));
    return;
  }

  // Validate all SOPs are owned, active (not archived), and have an active revision
  const sopsToSelect = await db
    .select()
    .from(venomSopsTable)
    .where(
      and(
        eq(venomSopsTable.clerkUserId, userId),
        inArray(venomSopsTable.id, sopIds),
      ),
    );

  if (sopsToSelect.length !== sopIds.length) {
    res.status(400).json({ error: "One or more SOPs not found" });
    return;
  }

  const inactiveSops = sopsToSelect.filter((s) => s.lifecycle !== "active");
  if (inactiveSops.length > 0) {
    req.log.warn(
      { projectId, inactiveCount: inactiveSops.length },
      "Project SOP selection rejected: inactive SOPs",
    );
    res.status(409).json({ error: "Only active SOPs can be selected for projects" });
    return;
  }

  const sopsWithoutRevision = sopsToSelect.filter((s) => !s.activeRevisionId);
  if (sopsWithoutRevision.length > 0) {
    req.log.warn(
      { projectId, unpublishedCount: sopsWithoutRevision.length },
      "Project SOP selection rejected: SOPs without active revision",
    );
    res.status(409).json({ error: "One or more SOPs have no published revision" });
    return;
  }

  // Build selection entries pinning the current active revision IDs
  const selectionValues = sopsToSelect.map((s) => ({
    clerkUserId: userId,
    projectId,
    sopId: s.id,
    revisionId: s.activeRevisionId!,
  }));

  // Fetch revision info for response
  const revisionIds = selectionValues.map((v) => v.revisionId);
  const revisions = await db
    .select()
    .from(venomSopRevisionsTable)
    .where(
      and(
        eq(venomSopRevisionsTable.clerkUserId, userId),
        inArray(venomSopRevisionsTable.id, revisionIds),
      ),
    );

  const revisionMap = new Map(revisions.map((r) => [r.id, r]));
  const contextBudget = buildSopReferenceBundleResult(
    revisions,
    MAX_SOP_REFERENCE_CHARS,
  );
  if (contextBudget.includedRevisionIds.length !== revisions.length) {
    req.log.warn(
      { projectId, requestedSelectionCount: revisions.length },
      "Project SOP selection rejected: context budget exceeded",
    );
    res.status(409).json({
      error:
        "Selected SOP references exceed the project context limit. Choose fewer or shorter SOPs.",
    });
    return;
  }

  const t0 = Date.now();
  const insertedSelections: VenomSopProjectSelection[] = await db.transaction(async (tx) => {
    // Replace all existing selections for this project
    await tx
      .delete(venomSopProjectSelectionsTable)
      .where(
        and(
          eq(venomSopProjectSelectionsTable.clerkUserId, userId),
          eq(venomSopProjectSelectionsTable.projectId, projectId),
        ),
      );

    return tx
      .insert(venomSopProjectSelectionsTable)
      .values(selectionValues)
      .returning();
  });

  const durationMs = Date.now() - t0;
  req.log.info(
    { projectId, selectionCount: insertedSelections.length, durationMs },
    "Project SOP selections updated",
  );

  res.json(
    SelectVenomProjectSopsResponse.parse(
      insertedSelections.map((sel) => {
        const rev = revisionMap.get(sel.revisionId)!;
        return {
          sopId: sel.sopId,
          revisionId: sel.revisionId,
          revisionNumber: rev.versionNumber,
          title: rev.title,
          category: rev.category,
          purpose: (rev.content as VenomSopContentRecord).purpose,
          selectedAt: sel.selectedAt,
        };
      }),
    ),
  );
});

export default router;
