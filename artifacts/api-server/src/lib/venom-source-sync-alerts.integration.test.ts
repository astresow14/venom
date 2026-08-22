/**
 * Real-database integration tests for scheduled source sync alerts: the
 * consecutive-failure streak that triggers on the third attempt, success
 * deleting the row, read-all silencing the badge without hiding the alert,
 * fresh streaks arriving unread again, and read-time reconciliation pruning
 * alerts the stored workspace no longer backs (source removed, schedule
 * turned off, or a client-side refresh that already cleared the error).
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { db, pool, venomSourceSyncAlertsTable } from "@workspace/db";
import { eq, inArray, sql } from "drizzle-orm";
import type { StoredProjectSource } from "./venom-scheduled-source-sync.js";
import {
  clearSourceSyncAlertsForSources,
  countUnreadSourceSyncAlerts,
  listActiveSourceSyncAlerts,
  markAllSourceSyncAlertsRead,
  recordSourceSyncFailureAlert,
  type WorkspaceStateLoader,
} from "./venom-source-sync-alerts.js";
import {
  SOURCE_SYNC_ALERT_FAILURE_THRESHOLD,
  isSourceSyncAlertStillRelevant,
  normalizeSourceSyncAlertError,
  normalizeSourceSyncAlertName,
  sourceSyncAlertProvider,
} from "./venom-source-sync-alerts-core.js";

const NOW = Date.now();
const HOUR_MS = 60 * 60_000;

const createdUserIds: string[] = [];

function testUser(): string {
  const userId = `user_alerts_${randomUUID().slice(0, 18)}`;
  createdUserIds.push(userId);
  return userId;
}

const GITHUB_ERROR =
  "Your GitHub connection isn't working. Reconnect GitHub or ask the workspace owner.";

function githubSource(
  overrides: Partial<StoredProjectSource> = {},
): StoredProjectSource {
  return {
    id: "proj1-github-octocat-hello",
    projectId: "proj1",
    provider: "github",
    name: "octocat/hello",
    url: "https://github.com/octocat/hello",
    syncedAt: new Date(NOW - 3 * 24 * HOUR_MS).toISOString(),
    schedule: {
      cadence: "daily",
      updatedAt: NOW - 5 * 24 * HOUR_MS,
      lastAttemptAt: NOW,
      lastError: GITHUB_ERROR,
    },
    ...overrides,
  };
}

/** Loader standing in for the stored workspace blob. */
function loaderFor(sources: StoredProjectSource[]): WorkspaceStateLoader {
  return async () => ({ sources });
}

const explodingLoader: WorkspaceStateLoader = async () => {
  throw new Error("the workspace blob must not be loaded on this path");
};

async function recordStreak(
  userId: string,
  source: StoredProjectSource,
  attempts: number,
  startAt = NOW,
): Promise<void> {
  for (let index = 0; index < attempts; index += 1) {
    await recordSourceSyncFailureAlert({
      clerkUserId: userId,
      source,
      message: GITHUB_ERROR,
      failedAt: startAt + index * HOUR_MS,
    });
  }
}

async function rowsFor(userId: string) {
  return db
    .select()
    .from(venomSourceSyncAlertsTable)
    .where(eq(venomSourceSyncAlertsTable.clerkUserId, userId));
}

async function ensureSourceSyncAlertTestSchema(): Promise<void> {
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS venom_source_sync_alerts (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      clerk_user_id text NOT NULL,
      source_id text NOT NULL,
      project_id text NOT NULL,
      provider text NOT NULL,
      source_name text NOT NULL,
      consecutive_failures integer NOT NULL DEFAULT 1,
      last_error text NOT NULL,
      first_failed_at timestamptz NOT NULL,
      last_failed_at timestamptz NOT NULL,
      triggered_at timestamptz,
      read_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT venom_source_sync_alerts_provider_check
        CHECK (provider IN ('github', 'website'))
    )
  `);
  await db.execute(sql`
    CREATE UNIQUE INDEX IF NOT EXISTS venom_source_sync_alerts_user_source_idx
      ON venom_source_sync_alerts (clerk_user_id, source_id)
  `);
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS venom_source_sync_alerts_user_triggered_idx
      ON venom_source_sync_alerts (clerk_user_id, triggered_at)
  `);
}

