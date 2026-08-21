import assert from "node:assert/strict";
import test from "node:test";

import {
  claimScheduledSync,
  claimedScheduledSyncRunnable,
  describeLastSync,
  describeSourceSchedule,
  isScheduledSyncDue,
  mergeProjectSources,
  mergeSourceDeletionMarkers,
  nextScheduledSource,
  recordScheduledSyncFailure,
  releaseScheduledSyncClaim,
  replaceRefreshedSource,
  SCHEDULED_SYNC_CLAIM_LEASE_MS,
  scheduledSyncDueAt,
  scheduleSyncClaim,
  setSourceSchedule,
  sourceRefreshRequest,
  sourceScheduleClaim,
} from "./sourceState.ts";

const websiteSource = (overrides = {}) => ({
  id: "source-web",
  projectId: "project-1",
  provider: "website",
  name: "Example Domain",
  url: "https://example.com/",
  status: "connected",
  syncedAt: "2026-08-20T10:00:00.000Z",
  summary: "Example",
  context: "[source:cite_web_old] website: Example",
  citations: [
    {
      id: "cite_web_old",
      provider: "website",
      kind: "website",
      title: "Example Domain",
      url: "https://example.com/",
      excerpt: "Old copy",
      reference: null,
    },
  ],
  clusters: [],
  ...overrides,
});

test("a device deletion tombstone prevents stale cloud source resurrection", () => {
  const cloudSource = {
    id: "source-1",
    projectId: "project-1",
    provider: "website",
    externalId: "https://example.com/",
    title: "Example Domain",
    url: "https://example.com/",
    status: "connected",
    syncedAt: "2026-08-20T10:00:00.000Z",
    context: "[source:website-1] Example",
    citations: [],
    clusters: [],
  };
  const sourceTombstones = mergeSourceDeletionMarkers(
    2_000,
    [],
    [{ id: cloudSource.id, deletedAt: Date.parse(cloudSource.syncedAt) + 1 }],
  );

  assert.deepEqual(
    mergeProjectSources([cloudSource], [], sourceTombstones),
    [],
  );
  assert.deepEqual(sourceTombstones.map((marker) => marker.id), [
    cloudSource.id,
  ]);
});
test("a removed source stays removed when a workspace merge replays it", () => {
  const removed = websiteSource();
  const deletedAt = Date.parse(removed.syncedAt) + 5_000;
  const tombstones = mergeSourceDeletionMarkers(2_000, [
    { id: removed.id, deletedAt },
  ]);

  // The device already dropped the source, but a workspace merge replays the
  // copy the removal has not reached yet.
  assert.deepEqual(mergeProjectSources([], [removed], tombstones), []);
  // The tombstone also wins while both sides still carry the stale source.
  assert.deepEqual(mergeProjectSources([removed], [removed], tombstones), []);

  // Reconnecting the same source after the removal is still allowed back in.
  const reconnected = websiteSource({
    syncedAt: new Date(deletedAt + 1_000).toISOString(),
  });
  assert.deepEqual(
    mergeProjectSources([], [reconnected], tombstones).map(
      (source) => source.syncedAt,
    ),
    [reconnected.syncedAt],
  );
});

test("a source retired by a refresh stays retired against a fast clock", () => {
  const retired = websiteSource();
  const refreshedAt = Date.parse(retired.syncedAt) + 1_000;
  const tombstones = mergeSourceDeletionMarkers(2_000, [
    { id: retired.id, deletedAt: refreshedAt, replaced: true },
  ]);

  // Another device auto-synced the old id (or simply runs ahead of this one),
  // so its snapshot claims a time well past the refresh.
  const resurrected = websiteSource({
    syncedAt: new Date(refreshedAt + 60_000).toISOString(),
  });
  assert.deepEqual(mergeProjectSources([], [resurrected], tombstones), []);
  assert.deepEqual(
    mergeProjectSources([resurrected], [resurrected], tombstones),
    [],
  );

  // Sources the refresh never touched are unaffected.
  const other = websiteSource({ id: "source-other", url: "https://other.test/" });
  assert.deepEqual(
    mergeProjectSources([other], [resurrected], tombstones).map(
      (source) => source.id,
    ),
    [other.id],
  );
});

