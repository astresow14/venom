/**
 * venom-community-feed.ts
 * GET /venom/community/feed — paginated community thread feed with stable cursors
 * GET /venom/community/briefing — personal briefing with agenda + feed
 */

import { getAuth } from "@clerk/express";
import {
  GetCommunityBriefingQueryParams,
  GetCommunityBriefingResponse,
  GetCommunityFeedQueryParams,
  GetCommunityFeedResponse,
} from "@workspace/api-zod";
import {
  communityProfilesTable,
  communityThreadsTable,
  communityVotesTable,
  db,
  threadSummariesTable,
  venomWorkspacesTable,
  type CommunityProfile,
  type CommunityThread,
  type ThreadSummary,
} from "@workspace/db";
import { and, desc, eq, isNull, lt, lte, or, sql } from "drizzle-orm";
import { Router, type IRouter } from "express";
import {
  decodeCursor,
  encodeCursor,
  type FeedOrder,
} from "../lib/community-cursor";
import {
  extractAgendaItems,
  nullCalendarProvider,
  resolveCalendarDay,
} from "../lib/community-agenda";
import { validateTimezone } from "../lib/community-summary";
import {
  resolveViewerProfile,
  summaryPayload,
  threadPayload,
} from "./venom-community-threads";
import { profilePayload } from "./venom-community-profiles";

const router: IRouter = Router();

// ---------------------------------------------------------------------------
// Feed query helpers
// ---------------------------------------------------------------------------

async function fetchFeedPage(
  viewerProfileId: string | null,
  order: FeedOrder,
  limit: number,
  cursor: string | undefined,
): Promise<
  | { ok: true; items: ReturnType<typeof threadPayload>[]; nextCursor: string | null }
  | { ok: false; reason: "invalid_cursor" }
> {
  const pageSize = limit + 1; // fetch one extra to detect next page

  let decodedCursor = null;
  if (cursor) {
    decodedCursor = decodeCursor(cursor, order);
    if (!decodedCursor) {
      return { ok: false, reason: "invalid_cursor" };
    }
  }

  let threads: CommunityThread[];

  if (order === "new") {
    let whereClause = isNull(communityThreadsTable.removedAt);
    if (decodedCursor && decodedCursor.order === "new") {
      const cursorDate = new Date(decodedCursor.createdAt);
      whereClause = and(
        isNull(communityThreadsTable.removedAt),
        or(
          lt(communityThreadsTable.createdAt, cursorDate),
          and(
            eq(communityThreadsTable.createdAt, cursorDate),
            lt(communityThreadsTable.id, decodedCursor.id),
          ),
        ),
      )!;
    }
    threads = await db
      .select()
      .from(communityThreadsTable)
      .where(whereClause)
      .orderBy(
        desc(communityThreadsTable.createdAt),
        desc(communityThreadsTable.id),
      )
      .limit(pageSize);
  } else {
    // order === "top"
    let whereClause = isNull(communityThreadsTable.removedAt);
    if (decodedCursor && decodedCursor.order === "top") {
      const cursorDate = new Date(decodedCursor.createdAt);
      whereClause = and(
        isNull(communityThreadsTable.removedAt),
        or(
          lt(communityThreadsTable.voteScore, decodedCursor.voteScore),
          and(
            eq(communityThreadsTable.voteScore, decodedCursor.voteScore),
            or(
              lt(communityThreadsTable.createdAt, cursorDate),
              and(
                eq(communityThreadsTable.createdAt, cursorDate),
                lt(communityThreadsTable.id, decodedCursor.id),
              ),
            ),
          ),
        ),
      )!;
    }
    threads = await db
      .select()
      .from(communityThreadsTable)
      .where(whereClause)
      .orderBy(
        desc(communityThreadsTable.voteScore),
        desc(communityThreadsTable.createdAt),
        desc(communityThreadsTable.id),
      )
      .limit(pageSize);
  }

  const hasNextPage = threads.length > limit;
  const pageThreads = hasNextPage ? threads.slice(0, limit) : threads;

  if (pageThreads.length === 0) {
    return { ok: true, items: [], nextCursor: null };
  }

  // Batch-fetch authors, summaries, viewer votes
  const authorIds = [...new Set(pageThreads.map((t) => t.authorId))];
  const threadIds = pageThreads.map((t) => t.id);

  const [authors, summaries, votes] = await Promise.all([
    authorIds.length > 0
      ? db
          .select()
          .from(communityProfilesTable)
          .where(
            sql`${communityProfilesTable.id} = ANY(${sql.raw(`ARRAY[${authorIds.map((id) => `'${id.replace(/'/g, "''")}'`).join(",")}]::uuid[]`)})`,
          )
      : Promise.resolve([] as CommunityProfile[]),
    db
      .select()
      .from(threadSummariesTable)
      .where(
        sql`${threadSummariesTable.threadId} = ANY(${sql.raw(`ARRAY[${threadIds.map((id) => `'${id.replace(/'/g, "''")}'`).join(",")}]::uuid[]`)})`,
      ),
    viewerProfileId
      ? db
          .select({ threadId: communityVotesTable.threadId })
          .from(communityVotesTable)
          .where(
            and(
              eq(communityVotesTable.memberId, viewerProfileId),
              sql`${communityVotesTable.threadId} = ANY(${sql.raw(`ARRAY[${threadIds.map((id) => `'${id.replace(/'/g, "''")}'`).join(",")}]::uuid[]`)})`,
            ),
          )
      : Promise.resolve([] as { threadId: string }[]),
  ]);

  const authorMap = new Map(authors.map((a) => [a.id, a]));
  const summaryMap = new Map(summaries.map((s) => [s.threadId, s]));
  const upvotedSet = new Set(votes.map((v) => v.threadId));

  const items = pageThreads
    .map((thread) => {
      const author = authorMap.get(thread.authorId);
      if (!author) return null;
      return threadPayload(
        thread,
        author,
        summaryMap.get(thread.id) ?? null,
        viewerProfileId,
        upvotedSet.has(thread.id),
      );
    })
    .filter((x): x is NonNullable<typeof x> => x !== null);

  // Build next cursor from last item in page
  let nextCursor: string | null = null;
  if (hasNextPage && pageThreads.length > 0) {
    const last = pageThreads[pageThreads.length - 1]!;
    if (order === "new") {
      nextCursor = encodeCursor({
        order: "new",
        createdAt: last.createdAt.toISOString(),
        id: last.id,
      });
    } else {
      nextCursor = encodeCursor({
        order: "top",
        voteScore: last.voteScore,
        createdAt: last.createdAt.toISOString(),
        id: last.id,
      });
    }
  }

  return { ok: true, items, nextCursor };
}

