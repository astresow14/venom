/**
 * venom-community-replies.ts
 * Reply CRUD for community threads
 */

import { getAuth } from "@clerk/express";
import {
  CreateCommunityReplyBody,
  CreateCommunityReplyParams,
  CreateCommunityReplyResponse,
  DeleteCommunityReplyParams,
  UpdateCommunityReplyBody,
  UpdateCommunityReplyParams,
  UpdateCommunityReplyResponse,
} from "@workspace/api-zod";
import {
  communityProfilesTable,
  communityRepliesTable,
  communityThreadsTable,
  db,
} from "@workspace/db";
import { and, eq, isNull, sql } from "drizzle-orm";
import { Router, type IRouter } from "express";
import { checkRateLimit, applyRateLimit } from "../lib/community-rate-limit";
import {
  createReplyNotification,
  pruneExpiredNotifications,
} from "../lib/community-notifications";
import { resolveViewerProfile, replyPayload } from "./venom-community-threads";

const router: IRouter = Router();

// ---------------------------------------------------------------------------
// POST /venom/community/threads/:threadId/replies
// ---------------------------------------------------------------------------

router.post(
  "/venom/community/threads/:threadId/replies",
  async (req, res): Promise<void> => {
    const { userId } = getAuth(req);
    if (!userId) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }

    const params = CreateCommunityReplyParams.safeParse(req.params);
    if (!params.success) {
      res.status(404).json({ error: "Thread not found" });
      return;
    }

    const viewerProfile = await resolveViewerProfile(userId);
    if (!viewerProfile) {
      res.status(409).json({ error: "Community profile required" });
      return;
    }

    const parsed = CreateCommunityReplyBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid reply body" });
      return;
    }

    // Verify thread exists and is not removed
    const [thread] = await db
      .select()
      .from(communityThreadsTable)
      .where(
        and(
          eq(communityThreadsTable.id, params.data.threadId),
          isNull(communityThreadsTable.removedAt),
        ),
      )
      .limit(1);

    if (!thread) {
      res.status(404).json({ error: "Thread not found" });
      return;
    }

    const clientRequestId = parsed.data.clientRequestId;

    // A completed retry returns the original reply before consuming rate-limit
    // budget or attempting to notify again.
    const [existingReply] = await db
      .select()
      .from(communityRepliesTable)
      .where(
        and(
          eq(communityRepliesTable.authorId, viewerProfile.id),
          eq(communityRepliesTable.clientRequestId, clientRequestId),
        ),
      )
      .limit(1);

    if (existingReply) {
      if (existingReply.threadId !== thread.id) {
        res.status(409).json({ error: "Reply request already used" });
        return;
      }

      req.log.info(
        {
          threadId: thread.id,
          replyId: existingReply.id,
          deduplicated: true,
          op: "create_reply",
        },
        "Community reply retry deduplicated",
      );
      res.status(201).json(
        CreateCommunityReplyResponse.parse(
          replyPayload(existingReply, viewerProfile, viewerProfile.id),
        ),
      );
      return;
    }

    // Validate optional parent reply: must belong to this thread and not be
    // removed. The parent reply's author is the notification recipient.
    let parentReply: typeof communityRepliesTable.$inferSelect | null = null;
    const parentReplyId = parsed.data.parentReplyId ?? null;
    if (parentReplyId != null) {
      const [parent] = await db
        .select()
        .from(communityRepliesTable)
        .where(
          and(
            eq(communityRepliesTable.id, parentReplyId),
            eq(communityRepliesTable.threadId, thread.id),
            isNull(communityRepliesTable.removedAt),
          ),
        )
        .limit(1);
      if (!parent) {
        res.status(400).json({ error: "Invalid reply body" });
        return;
      }
      parentReply = parent;
    }

    const rl = await checkRateLimit(userId, "reply_post");
    if (applyRateLimit(res, rl)) return;

    const start = Date.now();

    // Recipient: parent reply author when replying to a reply; otherwise the
    // thread author. Self replies are suppressed inside createReplyNotification.
    const recipientProfileId = parentReply
      ? parentReply.authorId
      : thread.authorId;

    // Insert reply, atomically increment replyCount, and create exactly one
    // notification — all in the same transaction. The unique client operation
    // id also closes the race between simultaneous duplicate requests.
    const result = await db.transaction(async (tx) => {
      await pruneExpiredNotifications(tx);

      const [insertedReply] = await tx
        .insert(communityRepliesTable)
        .values({
          threadId: thread.id,
          authorId: viewerProfile.id,
          clientRequestId,
          parentReplyId,
          body: parsed.data.body,
        })
        .onConflictDoNothing({
          target: [
            communityRepliesTable.authorId,
            communityRepliesTable.clientRequestId,
          ],
        })
        .returning();

      if (!insertedReply) {
        const [deduplicatedReply] = await tx
          .select()
          .from(communityRepliesTable)
          .where(
            and(
              eq(communityRepliesTable.authorId, viewerProfile.id),
              eq(communityRepliesTable.clientRequestId, clientRequestId),
            ),
          )
          .limit(1);

        return {
          reply:
            deduplicatedReply?.threadId === thread.id
              ? deduplicatedReply
              : null,
          notified: false,
          deduplicated: true,
        };
      }

      await tx
        .update(communityThreadsTable)
        .set({
          replyCount: sql`${communityThreadsTable.replyCount} + 1`,
        })
        .where(eq(communityThreadsTable.id, thread.id));

      const notified = await createReplyNotification(tx, {
        replyId: insertedReply.id,
        threadId: thread.id,
        actorProfileId: viewerProfile.id,
        recipientProfileId,
        parentReplyId,
      });

      return {
        reply: insertedReply,
        notified,
        deduplicated: false,
      };
    });

    const { reply, notified, deduplicated } = result;
    if (!reply) {
      res.status(409).json({ error: "Reply request already used" });
      return;
    }

    req.log.info(
      {
        threadId: thread.id,
        replyId: reply.id,
        parentReplyId,
        notificationCreated: notified,
        deduplicated,
        durationMs: Date.now() - start,
        op: "create_reply",
      },
      "Community reply created",
    );

    res.status(201).json(
      CreateCommunityReplyResponse.parse(
        replyPayload(reply, viewerProfile, viewerProfile.id),
      ),
    );
  },
);