test("a replacement tombstone survives a later plain deletion marker", () => {
  const retired = websiteSource();
  const refreshedAt = Date.parse(retired.syncedAt) + 1_000;
  const tombstones = mergeSourceDeletionMarkers(
    2_000,
    [{ id: retired.id, deletedAt: refreshedAt, replaced: true }],
    // A device that only knows about a plain removal writes a later marker for
    // the same id; that must not downgrade the permanent retirement.
    [{ id: retired.id, deletedAt: refreshedAt + 5_000 }],
  );

  assert.deepEqual(tombstones, [
    { id: retired.id, deletedAt: refreshedAt + 5_000, replaced: true },
  ]);
  assert.deepEqual(
    mergeProjectSources(
      [],
      [
        websiteSource({
          syncedAt: new Date(refreshedAt + 10_000).toISOString(),
        }),
      ],
      tombstones,
    ),
    [],
  );
});

test("a replacement tombstone survives a full deletion history", () => {
  const retired = websiteSource();
  const refreshedAt = Date.parse(retired.syncedAt) + 1_000;
  const limit = 50;
  // Enough later plain deletions to overflow the cap several times over: the
  // permanent retirement must not be the entry that gets evicted.
  const churn = Array.from({ length: limit * 3 }, (_, index) => ({
    id: `source-churn-${index}`,
    deletedAt: refreshedAt + 1_000 + index,
  }));
  const tombstones = mergeSourceDeletionMarkers(
    limit,
    [{ id: retired.id, deletedAt: refreshedAt, replaced: true }],
    churn,
  );

  assert.equal(tombstones.length, limit);
  assert.deepEqual(
    tombstones.filter((marker) => marker.replaced === true),
    [{ id: retired.id, deletedAt: refreshedAt, replaced: true }],
  );
  // Still newest-first, so the plain markers evicted are the oldest ones.
  assert.deepEqual(
    [...tombstones].sort((left, right) => right.deletedAt - left.deletedAt),
    tombstones,
  );
  assert.deepEqual(
    mergeProjectSources(
      [],
      [
        websiteSource({
          syncedAt: new Date(refreshedAt + 500_000).toISOString(),
        }),
      ],
      tombstones,
    ),
    [],
  );
});

test("a re-synced source that was never retired still wins", () => {
  const source = websiteSource();
  const resynced = websiteSource({ syncedAt: "2026-08-20T12:00:00.000Z" });

  // No tombstone at all: the newer snapshot replaces the older one.
  assert.deepEqual(
    mergeProjectSources([source], [resynced]).map((item) => item.syncedAt),
    [resynced.syncedAt],
  );

  // A plain deletion of a different source leaves this one alone.
  const tombstones = mergeSourceDeletionMarkers(2_000, [
    { id: "source-other", deletedAt: Date.parse(resynced.syncedAt) + 1_000 },
  ]);
  assert.deepEqual(
    mergeProjectSources([source], [resynced], tombstones).map(
      (item) => item.syncedAt,
    ),
    [resynced.syncedAt],
  );
});

test("a refreshed source replaces its previous snapshot in place", () => {
  const previous = websiteSource();
  const other = websiteSource({ id: "source-other", url: "https://other.test/" });
  const refreshed = websiteSource({
    syncedAt: "2026-08-20T12:00:00.000Z",
    summary: "Example refreshed",
    context: "[source:cite_web_new] website: Example",
    citations: [
      {
        id: "cite_web_new",
        provider: "website",
        kind: "website",
        title: "Example Domain",
        url: "https://example.com/",
        excerpt: "New copy",
        reference: null,
      },
    ],
  });

  const result = replaceRefreshedSource(
    [previous, other],
    previous.id,
    refreshed,
  );

  assert.ok(result);
  assert.equal(result.retiredSourceId, null);
  assert.deepEqual(
    result.sources.map((source) => source.id),
    [previous.id, other.id],
  );
  assert.deepEqual(
    result.sources[0].citations.map((citation) => citation.id),
    ["cite_web_new"],
  );
});

