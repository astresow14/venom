/**
 * Real-database integration tests for per-user identity records: creation
 * on first authenticated use, freshness, bounded personal fields, upstream
 * deletion cleanup, graceful degradation when the auth provider is down,
 * and the presentation helpers that join evidence to people.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { eq } from "drizzle-orm";
import { db, pool, venomIdentitiesTable } from "@workspace/db";
import {
  collectEvidencePersonIds,
  defaultEvidenceAttribution,
  identityDisplayLabel,
  resolveVenomIdentities,
  resolveVenomIdentity,
  sweepStaleVenomIdentities,
  VENOM_IDENTITY_BOUNDS,
  VENOM_IDENTITY_REFRESH_MS,
  VENOM_IDENTITY_SWEEP_STALE_MS,
  type AuthProfile,
} from "./venom-identity";

const testUserIds: string[] = [];

function freshUserId(): string {
  const userId = `idtest_${randomUUID()}`;
  testUserIds.push(userId);
  return userId;
}

test.after(async () => {
  for (const userId of testUserIds) {
    await db
      .delete(venomIdentitiesTable)
      .where(eq(venomIdentitiesTable.clerkUserId, userId));
  }
  await pool.end();
});

function fetcherReturning(profile: AuthProfile) {
  let calls = 0;
  return {
    fetch: async () => {
      calls += 1;
      return profile;
    },
    calls: () => calls,
  };
}

test("first authenticated use creates a bounded identity record", async () => {
  const userId = freshUserId();
  const fetcher = fetcherReturning({
    displayName: `  ${"n".repeat(500)}  `,
    email: `${"e".repeat(500)}@example.com`,
    provider: "oauth_google".padEnd(200, "x"),
  });

  const identity = await resolveVenomIdentity(userId, {
    fetchProfile: fetcher.fetch,
    now: 1_000_000,
  });

  assert.equal(fetcher.calls(), 1);
  assert.equal(
    identity.displayName?.length,
    VENOM_IDENTITY_BOUNDS.displayName,
  );
  assert.ok((identity.email?.length ?? 0) <= VENOM_IDENTITY_BOUNDS.email);
  assert.equal(identity.provider?.length, VENOM_IDENTITY_BOUNDS.provider);

  const [row] = await db
    .select()
    .from(venomIdentitiesTable)
    .where(eq(venomIdentitiesTable.clerkUserId, userId));
  assert.ok(row, "record is created on first authenticated use");
  assert.equal(row.displayName?.length, VENOM_IDENTITY_BOUNDS.displayName);
  assert.ok((row.email?.length ?? 0) <= VENOM_IDENTITY_BOUNDS.email);
});

test("a fresh identity record is served without re-fetching", async () => {
  const userId = freshUserId();
  const fetcher = fetcherReturning({
    displayName: "Ada Lovelace",
    email: "ada@example.com",
    provider: "google",
  });

  await resolveVenomIdentity(userId, {
    fetchProfile: fetcher.fetch,
    now: 1000,
  });
  const again = await resolveVenomIdentity(userId, {
    fetchProfile: fetcher.fetch,
    now: 1000 + VENOM_IDENTITY_REFRESH_MS - 1,
  });

  assert.equal(fetcher.calls(), 1, "fresh record answers without a fetch");
  assert.equal(again.displayName, "Ada Lovelace");
  assert.equal(again.email, "ada@example.com");
  assert.equal(again.provider, "google");
});

test("a stale identity record is refreshed from the auth provider", async () => {
  const userId = freshUserId();
  const first = fetcherReturning({
    displayName: "Old Name",
    email: "old@example.com",
    provider: "google",
  });
  await resolveVenomIdentity(userId, { fetchProfile: first.fetch, now: 1000 });

  const second = fetcherReturning({
    displayName: "New Name",
    email: "new@example.com",
    provider: "google",
  });
  const refreshed = await resolveVenomIdentity(userId, {
    fetchProfile: second.fetch,
    now: 1000 + VENOM_IDENTITY_REFRESH_MS + 1,
  });

  assert.equal(second.calls(), 1);
  assert.equal(refreshed.displayName, "New Name");
  assert.equal(refreshed.email, "new@example.com");
});

test("a user deleted upstream loses their identity record", async () => {
  const userId = freshUserId();
  const alive = fetcherReturning({
    displayName: "Ghost",
    email: "ghost@example.com",
    provider: "google",
  });
  await resolveVenomIdentity(userId, { fetchProfile: alive.fetch, now: 1000 });

  const gone = fetcherReturning(null);
  const identity = await resolveVenomIdentity(userId, {
    fetchProfile: gone.fetch,
    now: 1000 + VENOM_IDENTITY_REFRESH_MS + 1,
  });

  assert.deepEqual(identity, {
    userId,
    displayName: null,
    email: null,
    provider: null,
  });
  const rows = await db
    .select()
    .from(venomIdentitiesTable)
    .where(eq(venomIdentitiesTable.clerkUserId, userId));
  assert.equal(rows.length, 0, "personal data is removed on deletion");
});

test("auth provider failure degrades to the stale record without writing", async () => {
  const userId = freshUserId();
  const fetcher = fetcherReturning({
    displayName: "Kept Name",
    email: "kept@example.com",
    provider: "google",
  });
  await resolveVenomIdentity(userId, {
    fetchProfile: fetcher.fetch,
    now: 1000,
  });

  const failing = async () => {
    throw new Error("auth provider unavailable");
  };
  const identity = await resolveVenomIdentity(userId, {
    fetchProfile: failing,
    now: 1000 + VENOM_IDENTITY_REFRESH_MS + 1,
  });
  assert.equal(identity.displayName, "Kept Name");

  // A user never seen before resolves to all-null and writes nothing.
  const strangerId = freshUserId();
  const stranger = await resolveVenomIdentity(strangerId, {
    fetchProfile: failing,
  });
  assert.deepEqual(stranger, {
    userId: strangerId,
    displayName: null,
    email: null,
    provider: null,
  });
  const rows = await db
    .select()
    .from(venomIdentitiesTable)
    .where(eq(venomIdentitiesTable.clerkUserId, strangerId));
  assert.equal(rows.length, 0);
});

test("batch resolution refreshes only stale or missing identities", async () => {
  const freshId = freshUserId();
  const missingId = freshUserId();
  const seed = fetcherReturning({
    displayName: "Fresh Person",
    email: null,
    provider: null,
  });
  await resolveVenomIdentity(freshId, { fetchProfile: seed.fetch, now: 1000 });

  const batch = fetcherReturning({
    displayName: "Filled Person",
    email: null,
    provider: null,
  });
  const identities = await resolveVenomIdentities(
    [freshId, missingId, freshId, ""],
    { fetchProfile: batch.fetch, now: 2000 },
  );

  assert.equal(batch.calls(), 1, "only the missing identity is fetched");
  assert.equal(identities.get(freshId)?.displayName, "Fresh Person");
  assert.equal(identities.get(missingId)?.displayName, "Filled Person");
  assert.equal(identities.size, 2);
});

test("the retention sweep deletes upstream-deleted identities and keeps live ones", async () => {
  // Fixture rows carry a current refreshedAt/createdAt so the live dev
  // server's own sweep (real clock, real Clerk) never picks them up; they
  // are stale only relative to this test's injected future clock.
  const realNow = Date.now();
  const sweepNow = realNow + VENOM_IDENTITY_SWEEP_STALE_MS + 60 * 60 * 1000;

  const deletedId = freshUserId();
  const liveId = freshUserId();
  const freshId = freshUserId();
  await db.insert(venomIdentitiesTable).values([
    {
      clerkUserId: deletedId,
      displayName: "Gone Person",
      email: "gone@example.com",
      provider: "google",
      refreshedAt: new Date(realNow),
      createdAt: new Date(realNow),
    },
    {
      clerkUserId: liveId,
      displayName: "Old Live Name",
      email: "live@example.com",
      provider: "google",
      refreshedAt: new Date(realNow),
      createdAt: new Date(realNow),
    },
    {
      // Recently refreshed relative to the injected clock: must be skipped.
      clerkUserId: freshId,
      displayName: "Fresh Person",
      email: "fresh@example.com",
      provider: "google",
      refreshedAt: new Date(sweepNow - 1000),
      createdAt: new Date(realNow),
    },
  ]);

  const fetchedIds: string[] = [];
  const fetchProfile = async (userId: string): Promise<AuthProfile> => {
    fetchedIds.push(userId);
    if (userId === deletedId) return null;
    if (userId === liveId) {
      return {
        displayName: "Refreshed Live Name",
        email: "live@example.com",
        provider: "google",
      };
    }
    // The shared dev database (and earlier tests in this file) may hold
    // other rows that are stale relative to the future clock; failing
    // their checks proves they are left untouched.
    throw new Error("unknown user");
  };

  const result = await sweepStaleVenomIdentities({
    fetchProfile,
    now: sweepNow,
  });

  assert.equal(result.deleted, 1, "exactly the upstream-deleted row is gone");
  assert.equal(result.refreshed, 1, "exactly the live row is re-verified");
  assert.ok(result.scanned >= 2, "both stale fixtures are scanned");
  assert.equal(
    result.failed,
    result.scanned - 2,
    "every other scanned row failed its check and was left alone",
  );
  assert.ok(fetchedIds.includes(deletedId));
  assert.ok(fetchedIds.includes(liveId));
  assert.ok(
    !fetchedIds.includes(freshId),
    "recently refreshed rows are not re-verified",
  );

  const deletedRows = await db
    .select()
    .from(venomIdentitiesTable)
    .where(eq(venomIdentitiesTable.clerkUserId, deletedId));
  assert.equal(
    deletedRows.length,
    0,
    "the deleted account's name and email are removed",
  );

  const [liveRow] = await db
    .select()
    .from(venomIdentitiesTable)
    .where(eq(venomIdentitiesTable.clerkUserId, liveId));
  assert.ok(liveRow, "the live account's row survives the sweep");
  assert.equal(liveRow.displayName, "Refreshed Live Name");
  assert.equal(
    liveRow.refreshedAt.getTime(),
    sweepNow,
    "the surviving row is re-stamped so the next sweep skips it",
  );

  const [freshRow] = await db
    .select()
    .from(venomIdentitiesTable)
    .where(eq(venomIdentitiesTable.clerkUserId, freshId));
  assert.equal(freshRow?.displayName, "Fresh Person");
});

test("a failed auth-provider check leaves the identity row for the next sweep", async () => {
  const realNow = Date.now();
  const sweepNow = realNow + VENOM_IDENTITY_SWEEP_STALE_MS + 60 * 60 * 1000;
  const userId = freshUserId();
  await db.insert(venomIdentitiesTable).values({
    clerkUserId: userId,
    displayName: "Unreachable Person",
    email: "unreachable@example.com",
    provider: "google",
    refreshedAt: new Date(realNow),
    createdAt: new Date(realNow),
  });

  const result = await sweepStaleVenomIdentities({
    fetchProfile: async () => {
      throw new Error("auth provider unavailable");
    },
    now: sweepNow,
  });

  assert.ok(result.failed >= 1, "the unreachable row is counted as failed");
  assert.equal(result.deleted, 0, "nothing is deleted without an explicit answer");

  const [row] = await db
    .select()
    .from(venomIdentitiesTable)
    .where(eq(venomIdentitiesTable.clerkUserId, userId));
  assert.ok(row, "the row survives until the provider can be reached");
  assert.equal(row.displayName, "Unreachable Person");
});

test("presentation helpers default legacy evidence to the owner", () => {
  const sources = [
    { capturedByUserId: null },
    { capturedByUserId: "user_real" },
    { capturedByUserId: null },
  ];
  const defaulted = defaultEvidenceAttribution(sources, "user_owner");
  assert.deepEqual(
    defaulted.map((evidence) => evidence.capturedByUserId),
    ["user_owner", "user_real", "user_owner"],
  );

  assert.deepEqual(collectEvidencePersonIds(defaulted, 16), [
    "user_owner",
    "user_real",
  ]);
  assert.deepEqual(collectEvidencePersonIds(defaulted, 1), ["user_owner"]);

  assert.equal(
    identityDisplayLabel({
      userId: "u",
      displayName: "Ada Lovelace",
      email: "ada@example.com",
      provider: null,
    }),
    "Ada Lovelace",
  );
  assert.equal(
    identityDisplayLabel({
      userId: "u",
      displayName: null,
      email: "ada@example.com",
      provider: null,
    }),
    "ada@example.com",
  );
  assert.equal(identityDisplayLabel(undefined), null);
});
