/**
 * venom-community-votes.ts
 * Idempotent desired-state vote: PUT /venom/community/threads/:threadId/vote
 *
 * All vote state reads and mutations happen inside a single transaction.
 * A session-level advisory lock keyed on the (threadId, memberId) pair
 * serializes concurrent requests for the same member/thread so only one
 * insert or delete wins and the score is adjusted exactly once.
 */

import { getAuth } from "@clerk/express";
import {
  VoteCommunityThreadBody,
  VoteCommunityThreadParams,
  VoteCommunityThreadResponse,
} from "@workspace/api-zod";
import {
  communityThreadsTable,
  communityVotesTable,
  db,
} from "@workspace/db";
import { and, eq, isNull, sql } from "drizzle-orm";
import { Router, type IRouter } from "express";
import { checkRateLimit, applyRateLimit } from "../lib/community-rate-limit";
import { resolveViewerProfile } from "./venom-community-threads";

const router: IRouter = Router();

/**
 * Derive a stable 64-bit advisory lock key from two UUID strings.
 * We hash them into a signed bigint that fits pg_try_advisory_xact_lock(bigint).
 * Collisions are theoretically possible but astronomically rare in practice.
 */
function advisoryLockKey(threadId: string, memberId: string): bigint {
  // XOR the first 8 bytes of each UUID's hex digits to produce a 64-bit number
  const combined = `vote:${threadId}:${memberId}`;
  let h = 0n;
  for (let i = 0; i < combined.length; i++) {
    h = BigInt.asIntN(64, h * 31n + BigInt(combined.charCodeAt(i)));
  }
  return h;
}

// ---------------------------------------------------------------------------
// PUT /venom/community/threads/:threadId/vote
// ---------------------------------------------------------------------------

router.put(
  "/venom/community/threads/:threadId/vote",
  async (req, res): Promise<void> => {
    const { userId } = getAuth(req);
    if (!userId) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }

    const params = VoteCommunityThreadParams.safeParse(req.params);
    if (!params.success) {
      res.status(404).json({ error: "Thread not found" });
      return;
    }

    const parsed = VoteCommunityThreadBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid vote body" });
      return;
    }

    const viewerProfile = await resolveViewerProfile(userId);
    if (!viewerProfile) {
      res.status(409).json({ error: "Community profile required" });
      return;
    }

    const rl = await checkRateLimit(userId, "vote");
    if (applyRateLimit(res, rl)) return;

    const start = Date.now();
    const desiredUpvoted = parsed.data.upvoted;
    const threadId = params.data.threadId;
    const memberId = viewerProfile.id;
    const lockKey = advisoryLockKey(threadId, memberId);

    const result = await db.transaction(async (tx) => {
      // Acquire a transaction-scoped advisory lock so concurrent requests for
      // the same (thread, member) pair are serialized. The lock is released
      // automatically when the transaction commits or rolls back.
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(${lockKey})`,
      );

      // Read thread inside transaction for a consistent view
      const [thread] = await tx
        .select({
          id: communityThreadsTable.id,
          voteScore: communityThreadsTable.voteScore,
          removedAt: communityThreadsTable.removedAt,
        })
        .from(communityThreadsTable)
        .where(eq(communityThreadsTable.id, threadId))
        .limit(1);

      if (!thread || thread.removedAt !== null) {
        return { notFound: true } as const;
      }

      // Read current vote state inside same transaction
      const [existingVote] = await tx
        .select({ id: communityVotesTable.id })
        .from(communityVotesTable)
        .where(
          and(
            eq(communityVotesTable.threadId, thread.id),
            eq(communityVotesTable.memberId, memberId),
          ),
        )
        .limit(1);

      const currentlyUpvoted = existingVote !== undefined;
      let scoreDelta = 0;

      if (desiredUpvoted && !currentlyUpvoted) {
        // Insert — unique constraint prevents duplicates even without lock,
        // but the lock means we won't race here.
        await tx
          .insert(communityVotesTable)
          .values({ threadId: thread.id, memberId })
          .onConflictDoNothing();
        scoreDelta = 1;
      } else if (!desiredUpvoted && currentlyUpvoted) {
        await tx
          .delete(communityVotesTable)
          .where(
            and(
              eq(communityVotesTable.threadId, thread.id),
              eq(communityVotesTable.memberId, memberId),
            ),
          );
        scoreDelta = -1;
      }
      // else: desired state already matches — no change

      // Adjust score atomically and read back exact DB value
      let finalScore: number;
      if (scoreDelta !== 0) {
        const [updated] = await tx
          .update(communityThreadsTable)
          .set({
            voteScore: sql`GREATEST(0, ${communityThreadsTable.voteScore} + ${scoreDelta})`,
          })
          .where(eq(communityThreadsTable.id, thread.id))
          .returning({ voteScore: communityThreadsTable.voteScore });
        finalScore = updated?.voteScore ?? thread.voteScore;
      } else {
        finalScore = thread.voteScore;
      }

      // Query exact vote state after mutation — ground truth
      const [voteAfter] = await tx
        .select({ id: communityVotesTable.id })
        .from(communityVotesTable)
        .where(
          and(
            eq(communityVotesTable.threadId, thread.id),
            eq(communityVotesTable.memberId, memberId),
          ),
        )
        .limit(1);

      return {
        notFound: false,
        threadId: thread.id,
        upvoted: voteAfter !== undefined,
        score: Math.max(0, finalScore),
      } as const;
    });

    if (result.notFound) {
      res.status(404).json({ error: "Thread not found" });
      return;
    }

    req.log.info(
      {
        threadId: result.threadId,
        durationMs: Date.now() - start,
        op: "vote_thread",
      },
      "Community thread vote processed",
    );

    res.json(
      VoteCommunityThreadResponse.parse({
        threadId: result.threadId,
        upvoted: result.upvoted,
        score: result.score,
      }),
    );
  },
);

export default router;