test("a refresh that resolves to a new source id retires the old one", () => {
  const previous = websiteSource();
  const refreshed = websiteSource({
    id: "source-web-renamed",
    url: "https://example.com/docs",
    syncedAt: "2026-08-20T12:00:00.000Z",
  });

  const result = replaceRefreshedSource([previous], previous.id, refreshed);

  assert.ok(result);
  assert.equal(result.retiredSourceId, previous.id);
  assert.deepEqual(
    result.sources.map((source) => source.id),
    [refreshed.id],
  );
});

test("a refresh is discarded when its source was removed or is stale", () => {
  const previous = websiteSource();
  const refreshed = websiteSource({ syncedAt: "2026-08-20T12:00:00.000Z" });

  assert.equal(replaceRefreshedSource([], previous.id, refreshed), null);
  assert.equal(
    replaceRefreshedSource(
      [websiteSource({ syncedAt: "2026-08-20T14:00:00.000Z" })],
      previous.id,
      refreshed,
    ),
    null,
  );
  assert.equal(
    replaceRefreshedSource(
      [previous],
      previous.id,
      websiteSource({ projectId: "project-2" }),
    ),
    null,
  );
});

test("refresh requests reuse the original connect input", () => {
  assert.deepEqual(sourceRefreshRequest(websiteSource()), {
    provider: "website",
    projectId: "project-1",
    url: "https://example.com/",
  });
  assert.deepEqual(
    sourceRefreshRequest(
      websiteSource({
        provider: "github",
        name: "acme/venom",
        url: "https://github.com/acme/venom",
      }),
    ),
    { provider: "github", projectId: "project-1", repository: "acme/venom" },
  );
  assert.deepEqual(
    sourceRefreshRequest(
      websiteSource({
        provider: "github",
        name: "Venom repository",
        url: "https://github.com/acme/venom",
      }),
    ),
    { provider: "github", projectId: "project-1", repository: "acme/venom" },
  );
  assert.equal(
    sourceRefreshRequest(websiteSource({ url: "javascript:alert(1)" })),
    null,
  );
});

test("an unattended schedule is only due once its cadence has elapsed", () => {
  const syncedAt = "2026-08-20T10:00:00.000Z";
  const syncedTime = Date.parse(syncedAt);
  const daily = websiteSource({
    syncedAt,
    schedule: { cadence: "daily", updatedAt: 1 },
  });
  const weekly = websiteSource({
    syncedAt,
    schedule: { cadence: "weekly", updatedAt: 1 },
  });

  assert.equal(scheduledSyncDueAt(websiteSource({ syncedAt })), null);
  assert.equal(
    scheduledSyncDueAt(
      websiteSource({ syncedAt, schedule: { cadence: "off", updatedAt: 9 } }),
    ),
    null,
  );
  assert.equal(scheduledSyncDueAt(daily), syncedTime + 86_400_000);
  assert.equal(scheduledSyncDueAt(weekly), syncedTime + 7 * 86_400_000);

  assert.equal(isScheduledSyncDue(daily, syncedTime + 23 * 3_600_000), false);
  assert.equal(isScheduledSyncDue(daily, syncedTime + 86_400_000), true);
  assert.equal(isScheduledSyncDue(weekly, syncedTime + 2 * 86_400_000), false);
});

