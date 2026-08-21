/**
 * venom-community-threads.ts
 * Thread CRUD: POST, GET, PATCH, DELETE /venom/community/threads
 */

import { getAuth } from "@clerk/express";
import {
  CreateCommunityThreadBody,
  CreateCommunityThreadResponse,
  DeleteCommunityThreadParams,
  GetCommunityThreadParams,
  GetCommunityThreadQueryParams,
  GetCommunityThreadResponse,
  UpdateCommunityThreadBody,
  UpdateCommunityThreadParams,
  UpdateCommunityThreadResponse,
} from "@workspace/api-zod";
import {
  communityProfilesTable,
  communityRepliesTable,
  communityThreadsTable,
  communityVotesTable,
  db,
  threadSummariesTable,
  type CommunityProfile,
  type CommunityReply,
  type CommunityThread,
  type ThreadSummary,
} from "@workspace/db";
import { and, asc, eq, isNull, sql } from "drizzle-orm";
import { Router, type IRouter } from "express";
import { checkRateLimit, applyRateLimit } from "../lib/community-rate-limit";
import { buildFallbackSummary } from "../lib/community-summary";
import { mergeFocusedReplies } from "../lib/community-notifications-core";
import { profilePayload } from "./venom-community-profiles";
import {
  persistPendingSummary,
  scheduleThreadSummary,
} from "./venom-community-summarize";

const router: IRouter = Router();

// ---------------------------------------------------------------------------
// Public payload builders — explicit allowlists
// ---------------------------------------------------------------------------

/**
 * Build the public summary payload for a thread.
 *
 * Revision guard: if the stored summary's sourceRevision does not match the
 * thread's current revision, we must NOT serve stale summary text.
 * Return a pending/fallback payload for the current revision instead.
 * This protects against race conditions where a slow summarization for an
 * old revision would otherwise be shown against a newer body.
 */
export function summaryPayload(summary: ThreadSummary | null, thread: CommunityThread) {
  const revision = thread.revision;

  // No summary yet → pending
  if (!summary) {
    return {
      text: buildFallbackSummary(thread.body),
      status: "pending" as const,
      sourceRevision: revision,
      generatedAt: null,
      label: "AI summary" as const,
    };
  }

  // Stale revision → deterministic fallback for current body/revision
  if (summary.sourceRevision !== revision) {
    return {
      text: buildFallbackSummary(thread.body),
      status: "pending" as const,
      sourceRevision: revision,
      generatedAt: null,
      label: "AI summary" as const,
    };
  }

  const status = (
    summary.status === "generated" || summary.status === "fallback"
      ? summary.status
      : "pending"
  ) as "generated" | "fallback" | "pending";

  return {
    text: summary.text,
    status,
    sourceRevision: summary.sourceRevision,
    generatedAt: summary.generatedAt ?? null,
    label: "AI summary" as const,
  };
}

export function threadPayload(
  thread: CommunityThread,
  author: CommunityProfile,
  summary: ThreadSummary | null,
  viewerProfileId: string | null,
  viewerHasUpvoted: boolean,
) {
  return {
    id: thread.id,
    author: {
      id: author.id,
      displayName: author.displayName,
    },
    body: thread.body,
    summary: summaryPayload(summary, thread),
    score: Math.max(0, thread.voteScore),
    replyCount: Math.max(0, thread.replyCount),
    viewerHasUpvoted,
    viewerIsAuthor: viewerProfileId !== null && viewerProfileId === author.id,
    revision: thread.revision,
    createdAt: thread.createdAt,
    updatedAt: thread.updatedAt,
  };
}

export function replyPayload(
  reply: CommunityReply,
  author: CommunityProfile,
  viewerProfileId: string | null,
) {
  return {
    id: reply.id,
    threadId: reply.threadId,
    author: {
      id: author.id,
      displayName: author.displayName,
    },
    body: reply.body,
    parentReplyId: reply.parentReplyId,
    viewerIsAuthor: viewerProfileId !== null && viewerProfileId === author.id,
    createdAt: reply.createdAt,
    updatedAt: reply.updatedAt,
  };
}

// ---------------------------------------------------------------------------
// Helper: resolve viewer profile from clerkUserId
// ---------------------------------------------------------------------------

export async function resolveViewerProfile(
  userId: string | null | undefined,
): Promise<CommunityProfile | null> {
  if (!userId) return null;
  const [profile] = await db
    .select()
    .from(communityProfilesTable)
    .where(eq(communityProfilesTable.clerkUserId, userId))
    .limit(1);
  return profile ?? null;
}

// ---------------------------------------------------------------------------
// Helper: check if viewer has upvoted a list of thread IDs
// ---------------------------------------------------------------------------

