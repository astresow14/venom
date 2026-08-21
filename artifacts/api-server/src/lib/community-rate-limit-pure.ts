/**
 * community-rate-limit-pure.ts
 *
 * Pure, dependency-free algorithmic helpers for rate limiting.
 * No DB imports. Safe to import in tests without any external dependencies.
 */

import { createHash } from "node:crypto";

// Action-specific limits
export const RATE_LIMITS: Record<string, { windowMs: number; max: number }> = {
  profile_upsert: { windowMs: 60_000, max: 5 },
  thread_post: { windowMs: 60_000, max: 5 },
  thread_edit: { windowMs: 60_000, max: 10 },
  reply_post: { windowMs: 60_000, max: 10 },
  vote: { windowMs: 60_000, max: 30 },
  report: { windowMs: 60_000, max: 3 },
};

/**
 * Build a hashed key from private auth ID + action + fixed window start.
 * The key is NEVER emitted to clients.
 */
export function buildRateLimitKey(
  clerkUserId: string,
  action: string,
  windowStart: number,
): string {
  return createHash("sha256")
    .update(`${clerkUserId}|${action}|${windowStart}`)
    .digest("hex");
}

/**
 * Compute the fixed window start epoch (ms) for the given time and window size.
 */
export function windowStartMs(now: number, windowMs: number): number {
  return Math.floor(now / windowMs) * windowMs;
}

/**
 * The rate limit store interface, separated for dependency injection in tests.
 */
export type RateLimitStore = {
  /**
   * Atomically attempt to claim one slot in the window.
   * Returns new count if slot was claimed, null if at limit.
   */
  claimSlot(
    key: string,
    windowStart: Date,
    windowEnd: Date,
    max: number,
  ): Promise<number | null>;
};

export type RateLimitResult =
  | { allowed: true }
  | { allowed: false; retryAfterSeconds: number };

/**
 * Check and increment the rate limit counter for a given user+action.
 * Returns { allowed: true } if within limit or { allowed: false, retryAfterSeconds }.
 */
export async function checkRateLimitWithStore(
  clerkUserId: string,
  action: string,
  store: RateLimitStore,
): Promise<RateLimitResult> {
  const config = RATE_LIMITS[action];
  if (!config) return { allowed: true };

  const now = Date.now();
  const winStart = windowStartMs(now, config.windowMs);
  const winEnd = winStart + config.windowMs;
  const key = buildRateLimitKey(clerkUserId, action, winStart);

  const claimed = await store.claimSlot(
    key,
    new Date(winStart),
    new Date(winEnd),
    config.max,
  );

  if (claimed === null) {
    const retryAfterSeconds = Math.max(1, Math.ceil((winEnd - now) / 1000));
    return { allowed: false, retryAfterSeconds };
  }

  return { allowed: true };
}