test("a failed scheduled sync backs off instead of retrying every tick", () => {
  const syncedAt = "2026-08-20T10:00:00.000Z";
  const attemptedAt = Date.parse(syncedAt) + 86_400_000;
  const scheduled = websiteSource({
    syncedAt,
    schedule: { cadence: "daily", updatedAt: 1 },
  });

  const failed = recordScheduledSyncFailure(
    [scheduled],
    scheduled.id,
    attemptedAt,
    "Venom could not read this website.",
  );

  assert.ok(failed);
  assert.deepEqual(failed[0].schedule, {
    cadence: "daily",
    updatedAt: 1,
    lastAttemptAt: attemptedAt,
    lastError: "Venom could not read this website.",
  });
  // The previous snapshot is untouched by a failed unattended sync.
  assert.equal(failed[0].syncedAt, syncedAt);
  assert.deepEqual(failed[0].citations, scheduled.citations);

  assert.equal(isScheduledSyncDue(failed[0], attemptedAt + 60_000), false);
  assert.equal(isScheduledSyncDue(failed[0], attemptedAt + 3_600_000), true);
  assert.equal(
    recordScheduledSyncFailure([scheduled], "missing-source", attemptedAt, "x"),
    null,
  );
  assert.equal(
    recordScheduledSyncFailure(
      [websiteSource({ syncedAt })],
      scheduled.id,
      attemptedAt,
      "x",
    ),
    null,
  );
});

test("a completed refresh keeps the schedule and clears its last failure", () => {
  const previous = websiteSource({
    syncedAt: "2026-08-20T10:00:00.000Z",
    schedule: {
      cadence: "daily",
      updatedAt: 1,
      lastAttemptAt: Date.parse("2026-08-20T11:00:00.000Z"),
      lastError: "Venom could not read this website.",
    },
  });
  const refreshedAt = Date.parse("2026-08-21T12:00:00.000Z");
  const refreshed = websiteSource({ syncedAt: "2026-08-21T12:00:00.000Z" });

  const result = replaceRefreshedSource(
    [previous],
    previous.id,
    refreshed,
    refreshedAt,
  );

  assert.ok(result);
  assert.deepEqual(result.sources[0].schedule, {
    cadence: "daily",
    updatedAt: 1,
    lastAttemptAt: refreshedAt,
  });
  assert.equal(isScheduledSyncDue(result.sources[0], refreshedAt + 60_000), false);
});

test("only the longest overdue scheduled source syncs at a time", () => {
  const now = Date.parse("2026-08-25T10:00:00.000Z");
  const overdue = websiteSource({
    id: "source-overdue",
    url: "https://overdue.test/",
    syncedAt: "2026-08-20T10:00:00.000Z",
    schedule: { cadence: "daily", updatedAt: 1 },
  });
  const barelyDue = websiteSource({
    id: "source-barely",
    url: "https://barely.test/",
    syncedAt: "2026-08-24T09:00:00.000Z",
    schedule: { cadence: "daily", updatedAt: 1 },
  });
  const unscheduled = websiteSource({
    id: "source-manual",
    syncedAt: "2026-08-01T10:00:00.000Z",
  });

  assert.equal(
    nextScheduledSource([barelyDue, unscheduled, overdue], now).id,
    overdue.id,
  );
  assert.equal(nextScheduledSource([unscheduled], now), null);
  assert.equal(
    nextScheduledSource([barelyDue], Date.parse("2026-08-24T20:00:00.000Z")),
    null,
  );
});

test("turning a schedule on, changing it, and turning it off", () => {
  const source = websiteSource({ syncedAt: "2026-08-20T10:00:00.000Z" });

  const daily = setSourceSchedule([source], source.id, "daily", 1_000);
  assert.ok(daily);
  assert.deepEqual(daily[0].schedule, { cadence: "daily", updatedAt: 1_000 });

  const weekly = setSourceSchedule(daily, source.id, "weekly", 2_000);
  assert.ok(weekly);
  assert.deepEqual(weekly[0].schedule, { cadence: "weekly", updatedAt: 2_000 });

  // Turning a schedule off is recorded, not erased, so the decision can win a
  // merge against a device that still has the schedule on.
  const off = setSourceSchedule(weekly, source.id, null, 3_000);
  assert.ok(off);
  assert.deepEqual(off[0].schedule, { cadence: "off", updatedAt: 3_000 });

  // Unchanged selections and unknown sources never churn workspace state.
  assert.equal(setSourceSchedule(daily, source.id, "daily"), null);
  assert.equal(setSourceSchedule([source], source.id, null), null);
  assert.equal(setSourceSchedule(off, source.id, null), null);
  assert.equal(setSourceSchedule([source], "missing-source", "daily"), null);
});