// ---------------------------------------------------------------------------
// GET /venom/community/feed
// ---------------------------------------------------------------------------

router.get("/venom/community/feed", async (req, res): Promise<void> => {
  const { userId } = getAuth(req);
  if (!userId) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  const parsed = GetCommunityFeedQueryParams.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid query parameters" });
    return;
  }

  const viewerProfile = await resolveViewerProfile(userId);

  const feedResult = await fetchFeedPage(
    viewerProfile?.id ?? null,
    parsed.data.order,
    parsed.data.limit,
    parsed.data.cursor,
  );

  if (!feedResult.ok) {
    res.status(400).json({ error: "Invalid or tampered cursor" });
    return;
  }

  res.json(
    GetCommunityFeedResponse.parse({
      items: feedResult.items,
      nextCursor: feedResult.nextCursor,
    }),
  );
});

// ---------------------------------------------------------------------------
// GET /venom/community/briefing
// ---------------------------------------------------------------------------

router.get("/venom/community/briefing", async (req, res): Promise<void> => {
  const { userId } = getAuth(req);
  if (!userId) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  const parsed = GetCommunityBriefingQueryParams.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid query parameters" });
    return;
  }

  // Validate timezone
  let tz: string;
  try {
    tz = validateTimezone(parsed.data.timezone);
  } catch {
    res.status(400).json({ error: "Invalid timezone" });
    return;
  }

  const calendarDay = resolveCalendarDay(tz, parsed.data.date);

  // Validate cursor before doing any DB work
  const feedResult = await fetchFeedPage(
    null, // viewer votes re-enriched below
    parsed.data.order,
    parsed.data.limit,
    parsed.data.cursor,
  );

  if (!feedResult.ok) {
    res.status(400).json({ error: "Invalid or tampered cursor" });
    return;
  }

  // Fetch viewer profile and workspace concurrently (cursor already validated)
  const [viewerProfile, workspaceRow] = await Promise.all([
    resolveViewerProfile(userId),
    db
      .select()
      .from(venomWorkspacesTable)
      .where(eq(venomWorkspacesTable.clerkUserId, userId))
      .limit(1)
      .then((r) => r[0] ?? null),
  ]);

  // If viewer profile exists, re-enrich feed with vote status
  let communityItems = feedResult.items;
  if (viewerProfile && communityItems.length > 0) {
    const threadIds = communityItems.map((i) => i.id);
    const votes = await db
      .select({ threadId: communityVotesTable.threadId })
      .from(communityVotesTable)
      .where(
        and(
          eq(communityVotesTable.memberId, viewerProfile.id),
          sql`${communityVotesTable.threadId} = ANY(${sql.raw(`ARRAY[${threadIds.map((id) => `'${id.replace(/'/g, "''")}'`).join(",")}]::uuid[]`)})`,
        ),
      );
    const upvotedSet = new Set(votes.map((v) => v.threadId));
    communityItems = communityItems.map((item) => ({
      ...item,
      viewerHasUpvoted: upvotedSet.has(item.id),
      viewerIsAuthor:
        viewerProfile.id === item.author.id,
    }));
  }

  // Extract personal agenda — never persisted, never logged
  const workspaceState = workspaceRow?.state ?? null;
  const agendaItems = extractAgendaItems(
    userId,
    workspaceState,
    calendarDay,
  );

  // Calendar: not connected in this repo
  const calendarStatus = nullCalendarProvider.status;

  res.json(
    GetCommunityBriefingResponse.parse({
      community: communityItems,
      agenda: agendaItems,
      calendarStatus,
      viewerProfile: viewerProfile ? profilePayload(viewerProfile) : null,
      nextCursor: feedResult.nextCursor,
    }),
  );
});

export default router;

// Export for testing
export { fetchFeedPage };