test.before(async () => {
  await ensureSourceSyncAlertTestSchema();
});

test.after(async () => {
  if (createdUserIds.length > 0) {
    await db
      .delete(venomSourceSyncAlertsTable)
      .where(inArray(venomSourceSyncAlertsTable.clerkUserId, createdUserIds));
  }
  await pool.end();
});

test("pure helpers: provider gate, normalization, relevance", () => {
  assert.equal(sourceSyncAlertProvider("github"), "github");
  assert.equal(sourceSyncAlertProvider("website"), "website");
  assert.equal(sourceSyncAlertProvider("notion"), null);

  assert.equal(normalizeSourceSyncAlertName("  "), "Untitled source");
  assert.equal(normalizeSourceSyncAlertName(undefined), "Untitled source");
  assert.equal(normalizeSourceSyncAlertName(" octocat/hello "), "octocat/hello");
  assert.equal(normalizeSourceSyncAlertError("   "), "Venom could not update this source.");
  assert.equal(normalizeSourceSyncAlertError("x".repeat(400)).length, 300);

  const live = githubSource();
  assert.equal(isSourceSyncAlertStillRelevant(live.id, [live]), true);
  // Source gone entirely.
  assert.equal(isSourceSyncAlertStillRelevant(live.id, []), false);
  // Schedule turned off.
  assert.equal(
    isSourceSyncAlertStillRelevant(live.id, [
      githubSource({ schedule: undefined }),
    ]),
    false,
  );
  // Cadence no longer unattended.
  assert.equal(
    isSourceSyncAlertStillRelevant(live.id, [
      githubSource({ schedule: { cadence: "off", lastError: GITHUB_ERROR } }),
    ]),
    false,
  );
  // A client-side refresh already cleared the card.
  assert.equal(
    isSourceSyncAlertStillRelevant(live.id, [
      githubSource({ schedule: { cadence: "daily" } }),
    ]),
    false,
  );
});

test("the streak triggers on the third consecutive failure", async () => {
  const userId = testUser();
  const source = githubSource();
  const loader = loaderFor([source]);

  await recordStreak(userId, source, SOURCE_SYNC_ALERT_FAILURE_THRESHOLD - 1);

  // Two failures: a row exists but nothing is triggered, so the badge stays
  // dark and the cheap count never touches the workspace blob.
  assert.equal(await countUnreadSourceSyncAlerts(userId, explodingLoader), 0);
  assert.deepEqual(await listActiveSourceSyncAlerts(userId, loader), []);
  const [quiet] = await rowsFor(userId);
  assert.equal(quiet.consecutiveFailures, 2);
  assert.equal(quiet.triggeredAt, null);

  // Third failure crosses the threshold.
  await recordSourceSyncFailureAlert({
    clerkUserId: userId,
    source,
    message: GITHUB_ERROR,
    failedAt: NOW + 2 * HOUR_MS,
  });

  const alerts = await listActiveSourceSyncAlerts(userId, loader);
  assert.equal(alerts.length, 1);
  const alert = alerts[0];
  assert.equal(alert.sourceId, source.id);
  assert.equal(alert.projectId, "proj1");
  assert.equal(alert.provider, "github");
  assert.equal(alert.sourceName, "octocat/hello");
  assert.equal(alert.consecutiveFailures, 3);
  assert.equal(alert.lastError, GITHUB_ERROR);
  assert.equal(alert.firstFailedAt.getTime(), NOW);
  assert.equal(alert.lastFailedAt.getTime(), NOW + 2 * HOUR_MS);
  assert.ok(alert.triggeredAt, "crossing the threshold stamps triggeredAt");
  assert.equal(alert.readAt, null);
  assert.equal(await countUnreadSourceSyncAlerts(userId, loader), 1);
});