test("schedule labels explain when the next unattended update lands", () => {
  const syncedAt = "2026-08-20T10:00:00.000Z";
  const syncedTime = Date.parse(syncedAt);

  assert.equal(describeSourceSchedule(websiteSource({ syncedAt }), syncedTime), null);
  assert.equal(
    describeSourceSchedule(
      websiteSource({ syncedAt, schedule: { cadence: "daily", updatedAt: 1 } }),
      syncedTime + 3_600_000,
    ),
    "Daily updates · next in 23h",
  );
  assert.equal(
    describeSourceSchedule(
      websiteSource({ syncedAt, schedule: { cadence: "weekly", updatedAt: 1 } }),
      syncedTime,
    ),
    "Weekly updates · next in 7d",
  );
  assert.equal(
    describeSourceSchedule(
      websiteSource({ syncedAt, schedule: { cadence: "daily", updatedAt: 1 } }),
      syncedTime + 2 * 86_400_000,
    ),
    "Daily updates · due now",
  );
  assert.equal(
    describeSourceSchedule(
      websiteSource({
        syncedAt,
        schedule: {
          cadence: "daily",
          updatedAt: 1,
          lastAttemptAt: syncedTime + 86_400_000,
          lastError: "Venom could not read this website.",
        },
      }),
      syncedTime + 86_400_000 + 60_000,
    ),
    "Daily updates · last update failed",
  );
});

test("a schedule set on one device survives a merge with a device that has not seen it", () => {
  const syncedAt = "2026-08-20T10:00:00.000Z";
  const unscheduled = websiteSource({ syncedAt });
  const scheduled = setSourceSchedule([unscheduled], unscheduled.id, "daily", 5_000)[0];

  // A schedule change never moves syncedAt, so the merge must not resolve it
  // by snapshot age in either direction.
  assert.deepEqual(mergeProjectSources([unscheduled], [scheduled])[0].schedule, {
    cadence: "daily",
    updatedAt: 5_000,
  });
  assert.deepEqual(mergeProjectSources([scheduled], [unscheduled])[0].schedule, {
    cadence: "daily",
    updatedAt: 5_000,
  });

  // The most recent cadence choice wins, including turning the schedule off.
  const weekly = setSourceSchedule([scheduled], scheduled.id, "weekly", 6_000)[0];
  const turnedOff = setSourceSchedule([scheduled], scheduled.id, null, 7_000)[0];
  assert.equal(
    mergeProjectSources([weekly], [scheduled])[0].schedule.cadence,
    "weekly",
  );
  assert.deepEqual(mergeProjectSources([weekly], [turnedOff])[0].schedule, {
    cadence: "off",
    updatedAt: 7_000,
  });
  assert.equal(
    describeSourceSchedule(
      mergeProjectSources([weekly], [turnedOff])[0],
      Date.parse(syncedAt),
    ),
    null,
  );
});

test("a merge keeps the newest snapshot and the newest schedule together", () => {
  const scheduled = setSourceSchedule(
    [websiteSource({ syncedAt: "2026-08-20T10:00:00.000Z" })],
    "source-web",
    "daily",
    5_000,
  )[0];
  const attemptedAt = Date.parse("2026-08-21T10:00:00.000Z");

  // Device A recorded a failed unattended sync; device B refreshed the source
  // by hand and knows nothing about the schedule.
  const failedOnA = recordScheduledSyncFailure(
    [scheduled],
    scheduled.id,
    attemptedAt,
    "Venom could not read this website.",
  )[0];
  const refreshedOnB = websiteSource({
    syncedAt: "2026-08-21T12:00:00.000Z",
    summary: "Example refreshed",
  });

  const merged = mergeProjectSources([failedOnA], [refreshedOnB])[0];
  assert.equal(merged.syncedAt, refreshedOnB.syncedAt);
  assert.equal(merged.summary, "Example refreshed");
  assert.deepEqual(merged.schedule, {
    cadence: "daily",
    updatedAt: 5_000,
    lastAttemptAt: attemptedAt,
    lastError: "Venom could not read this website.",
  });
  // The retry backoff recorded on device A still paces the merged source.
  assert.equal(isScheduledSyncDue(merged, attemptedAt + 60_000), false);
  assert.equal(isScheduledSyncDue(merged, attemptedAt + 3_600_000), true);

  // A cadence change on the device that did not run the sync keeps the other
  // device's attempt bookkeeping.
  const weeklyOnB = setSourceSchedule([scheduled], scheduled.id, "weekly", 9_000)[0];
  const mergedCadence = mergeProjectSources([failedOnA], [weeklyOnB])[0];
  assert.deepEqual(mergedCadence.schedule, {
    cadence: "weekly",
    updatedAt: 9_000,
    lastAttemptAt: attemptedAt,
    lastError: "Venom could not read this website.",
  });
});