// ---------------------------------------------------------------------------
// PATCH /venom/community/replies/:replyId
// ---------------------------------------------------------------------------

router.patch(
  "/venom/community/replies/:replyId",
  async (req, res): Promise<void> => {
    const { userId } = getAuth(req);
    if (!userId) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }

    const params = UpdateCommunityReplyParams.safeParse(req.params);
    if (!params.success) {
      res.status(404).json({ error: "Reply not found" });
      return;
    }

    const parsed = UpdateCommunityReplyBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid update" });
      return;
    }

    const viewerProfile = await resolveViewerProfile(userId);
    if (!viewerProfile) {
      res.status(409).json({ error: "Community profile required" });
      return;
    }

    const [reply] = await db
      .select()
      .from(communityRepliesTable)
      .where(
        and(
          eq(communityRepliesTable.id, params.data.replyId),
          isNull(communityRepliesTable.removedAt),
        ),
      )
      .limit(1);

    if (!reply) {
      res.status(404).json({ error: "Reply not found" });
      return;
    }

    if (reply.authorId !== viewerProfile.id) {
      res.status(403).json({ error: "Forbidden" });
      return;
    }

    const start = Date.now();
    const newBody = parsed.data.body ?? reply.body;

    const [updated] = await db
      .update(communityRepliesTable)
      .set({
        body: newBody,
        updatedAt: new Date(),
      })
      .where(eq(communityRepliesTable.id, reply.id))
      .returning();

    if (!updated) {
      res.status(500).json({ error: "Internal error" });
      return;
    }

    const [author] = await db
      .select()
      .from(communityProfilesTable)
      .where(eq(communityProfilesTable.id, updated.authorId))
      .limit(1);

    req.log.info(
      { replyId: updated.id, durationMs: Date.now() - start, op: "update_reply" },
      "Community reply updated",
    );

    res.json(
      UpdateCommunityReplyResponse.parse(
        replyPayload(updated, author!, viewerProfile.id),
      ),
    );
  },
);

// ---------------------------------------------------------------------------
// DELETE /venom/community/replies/:replyId
// ---------------------------------------------------------------------------

router.delete(
  "/venom/community/replies/:replyId",
  async (req, res): Promise<void> => {
    const { userId } = getAuth(req);
    if (!userId) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }

    const params = DeleteCommunityReplyParams.safeParse(req.params);
    if (!params.success) {
      res.status(404).json({ error: "Reply not found" });
      return;
    }

    const viewerProfile = await resolveViewerProfile(userId);
    if (!viewerProfile) {
      res.status(404).json({ error: "Reply not found" });
      return;
    }

    const [reply] = await db
      .select()
      .from(communityRepliesTable)
      .where(
        and(
          eq(communityRepliesTable.id, params.data.replyId),
          isNull(communityRepliesTable.removedAt),
        ),
      )
      .limit(1);

    if (!reply) {
      res.status(404).json({ error: "Reply not found" });
      return;
    }

    if (reply.authorId !== viewerProfile.id) {
      res.status(403).json({ error: "Forbidden" });
      return;
    }

    const start = Date.now();

    // Soft-delete reply and atomically decrement replyCount (exactly once)
    await db.transaction(async (tx) => {
      const [softDeleted] = await tx
        .update(communityRepliesTable)
        .set({ removedAt: new Date() })
        .where(
          and(
            eq(communityRepliesTable.id, reply.id),
            isNull(communityRepliesTable.removedAt), // guard double-decrement
          ),
        )
        .returning({ id: communityRepliesTable.id });

      if (softDeleted) {
        await tx
          .update(communityThreadsTable)
          .set({
            replyCount: sql`GREATEST(0, ${communityThreadsTable.replyCount} - 1)`,
          })
          .where(eq(communityThreadsTable.id, reply.threadId));
      }
    });

    req.log.info(
      { replyId: reply.id, threadId: reply.threadId, durationMs: Date.now() - start, op: "delete_reply" },
      "Community reply soft-deleted",
    );

    res.sendStatus(204);
  },
);

export default router;