export async function viewerUpvotedSet(
  viewerProfileId: string | null,
  threadIds: string[],
): Promise<Set<string>> {
  if (!viewerProfileId || threadIds.length === 0) return new Set();
  const votes = await db
    .select({ threadId: communityVotesTable.threadId })
    .from(communityVotesTable)
    .where(
      and(
        eq(communityVotesTable.memberId, viewerProfileId),
        sql`${communityVotesTable.threadId} = ANY(${sql.raw(`ARRAY[${threadIds.map((id) => `'${id.replace(/'/g, "''")}'`).join(",")}]::uuid[]`)})`,
      ),
    );
  return new Set(votes.map((v) => v.threadId));
}

// ---------------------------------------------------------------------------
// POST /venom/community/threads — create thread
// ---------------------------------------------------------------------------

router.post("/venom/community/threads", async (req, res): Promise<void> => {
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

  const parsed = CreateCommunityThreadBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid thread body" });
    return;
  }

  const rl = await checkRateLimit(userId, "thread_post");
  if (applyRateLimit(res, rl)) return;

  const start = Date.now();

  const [thread] = await db
    .insert(communityThreadsTable)
    .values({
      authorId: viewerProfile.id,
      body: parsed.data.body,
    })
    .returning();

  if (!thread) {
    res.status(500).json({ error: "Internal error" });
    return;
  }

  // Persist a safe summary without depending on the optional model.
  const summary = await persistPendingSummary(
    thread.id,
    thread.body,
    thread.revision,
  );

  req.log.info(
    { threadId: thread.id, durationMs: Date.now() - start, op: "create_thread" },
    "Community thread created",
  );

  res.status(201).json(
    CreateCommunityThreadResponse.parse(
      threadPayload(thread, viewerProfile, summary, viewerProfile.id, false),
    ),
  );
  scheduleThreadSummary(thread.id, thread.body, thread.revision);
});

// ---------------------------------------------------------------------------
// GET /venom/community/threads/:threadId — get thread with replies
// ---------------------------------------------------------------------------

router.get(
  "/venom/community/threads/:threadId",
  async (req, res): Promise<void> => {
    const { userId } = getAuth(req);
    if (!userId) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }

    const params = GetCommunityThreadParams.safeParse(req.params);
    if (!params.success) {
      res.status(404).json({ error: "Thread not found" });
      return;
    }

    const query = GetCommunityThreadQueryParams.safeParse(req.query);
    if (!query.success) {
      res.status(400).json({ error: "Invalid reply focus" });
      return;
    }

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

    // Fetch author, summary, replies concurrently
    const [author, summary, initialReplies, viewerProfile, focusedReply] =
      await Promise.all([
      db
        .select()
        .from(communityProfilesTable)
        .where(eq(communityProfilesTable.id, thread.authorId))
        .limit(1)
        .then((r) => r[0] ?? null),
      db
        .select()
        .from(threadSummariesTable)
        .where(eq(threadSummariesTable.threadId, thread.id))
        .limit(1)
        .then((r) => r[0] ?? null),
      db
        .select()
        .from(communityRepliesTable)
        .where(
          and(
            eq(communityRepliesTable.threadId, thread.id),
            isNull(communityRepliesTable.removedAt),
          ),
        )
        .orderBy(asc(communityRepliesTable.createdAt))
        .limit(500),
      resolveViewerProfile(userId),
      query.data.replyId
        ? db
            .select()
            .from(communityRepliesTable)
            .where(
              and(
                eq(communityRepliesTable.id, query.data.replyId),
                eq(communityRepliesTable.threadId, thread.id),
                isNull(communityRepliesTable.removedAt),
              ),
            )
            .limit(1)
            .then((rows) => rows[0] ?? null)
        : Promise.resolve(null),
    ]);

    if (!author) {
      res.status(404).json({ error: "Thread not found" });
      return;
    }

    // A notification may target a reply outside the normal 500-row detail
    // window. Include that reply and its parent context without duplicating
    // rows, so both clients can focus the exact triggering reply.
    let focusedParent: typeof communityRepliesTable.$inferSelect | null = null;
    if (
      focusedReply?.parentReplyId &&
      !initialReplies.some((reply) => reply.id === focusedReply.parentReplyId)
    ) {
      const [parent] = await db
        .select()
        .from(communityRepliesTable)
        .where(
          and(
            eq(communityRepliesTable.id, focusedReply.parentReplyId),
            eq(communityRepliesTable.threadId, thread.id),
            isNull(communityRepliesTable.removedAt),
          ),
        )
        .limit(1);
      focusedParent = parent ?? null;
    }
    const replies = mergeFocusedReplies(
      initialReplies,
      focusedReply,
      focusedParent,
    );

    // Fetch reply authors
    const replyAuthorIds = [...new Set(replies.map((r) => r.authorId))];
    const replyAuthors = replyAuthorIds.length > 0
      ? await db
          .select()
          .from(communityProfilesTable)
          .where(
            sql`${communityProfilesTable.id} = ANY(${sql.raw(`ARRAY[${replyAuthorIds.map((id) => `'${id.replace(/'/g, "''")}'`).join(",")}]::uuid[]`)})`,
          )
      : [];
    const authorMap = new Map(replyAuthors.map((a) => [a.id, a]));

    const upvotedSet = await viewerUpvotedSet(
      viewerProfile?.id ?? null,
      [thread.id],
    );

    res.json(
      GetCommunityThreadResponse.parse({
        thread: threadPayload(
          thread,
          author,
          summary,
          viewerProfile?.id ?? null,
          upvotedSet.has(thread.id),
        ),
        replies: replies
          .map((reply) => {
            const replyAuthor = authorMap.get(reply.authorId);
            if (!replyAuthor) return null;
            return replyPayload(reply, replyAuthor, viewerProfile?.id ?? null);
          })
          .filter(Boolean),
      }),
    );
  },
);