test("last sync labels stay readable as a source ages", () => {
  const syncedAt = "2026-08-20T10:00:00.000Z";
  const syncedTime = Date.parse(syncedAt);

  assert.equal(describeLastSync(syncedAt, syncedTime + 5_000), "Last synced just now");
  assert.equal(describeLastSync(syncedAt, syncedTime + 5 * 60_000), "Last synced 5m ago");
  assert.equal(describeLastSync(syncedAt, syncedTime + 3 * 3_600_000), "Last synced 3h ago");
  assert.equal(
    describeLastSync(syncedAt, syncedTime + 2 * 86_400_000),
    "Last synced 2d ago",
  );
  assert.equal(
    describeLastSync(syncedAt, syncedTime + 90 * 86_400_000),
    "Last synced 2026-08-20",
  );
});

const LEASE = SCHEDULED_SYNC_CLAIM_LEASE_MS;

test("a claimed source pauses on every device until the lease runs out", () => {
  const syncedTime = Date.parse("2026-08-20T10:00:00.000Z");
  const dueTime = syncedTime + 86_400_000;
  const scheduled = websiteSource({ schedule: { cadence: "daily", updatedAt: 1 } });

  const claimed = claimScheduledSync(
    [scheduled],
    scheduled.id,
    "device-a",
    dueTime,
  )[0];
  assert.deepEqual(claimed.schedule, {
    cadence: "daily",
    updatedAt: 1,
    claimedAt: dueTime,
    claimedBy: "device-a",
  });
  assert.deepEqual(sourceScheduleClaim([claimed], claimed.id), {
    claimedAt: dueTime,
    claimedBy: "device-a",
  });
  assert.equal(sourceScheduleClaim([claimed], "missing"), null);

  // The claim pushes the due time to the end of its lease, so the other
  // devices leave the source alone while the claiming device syncs it...
  assert.equal(scheduledSyncDueAt(claimed), dueTime + LEASE);
  assert.equal(isScheduledSyncDue(claimed, dueTime + 60_000), false);
  assert.equal(nextScheduledSource([claimed], dueTime + 60_000), null);
  // ...but a claim whose device died only delays the source, never strands it.
  assert.equal(isScheduledSyncDue(claimed, dueTime + LEASE), true);
  assert.equal(nextScheduledSource([claimed], dueTime + LEASE).id, claimed.id);

  // Nothing to claim without a live schedule.
  assert.equal(
    claimScheduledSync([websiteSource()], "source-web", "device-a", dueTime),
    null,
  );
  assert.equal(
    claimScheduledSync(
      [websiteSource({ schedule: { cadence: "off", updatedAt: 1 } })],
      "source-web",
      "device-a",
      dueTime,
    ),
    null,
  );
  assert.equal(claimScheduledSync([scheduled], "missing", "device-a", dueTime), null);
});

