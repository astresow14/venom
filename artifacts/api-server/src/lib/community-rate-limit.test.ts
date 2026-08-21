/**
 * community-rate-limit.test.ts
 *
 * Tests the real rate-limit helper algorithms using an in-memory store.
 * Proves: max+1 is denied, concurrency cannot exceed max, key properties.
 *
 * Bundled and run via esbuild + node --test.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  checkRateLimitWithStore as checkRateLimit,
  buildRateLimitKey,
  windowStartMs,
  RATE_LIMITS,
  type RateLimitStore,
} from "./community-rate-limit-pure";

// ---------------------------------------------------------------------------
// In-memory store that replicates the real conditional upsert semantics.
// ---------------------------------------------------------------------------

function makeInMemoryStore(overrideMax?: number): RateLimitStore & { getCount(key: string): number } {
  const rows = new Map<string, { count: number }>();

  return {
    getCount(key: string): number {
      return rows.get(key)?.count ?? 0;
    },

    async claimSlot(
      key: string,
      _windowStart: Date,
      _windowEnd: Date,
      max: number,
    ): Promise<number | null> {
      const effective = overrideMax ?? max;
      const existing = rows.get(key);

      if (!existing) {
        // Fresh insert — always succeeds (count=1 <= max)
        rows.set(key, { count: 1 });
        return 1;
      }

      // Conditional update: only increment if count < max
      if (existing.count < effective) {
        existing.count += 1;
        return existing.count;
      }

      // count >= max — conditional WHERE was false → denied, no row returned
      return null;
    },
  };
}

// ---------------------------------------------------------------------------
// Core algorithm correctness
// ---------------------------------------------------------------------------

describe("checkRateLimit — in-memory store", () => {
  it("allows requests up to the limit", async () => {
    const store = makeInMemoryStore();
    const max = RATE_LIMITS["vote"]!.max; // 30

    for (let i = 0; i < max; i++) {
      const result = await checkRateLimit("user-A", "vote", store);
      assert.ok(result.allowed, `Request ${i + 1} of ${max} should be allowed`);
    }
  });

  it("denies request max+1", async () => {
    const store = makeInMemoryStore();
    const max = RATE_LIMITS["report"]!.max; // 3

    for (let i = 0; i < max; i++) {
      const r = await checkRateLimit("user-B", "report", store);
      assert.ok(r.allowed);
    }

    const denied = await checkRateLimit("user-B", "report", store);
    assert.ok(!denied.allowed, "Request max+1 must be denied");
    assert.ok("retryAfterSeconds" in denied && denied.retryAfterSeconds >= 1);
  });

  it("different users have independent counters", async () => {
    const store = makeInMemoryStore();
    const max = RATE_LIMITS["report"]!.max; // 3

    // Exhaust user-C's limit
    for (let i = 0; i < max; i++) {
      await checkRateLimit("user-C", "report", store);
    }
    const deniedC = await checkRateLimit("user-C", "report", store);
    assert.ok(!deniedC.allowed);

    // user-D is unaffected
    const allowedD = await checkRateLimit("user-D", "report", store);
    assert.ok(allowedD.allowed, "Different user should have fresh counter");
  });

  it("different actions have independent counters", async () => {
    const store = makeInMemoryStore();
    const max = RATE_LIMITS["report"]!.max; // 3

    for (let i = 0; i < max; i++) {
      await checkRateLimit("user-E", "report", store);
    }
    const deniedReport = await checkRateLimit("user-E", "report", store);
    assert.ok(!deniedReport.allowed);

    // vote action is unaffected
    const allowedVote = await checkRateLimit("user-E", "vote", store);
    assert.ok(allowedVote.allowed, "Different action should have fresh counter");
  });

  it("unknown action is always allowed", async () => {
    const store = makeInMemoryStore();
    const result = await checkRateLimit("user-F", "nonexistent_action", store);
    assert.ok(result.allowed);
  });
});

// ---------------------------------------------------------------------------
// Concurrency: simulate N concurrent requests, only max slots can be claimed
// ---------------------------------------------------------------------------

describe("checkRateLimit — concurrency proof", () => {
  it("concurrent requests cannot exceed max slots", async () => {
    const max = RATE_LIMITS["thread_post"]!.max; // 5

    // Simulate a store with a mutex to model atomic DB behavior
    const rows = new Map<string, { count: number }>();
    let inflight = 0;
    let maxInflight = 0;

    const atomicStore: RateLimitStore = {
      async claimSlot(key, _ws, _we, m) {
        inflight++;
        maxInflight = Math.max(maxInflight, inflight);
        try {
          const existing = rows.get(key);
          if (!existing) {
            rows.set(key, { count: 1 });
            return 1;
          }
          if (existing.count < m) {
            existing.count += 1;
            return existing.count;
          }
          return null;
        } finally {
          inflight--;
        }
      },
    };

    // Fire max*2 concurrent requests
    const concurrentCount = max * 2;
    const results = await Promise.all(
      Array.from({ length: concurrentCount }, (_, i) =>
        checkRateLimit(`concurrent-user-${i % 2}`, "thread_post", atomicStore),
      ),
    );

    // Each user (0 and 1) should have at most max=5 allowed
    const allowedUser0 = results.filter((r, i) => i % 2 === 0 && r.allowed).length;
    const allowedUser1 = results.filter((r, i) => i % 2 === 1 && r.allowed).length;

    assert.ok(allowedUser0 <= max, `User 0 allowed ${allowedUser0} but max is ${max}`);
    assert.ok(allowedUser1 <= max, `User 1 allowed ${allowedUser1} but max is ${max}`);
  });

  it("exactly max slots are claimed when max+N all fire", async () => {
    const max = 3; // small for clarity
    const store = makeInMemoryStore(max);

    const results = await Promise.all(
      Array.from({ length: max + 5 }, () =>
        checkRateLimit("concurrent-single-user", "report", store),
      ),
    );

    const allowed = results.filter((r) => r.allowed).length;
    const denied = results.filter((r) => !r.allowed).length;

    assert.equal(allowed, max, `Exactly ${max} requests should be allowed`);
    assert.equal(denied, 5, "Remaining 5 requests should be denied");
  });
});

// ---------------------------------------------------------------------------
// Key properties
// ---------------------------------------------------------------------------

describe("rate limit key properties", () => {
  it("key is a hex hash, not raw userId", () => {
    const key = buildRateLimitKey("clerk_private_user_id", "vote", 1700000000000);
    assert.ok(!key.includes("clerk"), "Key must not contain raw userId");
    assert.match(key, /^[0-9a-f]{64}$/, "Key must be a 64-char hex hash");
  });

  it("same inputs produce same key (deterministic)", () => {
    const k1 = buildRateLimitKey("user-X", "vote", 1700000000000);
    const k2 = buildRateLimitKey("user-X", "vote", 1700000000000);
    assert.equal(k1, k2);
  });

  it("different actions produce different keys", () => {
    const k1 = buildRateLimitKey("user-X", "vote", 1700000000000);
    const k2 = buildRateLimitKey("user-X", "thread_post", 1700000000000);
    assert.notEqual(k1, k2);
  });

  it("different windows produce different keys", () => {
    const winMs = 60_000;
    const now1 = 1700000000000;
    const now2 = now1 + winMs; // next window
    const ws1 = windowStartMs(now1, winMs);
    const ws2 = windowStartMs(now2, winMs);
    const k1 = buildRateLimitKey("user-X", "vote", ws1);
    const k2 = buildRateLimitKey("user-X", "vote", ws2);
    assert.notEqual(k1, k2, "Different windows must have different keys");
  });

  it("window start is floored to boundary", () => {
    const winMs = 60_000;
    const now = 1_700_000_045_321;
    const ws = windowStartMs(now, winMs);
    assert.equal(ws % winMs, 0);
    assert.ok(ws <= now);
    assert.ok(ws + winMs > now);
  });
});
