/**
 * venom-community-reports.ts
 * POST /venom/community/reports — submit a content report
 */

import { getAuth } from "@clerk/express";
import {
  CreateCommunityReportBody,
  CreateCommunityReportResponse,
} from "@workspace/api-zod";
import {
  communityRepliesTable,
  communityReportsTable,
  communityThreadsTable,
  db,
} from "@workspace/db";
import { and, eq, isNull } from "drizzle-orm";
import { Router, type IRouter } from "express";
import { checkRateLimit, applyRateLimit } from "../lib/community-rate-limit";
import { resolveViewerProfile } from "./venom-community-threads";

const router: IRouter = Router();

// ---------------------------------------------------------------------------
// POST /venom/community/reports
// ---------------------------------------------------------------------------

router.post("/venom/community/reports", async (req, res): Promise<void> => {
  const { userId } = getAuth(req);
  if (!userId) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  const viewerProfile = await resolveViewerProfile(userId);
  if (!viewerProfile) {
    res.status(409).json({ error: "Community profile required" });
    return;
  }

  const parsed = CreateCommunityReportBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid report" });
    return;
  }

  const rl = await checkRateLimit(userId, "report");
  if (applyRateLimit(res, rl)) return;

  // Validate target visibility (must exist and not be removed)
  if (parsed.data.targetType === "thread") {
    const [thread] = await db
      .select({ id: communityThreadsTable.id })
      .from(communityThreadsTable)
      .where(
        and(
          eq(communityThreadsTable.id, parsed.data.targetId),
          isNull(communityThreadsTable.removedAt),
        ),
      )
      .limit(1);

    if (!thread) {
      res.status(404).json({ error: "Target not found" });
      return;
    }
  } else if (parsed.data.targetType === "reply") {
    // Must verify both the reply AND its parent thread are live.
    // Replies under a removed thread are not publicly visible.
    const [reply] = await db
      .select({
        id: communityRepliesTable.id,
        threadId: communityRepliesTable.threadId,
      })
      .from(communityRepliesTable)
      .where(
        and(
          eq(communityRepliesTable.id, parsed.data.targetId),
          isNull(communityRepliesTable.removedAt),
        ),
      )
      .limit(1);

    if (!reply) {
      res.status(404).json({ error: "Target not found" });
      return;
    }

    // Also verify parent thread is live
    const [parentThread] = await db
      .select({ id: communityThreadsTable.id })
      .from(communityThreadsTable)
      .where(
        and(
          eq(communityThreadsTable.id, reply.threadId),
          isNull(communityThreadsTable.removedAt),
        ),
      )
      .limit(1);

    if (!parentThread) {
      res.status(404).json({ error: "Target not found" });
      return;
    }
  }

  const start = Date.now();

  // Insert report — unique constraint allows one report per reporter+target
  const [report] = await db
    .insert(communityReportsTable)
    .values({
      reporterProfileId: viewerProfile.id,
      targetType: parsed.data.targetType,
      targetId: parsed.data.targetId,
      reason: parsed.data.reason,
      details: parsed.data.details?.trim() ?? null,
    })
    .onConflictDoUpdate({
      target: [
        communityReportsTable.reporterProfileId,
        communityReportsTable.targetType,
        communityReportsTable.targetId,
      ],
      set: {
        reason: parsed.data.reason,
        details: parsed.data.details?.trim() ?? null,
        updatedAt: new Date(),
      },
    })
    .returning();

  if (!report) {
    res.status(500).json({ error: "Internal error" });
    return;
  }

  req.log.info(
    {
      reportId: report.id,
      targetType: parsed.data.targetType,
      targetId: parsed.data.targetId,
      durationMs: Date.now() - start,
      op: "create_report",
    },
    "Community report created",
  );

  res.status(201).json(
    CreateCommunityReportResponse.parse({
      id: report.id,
      status: "received",
    }),
  );
});

export default router;