test("a device only releases its own claim", () => {
  const dueTime = Date.parse("2026-08-21T10:00:00.000Z");
  const scheduled = websiteSource({ schedule: { cadence: "daily", updatedAt: 1 } });
  const claimed = claimScheduledSync([scheduled], scheduled.id, "device-a", dueTime);

  assert.deepEqual(
    releaseScheduledSyncClaim(claimed, scheduled.id, "device-a")[0].schedule,
    { cadence: "daily", updatedAt: 1 },
  );
  assert.equal(releaseScheduledSyncClaim(claimed, scheduled.id, "device-b"), null);
  assert.equal(
    releaseScheduledSyncClaim([scheduled], scheduled.id, "device-a"),
    null,
  );
});

test("a confirmed claim only fires while the source is still stale", () => {
  const syncedAt = "2026-08-20T10:00:00.000Z";
  const dueTime = Date.parse(syncedAt) + 86_400_000;
  const scheduled = websiteSource({
    syncedAt,
    schedule: { cadence: "daily", updatedAt: 1 },
  });
  const claimed = claimScheduledSync(
    [scheduled],
    scheduled.id,
    "device-a",
    dueTime,
  )[0];

  assert.equal(claimedScheduledSyncRunnable(claimed, "device-a", dueTime + 2_000), true);
  // Someone else's claim is never this device's to run.
  assert.equal(claimedScheduledSyncRunnable(claimed, "device-b", dueTime + 2_000), false);
  // An expired lease may already belong to another device.
  assert.equal(claimedScheduledSyncRunnable(claimed, "device-a", dueTime + LEASE), false);
  // A sync another device completed in the meantime makes the claim moot.
  const refreshedElsewhere = {
    ...claimed,
    syncedAt: new Date(dueTime + 1_000).toISOString(),
  };
  assert.equal(
    claimedScheduledSyncRunnable(refreshedElsewhere, "device-a", dueTime + 2_000),
    false,
  );
  // No claim at all, nothing to run.
  assert.equal(claimedScheduledSyncRunnable(scheduled, "device-a", dueTime), false);
});

test("a sync claim survives the merges that carry it between devices", () => {
  const syncedAt = "2026-08-20T10:00:00.000Z";
  const dueTime = Date.parse(syncedAt) + 86_400_000;
  const scheduled = websiteSource({
    syncedAt,
    schedule: { cadence: "daily", updatedAt: 1 },
  });
  const claimedByA = claimScheduledSync(
    [scheduled],
    scheduled.id,
    "device-a",
    dueTime,
  )[0];

  // The device that has not seen the claim yet must not wipe it...
  assert.deepEqual(
    mergeProjectSources([claimedByA], [scheduled])[0].schedule,
    claimedByA.schedule,
  );
  assert.deepEqual(
    mergeProjectSources([scheduled], [claimedByA])[0].schedule,
    claimedByA.schedule,
  );

  // ...even when it changed the cadence while the claim was in flight.
  const recadenced = setSourceSchedule(
    [scheduled],
    scheduled.id,
    "weekly",
    dueTime + 1_000,
  )[0];
  assert.deepEqual(mergeProjectSources([claimedByA], [recadenced])[0].schedule, {
    cadence: "weekly",
    updatedAt: dueTime + 1_000,
    claimedAt: dueTime,
    claimedBy: "device-a",
  });
});

test("two devices claiming the same slot resolve to a single winner", () => {
  const syncedAt = "2026-08-20T10:00:00.000Z";
  const dueTime = Date.parse(syncedAt) + 86_400_000;
  const scheduled = websiteSource({
    syncedAt,
    schedule: { cadence: "daily", updatedAt: 1 },
  });
  const claimedByA = claimScheduledSync(
    [scheduled],
    scheduled.id,
    "device-a",
    dueTime,
  )[0];
  const claimedByB = claimScheduledSync(
    [scheduled],
    scheduled.id,
    "device-b",
    dueTime + 2_000,
  )[0];

  // Within one lease it is a race, and the copy already in place (the cloud
  // side of a conflict merge, the first argument) keeps the slot: whichever
  // device's save landed first wins, on every device that merges.
  assert.equal(
    mergeProjectSources([claimedByA], [claimedByB])[0].schedule.claimedBy,
    "device-a",
  );
  assert.equal(
    mergeProjectSources([claimedByB], [claimedByA])[0].schedule.claimedBy,
    "device-b",
  );

  // A claim staked a full lease later is a takeover of an abandoned slot and
  // wins in both directions.
  const takeover = claimScheduledSync(
    [scheduled],
    scheduled.id,
    "device-b",
    dueTime + LEASE,
  )[0];
  assert.equal(
    mergeProjectSources([claimedByA], [takeover])[0].schedule.claimedBy,
    "device-b",
  );
  assert.equal(
    mergeProjectSources([takeover], [claimedByA])[0].schedule.claimedBy,
    "device-b",
  );
});