// ---------------------------------------------------------------------------
// PATCH /venom/community/threads/:threadId — update thread (owner only)
// ---------------------------------------------------------------------------

router.patch(
  "/venom/community/threads/:threadId",
  async (req, res): Promise<void> => {
    const { userId } = getAuth(req);
    if (!userId) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }

    const params = UpdateCommunityThreadParams.safeParse(req.params);
    if (!params.success) {
      res.status(404).json({ error: "Thread not found" });
      return;
    }

    const parsed = UpdateCommunityThreadBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid update" });
      return;
    }

    const viewerProfile = await resolveViewerProfile(userId);
    if (!viewerProfile) {
      res.status(409).json({ error: "Community profile required" });
      return;
    }

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

    if (thread.authorId !== viewerProfile.id) {
      res.status(403).json({ error: "Forbidden" });
      return;
    }

    const rl = await checkRateLimit(userId, "thread_edit");
    if (applyRateLimit(res, rl)) return;

    const start = Date.now();

    const newBody = parsed.data.body ?? thread.body;

    const [updated] = await db
      .update(communityThreadsTable)
      .set({
        body: newBody,
        revision: sql`${communityThreadsTable.revision} + 1`,
        updatedAt: new Date(),
      })
      .where(eq(communityThreadsTable.id, thread.id))
      .returning();

    if (!updated) {
      res.status(500).json({ error: "Internal error" });
      return;
    }

    // Persist a current-revision safe summary without waiting on the model.
    const summaryResult = await persistPendingSummary(
      updated.id,
      updated.body,
      updated.revision,
    );

    // If another edit won meanwhile, reload latest thread so we never pair
    // a thread at revision N with a summary at revision N+1.
    let finalThread = updated;
    let finalSummary = summaryResult;
    if (summaryResult.sourceRevision !== updated.revision) {
      const [reloaded] = await db
        .select()
        .from(communityThreadsTable)
        .where(eq(communityThreadsTable.id, updated.id))
        .limit(1);
      if (reloaded && reloaded.revision === summaryResult.sourceRevision) {
        finalThread = reloaded;
      } else {
        // Summary revision still doesn't match — use pending payload via summaryPayload
        finalSummary = summaryResult;
      }
    }

    const [author] = await db
      .select()
      .from(communityProfilesTable)
      .where(eq(communityProfilesTable.id, finalThread.authorId))
      .limit(1);

    const upvotedSet = await viewerUpvotedSet(viewerProfile.id, [finalThread.id]);

    req.log.info(
      { threadId: finalThread.id, revision: finalThread.revision, durationMs: Date.now() - start, op: "update_thread" },
      "Community thread updated",
    );

    res.json(
      UpdateCommunityThreadResponse.parse(
        threadPayload(finalThread, author!, finalSummary, viewerProfile.id, upvotedSet.has(finalThread.id)),
      ),
    );
    scheduleThreadSummary(updated.id, updated.body, updated.revision);
  },
);

// ---------------------------------------------------------------------------
// DELETE /venom/community/threads/:threadId — soft-delete (owner only)
// ---------------------------------------------------------------------------

router.delete(
  "/venom/community/threads/:threadId",
  async (req, res): Promise<void> => {
    const { userId } = getAuth(req);
    if (!userId) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }

    const params = DeleteCommunityThreadParams.safeParse(req.params);
    if (!params.success) {
      res.status(404).json({ error: "Thread not found" });
      return;
    }

    const viewerProfile = await resolveViewerProfile(userId);
    if (!viewerProfile) {
      res.status(404).json({ error: "Thread not found" });
      return;
    }

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

    if (thread.authorId !== viewerProfile.id) {
      res.status(403).json({ error: "Forbidden" });
      return;
    }

    const start = Date.now();

    await db
      .update(communityThreadsTable)
      .set({ removedAt: new Date() })
      .where(eq(communityThreadsTable.id, thread.id));

    req.log.info(
      { threadId: thread.id, durationMs: Date.now() - start, op: "delete_thread" },
      "Community thread soft-deleted",
    );

    res.sendStatus(204);
  },
);

export default router;