test("a successful sync deletes the alert outright", async () => {
  const userId = testUser();
  const source = githubSource();
  await recordStreak(userId, source, 4);
  assert.equal((await rowsFor(userId)).length, 1);

  // The worker reports both the previous and refreshed deterministic ids.
  await clearSourceSyncAlertsForSources(userId, [source.id, "proj1-github-renamed"]);

  assert.deepEqual(await rowsFor(userId), []);
  assert.equal(await countUnreadSourceSyncAlerts(userId, explodingLoader), 0);
});

test("read-all silences the badge but keeps the alert listed until it resolves", async () => {
  const userId = testUser();
  const source = githubSource();
  const loader = loaderFor([source]);
  await recordStreak(userId, source, 3);

  assert.equal(await markAllSourceSyncAlertsRead(userId), 1);
  // Repeat calls have nothing left to stamp.
  assert.equal(await markAllSourceSyncAlertsRead(userId), 0);

  // Badge dark — and cheaply so: no unread rows means no workspace load.
  assert.equal(await countUnreadSourceSyncAlerts(userId, explodingLoader), 0);

  // The alert itself still shows while the failure persists.
  const listed = await listActiveSourceSyncAlerts(userId, loader);
  assert.equal(listed.length, 1);
  assert.ok(listed[0].readAt, "read stamp survives");

  // Further failures keep counting without re-lighting the badge…
  await recordSourceSyncFailureAlert({
    clerkUserId: userId,
    source,
    message: GITHUB_ERROR,
    failedAt: NOW + 3 * HOUR_MS,
  });
  const [row] = await rowsFor(userId);
  assert.equal(row.consecutiveFailures, 4);
  assert.ok(row.readAt);
  assert.equal(await countUnreadSourceSyncAlerts(userId, loader), 0);

  // …but a brand-new streak after a resolution arrives unread again.
  await clearSourceSyncAlertsForSources(userId, [source.id]);
  await recordStreak(userId, source, 3, NOW + 10 * HOUR_MS);
  assert.equal(await countUnreadSourceSyncAlerts(userId, loader), 1);
});

test("reconciliation prunes alerts the workspace no longer backs", async () => {
  const cases: Array<{
    label: string;
    remaining: StoredProjectSource[];
  }> = [
    { label: "source removed", remaining: [] },
    {
      label: "schedule turned off",
      remaining: [githubSource({ schedule: undefined })],
    },
    {
      label: "client refresh cleared the card",
      remaining: [
        githubSource({
          schedule: { cadence: "daily", updatedAt: NOW, lastAttemptAt: NOW },
        }),
      ],
    },
  ];

  for (const testCase of cases) {
    const userId = testUser();
    await recordStreak(userId, githubSource(), 3);

    const listed = await listActiveSourceSyncAlerts(
      userId,
      loaderFor(testCase.remaining),
    );
    assert.deepEqual(listed, [], testCase.label);
    assert.deepEqual(
      await rowsFor(userId),
      [],
      `${testCase.label}: stale row is deleted, not just hidden`,
    );
  }
});

test("providers without unattended sync never create alert rows", async () => {
  const userId = testUser();
  await recordSourceSyncFailureAlert({
    clerkUserId: userId,
    source: githubSource({ provider: "notion" }),
    message: GITHUB_ERROR,
    failedAt: NOW,
  });
  assert.deepEqual(await rowsFor(userId), []);
});

test("stored fields are normalized to their bounds", async () => {
  const userId = testUser();
  await recordSourceSyncFailureAlert({
    clerkUserId: userId,
    source: githubSource({ name: "   " }),
    message: `broken: ${"x".repeat(400)}`,
    failedAt: NOW,
  });
  const [row] = await rowsFor(userId);
  assert.equal(row.sourceName, "Untitled source");
  assert.equal(row.lastError.length, 300);
});