test("a finished attempt spends the claim that started it", () => {
  const syncedAt = "2026-08-20T10:00:00.000Z";
  const dueTime = Date.parse(syncedAt) + 86_400_000;
  const scheduled = websiteSource({
    syncedAt,
    schedule: { cadence: "daily", updatedAt: 1 },
  });
  const claimed = claimScheduledSync([scheduled], scheduled.id, "device-a", dueTime);

  // Success replaces the snapshot and re-paces the schedule without a claim.
  const refreshed = websiteSource({
    syncedAt: new Date(dueTime + 90_000).toISOString(),
  });
  const completed = replaceRefreshedSource(
    claimed,
    scheduled.id,
    refreshed,
    dueTime + 90_000,
  );
  assert.deepEqual(completed.sources[0].schedule, {
    cadence: "daily",
    updatedAt: 1,
    lastAttemptAt: dueTime + 90_000,
  });

  // Failure keeps the previous snapshot but still spends the claim.
  const failed = recordScheduledSyncFailure(
    claimed,
    scheduled.id,
    dueTime + 90_000,
    "Venom could not read this website.",
  );
  assert.deepEqual(failed[0].schedule, {
    cadence: "daily",
    updatedAt: 1,
    lastAttemptAt: dueTime + 90_000,
    lastError: "Venom could not read this website.",
  });

  // A device still holding the stale claim loses it to the merged attempt.
  const merged = mergeProjectSources([failed[0]], [claimed[0]])[0];
  assert.equal(scheduleSyncClaim(merged.schedule), null);
  assert.equal(merged.schedule.claimedAt, undefined);
  assert.equal(merged.schedule.claimedBy, undefined);
});

test("schedule labels show a claimed source as updating", () => {
  const syncedAt = "2026-08-20T10:00:00.000Z";
  const dueTime = Date.parse(syncedAt) + 86_400_000;
  const scheduled = websiteSource({
    syncedAt,
    schedule: { cadence: "daily", updatedAt: 1 },
  });
  const claimed = claimScheduledSync(
    [scheduled],
    scheduled.id,
    "device-a",
    dueTime,
  )[0];

  assert.equal(
    describeSourceSchedule(claimed, dueTime + 60_000),
    "Daily updates · updating now",
  );
  // An abandoned claim falls back to plain dueness once the lease runs out.
  assert.equal(
    describeSourceSchedule(claimed, dueTime + LEASE),
    "Daily updates · due now",
  );
});

test("a cadence change carries a live claim instead of unlocking a second device", () => {
  const dueTime = Date.parse("2026-08-21T10:00:00.000Z");
  const scheduled = websiteSource({ schedule: { cadence: "daily", updatedAt: 1 } });
  const claimed = claimScheduledSync([scheduled], scheduled.id, "device-a", dueTime);

  assert.deepEqual(
    setSourceSchedule(claimed, scheduled.id, "weekly", dueTime + 1_000)[0].schedule,
    {
      cadence: "weekly",
      updatedAt: dueTime + 1_000,
      claimedAt: dueTime,
      claimedBy: "device-a",
    },
  );
  // Turning the schedule off retires the claim with it.
  assert.deepEqual(
    setSourceSchedule(claimed, scheduled.id, null, dueTime + 1_000)[0].schedule,
    { cadence: "off", updatedAt: dueTime + 1_000 },
  );
});
