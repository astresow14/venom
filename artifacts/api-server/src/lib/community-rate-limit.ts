/**
 * community-rate-limit.ts
 *
 * Distributed DB-backed rate limiting for community routes.
 * Atomic conditional upsert so concurrent requests cannot exceed limits.
 * Keys are hashed from private auth ID + action + window; never emitted.
 */

import { db, communityRateLimitsTable } from "@workspace/db";
import { sql } from "drizzle-orm";
import {
  buildRateLimitKey,
  checkRateLimitWithStore,
  RATE_LIMITS,
  windowStartMs,
  type RateLimitStore,
  type RateLimitResult,
} from "./community-rate-limit-pure";

// Re-export for consumers that import from this module
export {
  buildRateLimitKey,
  checkRateLimitWithStore as checkRateLimitWithStore,
  RATE_LIMITS,
  windowStartMs,
  type RateLimitStore,
  type RateLimitResult,
};

/**
 * Production DB store using a true atomic conditional update.
 *
 * INSERT ... ON CONFLICT DO UPDATE SET count = count + 1 WHERE count < max
 *
 * When count is already at max, the WHERE on the conflict action prevents
 * the update from executing, so Postgres returns 0 rows. No rows = denied.
 * When count < max, the update fires and returns the new count.
 * On fresh insert (no conflict), count=1 is always <=max, row is returned.
 */
export const dbRateLimitStore: RateLimitStore = {
  async claimSlot(key, windowStart, windowEnd, max) {
    const rows = await db
      .insert(communityRateLimitsTable)
      .values({
        key,
        count: 1,
        windowStart,
        windowEnd,
      })
      .onConflictDoUpdate({
        target: communityRateLimitsTable.key,
        set: {
          count: sql`${communityRateLimitsTable.count} + 1`,
        },
        setWhere: sql`${communityRateLimitsTable.count} < ${max}`,
      })
      .returning({ count: communityRateLimitsTable.count });

    // No row returned means the conditional WHERE was false → at limit
    return rows[0]?.count ?? null;
  },
};

/**
 * Atomically check and increment the rate limit counter for a given user+action.
 * Uses the production DB store.
 */
export async function checkRateLimit(
  clerkUserId: string,
  action: string,
  store: RateLimitStore = dbRateLimitStore,
): Promise<RateLimitResult> {
  return checkRateLimitWithStore(clerkUserId, action, store);
}

/**
 * Respond with 429 if rate limited. Returns true if limited (caller should return).
 */
export function applyRateLimit(
  res: { status: (code: number) => { json: (body: unknown) => void } },
  result: RateLimitResult,
): boolean {
  if (!result.allowed) {
    res.status(429).json({
      error: "Too many requests",
      retryAfterSeconds: result.retryAfterSeconds,
    });
    return true;
  }
  return false;
}
