/**
 * Cross-device merge rules for the synced Venom workspace.
 *
 * The phone app (artifacts/venom) and the desktop app (artifacts/venom-desktop)
 * both read and write the same cloud snapshot, so they must apply *identical*
 * rules when they merge connected sources, deletion markers, and scheduled-sync
 * bookkeeping. If one side revives an entity the other retired, it writes the
 * revival straight back to the cloud and the fix is undone.
 *
 * This package is the single home for those rules. Both apps re-export from
 * here, and each app's test suite asserts — by reference identity — that its
 * exports ARE these functions, so hand-rolling a local copy on one side fails
 * the tests. Change the rules here, and only here.
 *
 * The API server's unattended-sync worker
 * (artifacts/api-server/src/lib/venom-scheduled-source-sync.ts) imports the
 * deletion-marker rules from here too and identity-guards them in its suite,
 * so the marker semantics cannot drift server-side. Only the cadence-pacing
 * rules remain mirrored there on the server's stored types (matching the
 * phone's sourceState.ts); keep those in mind when pacing semantics change.
 *
 * Imports from @workspace/api-client-react are type-only on purpose: this
 * module is loaded at runtime by `node --test --experimental-strip-types`
 * suites in both apps, which cannot load the client package's runtime deps.
 */
import type {
  ProjectSource,
  ProjectSourceSchedule,
  VenomDeletionMarker,
  VenomWorkspaceState,
  VenomWorkspaceTombstones,
} from '@workspace/api-client-react';

// Knowledge-map placement rules for chat-derived clusters: the shared spacing
// floor, the legacy label hash, clearance-aware placement for new clusters,
// and the stacked-position repair both apps run on normalize + merge.
export * from './clusterPlacement.ts';

// Board-stage normalization: the duplicate-name rule (keep every column,
// rename collisions deterministically — never drop) both apps must apply
// identically on load and merge.
export * from './boardStages.ts';

// Undo for project deletion: capture what a delete removes, restore it under
// fresh ids so the delete's tombstones stay authoritative on every device.
export * from './projectRestore.ts';

const MINUTE_MS = 60_000;

// ---------------------------------------------------------------------------
// Deletion markers
// ---------------------------------------------------------------------------

/**
 * A source retired by a refresh is gone for good: something newer already
 * stands in its place, so no incoming copy — however recent it claims to be —
 * may bring it back. A plain removal keeps the softer rule, because
 * reconnecting the same source afterwards has to be allowed.
 */
export function isReplacementMarker(marker: VenomDeletionMarker): boolean {
  return marker.replaced === true;
}

/**
 * Builds tombstones for freshly deleted entity ids. `replaced` marks an entity
 * a newer snapshot took the place of (a refreshed source), which is a
 * permanent retirement rather than a plain deletion.
 */
export function createDeletionMarkers(
  ids: string[],
  deletedAt: number,
  options: { replaced?: boolean } = {},
): VenomDeletionMarker[] {
  return [...new Set(ids)].map((id) => ({
    id,
    deletedAt,
    ...(options.replaced ? { replaced: true as const } : {}),
  }));
}

/**
 * Merges any number of deletion-marker lists for one collection, newest
 * `deletedAt` per id winning, and caps the result.
 *
 * Only source markers ever carry `replaced` today, but the rule is applied
 * uniformly to every collection so both apps agree byte-for-byte no matter
 * what a future payload contains.
 */
export function mergeDeletionMarkers(
  limit: number,
  ...markerLists: VenomDeletionMarker[][]
): VenomDeletionMarker[] {
  const merged = new Map<string, VenomDeletionMarker>();
  for (const marker of markerLists.flat()) {
    const existing = merged.get(marker.id);
    const winner =
      !existing || marker.deletedAt > existing.deletedAt ? marker : existing;
    // "Replaced" is sticky: once any device has seen the source retired by a
    // refresh, a later plain deletion marker for the same id must not downgrade
    // the tombstone back into one a stale snapshot can beat.
    const replaced =
      isReplacementMarker(marker) ||
      (!!existing && isReplacementMarker(existing));
    merged.set(
      marker.id,
      replaced === isReplacementMarker(winner)
        ? winner
        : { ...winner, replaced: true },
    );
  }

  return boundDeletionMarkers([...merged.values()], limit);
}

/**
 * Caps the tombstone list without letting a permanent retirement fall off the
 * end. Plain deletion markers are evicted oldest-first as before; replacement
 * markers are kept in preference to them, because losing one would let a stale
 * device hand a refreshed-away source back. Only a workspace whose replacement
 * markers alone fill the cap can shed one, and then the newest survive.
 */
function boundDeletionMarkers(
  markers: VenomDeletionMarker[],
  limit: number,
): VenomDeletionMarker[] {
  const newestFirst = [...markers].sort(
    (left, right) => right.deletedAt - left.deletedAt,
  );
  if (newestFirst.length <= limit) return newestFirst;

  const replaced = newestFirst.filter(isReplacementMarker);
  if (replaced.length >= limit) return replaced.slice(0, limit);

  const deleted = newestFirst.filter((marker) => !isReplacementMarker(marker));
  const kept = new Set([
    ...replaced,
    ...deleted.slice(0, limit - replaced.length),
  ]);
  return newestFirst.filter((marker) => kept.has(marker));
}

// ---------------------------------------------------------------------------
// Tombstone collections
// ---------------------------------------------------------------------------

type WorkspaceTombstones = VenomWorkspaceTombstones;

export type TombstoneCollection = keyof WorkspaceTombstones;

/**
 * Per-collection caps for the tombstone lists. Match the maxItems bounds of
 * VenomWorkspaceTombstones in the API schema so a merged workspace always
 * passes server validation.
 */
export const TOMBSTONE_LIMITS: Record<TombstoneCollection, number> = {
  projects: 1000,
  tasks: 5000,
  conversations: 1000,
  messages: 10000,
  clusters: 2000,
  stages: 15000,
  fields: 20000,
  sources: 2000,
};

export function createEmptyTombstones(): WorkspaceTombstones {
  return {
    projects: [],
    tasks: [],
    conversations: [],
    messages: [],
    clusters: [],
    stages: [],
    fields: [],
    sources: [],
  };
}

export function normalizeTombstones(
  tombstones: VenomWorkspaceState['tombstones'],
): WorkspaceTombstones {
  const empty = createEmptyTombstones();
  if (!tombstones) return empty;

  return {
    projects: mergeDeletionMarkers(
      TOMBSTONE_LIMITS.projects,
      tombstones.projects ?? [],
    ),
    tasks: mergeDeletionMarkers(
      TOMBSTONE_LIMITS.tasks,
      tombstones.tasks ?? [],
    ),
    conversations: mergeDeletionMarkers(
      TOMBSTONE_LIMITS.conversations,
      tombstones.conversations ?? [],
    ),
    messages: mergeDeletionMarkers(
      TOMBSTONE_LIMITS.messages,
      tombstones.messages ?? [],
    ),
    clusters: mergeDeletionMarkers(
      TOMBSTONE_LIMITS.clusters,
      tombstones.clusters ?? [],
    ),
    stages: mergeDeletionMarkers(
      TOMBSTONE_LIMITS.stages,
      tombstones.stages ?? [],
    ),
    fields: mergeDeletionMarkers(
      TOMBSTONE_LIMITS.fields,
      tombstones.fields ?? [],
    ),
    sources: mergeDeletionMarkers(
      TOMBSTONE_LIMITS.sources,
      tombstones.sources ?? [],
    ),
  };
}

export function mergeTombstones(
  current: VenomWorkspaceState['tombstones'],
  additions: Partial<WorkspaceTombstones>,
): WorkspaceTombstones {
  const normalized = normalizeTombstones(current);
  return {
    projects: mergeDeletionMarkers(
      TOMBSTONE_LIMITS.projects,
      normalized.projects,
      additions.projects ?? [],
    ),
    tasks: mergeDeletionMarkers(
      TOMBSTONE_LIMITS.tasks,
      normalized.tasks,
      additions.tasks ?? [],
    ),
    conversations: mergeDeletionMarkers(
      TOMBSTONE_LIMITS.conversations,
      normalized.conversations,
      additions.conversations ?? [],
    ),
    messages: mergeDeletionMarkers(
      TOMBSTONE_LIMITS.messages,
      normalized.messages,
      additions.messages ?? [],
    ),
    clusters: mergeDeletionMarkers(
      TOMBSTONE_LIMITS.clusters,
      normalized.clusters,
      additions.clusters ?? [],
    ),
    stages: mergeDeletionMarkers(
      TOMBSTONE_LIMITS.stages,
      normalized.stages,
      additions.stages ?? [],
    ),
    fields: mergeDeletionMarkers(
      TOMBSTONE_LIMITS.fields,
      normalized.fields,
      additions.fields ?? [],
    ),
    sources: mergeDeletionMarkers(
      TOMBSTONE_LIMITS.sources,
      normalized.sources,
      additions.sources ?? [],
    ),
  };
}

// ---------------------------------------------------------------------------
// Scheduled-sync claims and schedule merging
// ---------------------------------------------------------------------------

/**
 * How long a device's claim on a scheduled sync stays live. The schedule runs
 * on every signed-in device, so before firing the connect request a device
 * records a claim in the synced workspace; other devices treat a claimed
 * source as not due until the lease runs out. Long enough to cover the
 * slowest connect request, short enough that a device that went offline
 * mid-sync only delays the source by minutes instead of stranding it.
 */
export const SCHEDULED_SYNC_CLAIM_LEASE_MS = 10 * MINUTE_MS;

export type ScheduledSyncClaim = { claimedAt: number; claimedBy: string };

/**
 * The unresolved claim carried by a schedule, if any. Any attempt recorded at
 * or after the claim is that claim's outcome (the claiming device's own
 * completion, or another device's sync that made this one moot), so a claim
 * older than the last attempt is spent and needs no explicit release.
 */
export function scheduleSyncClaim(
  schedule: ProjectSourceSchedule,
): ScheduledSyncClaim | null {
  const claimedAt =
    typeof schedule.claimedAt === 'number' &&
    Number.isFinite(schedule.claimedAt)
      ? schedule.claimedAt
      : null;
  const claimedBy =
    typeof schedule.claimedBy === 'string' && schedule.claimedBy
      ? schedule.claimedBy
      : null;
  if (claimedAt === null || claimedBy === null) return null;
  if (claimedAt <= (scheduleAttemptAt(schedule) ?? -1)) return null;
  return { claimedAt, claimedBy };
}

/**
 * Which claim survives a merge of two copies of the same schedule. A claim
 * staked a full lease after another is a takeover of a lease that ran out, so
 * the newer one is real; anything closer is two devices racing for the same
 * slot, and the copy already in place wins — in a cloud-vs-device merge that
 * is whichever device's save landed first.
 */
function mergeScheduleSyncClaims(
  current: ProjectSourceSchedule,
  incoming: ProjectSourceSchedule,
): ScheduledSyncClaim | null {
  const left = scheduleSyncClaim(current);
  const right = scheduleSyncClaim(incoming);
  if (!left || !right) return left ?? right;
  if (
    Math.abs(left.claimedAt - right.claimedAt) >= SCHEDULED_SYNC_CLAIM_LEASE_MS
  ) {
    return left.claimedAt >= right.claimedAt ? left : right;
  }
  return left;
}

/** The last recorded sync attempt on a schedule, if the timestamp is usable. */
export function scheduleAttemptAt(
  schedule: ProjectSourceSchedule,
): number | null {
  return typeof schedule.lastAttemptAt === 'number' &&
    Number.isFinite(schedule.lastAttemptAt)
    ? schedule.lastAttemptAt
    : null;
}

/** When the schedule's cadence last changed, defaulting to the epoch. */
export function scheduleUpdatedAt(schedule: ProjectSourceSchedule): number {
  return typeof schedule.updatedAt === 'number' &&
    Number.isFinite(schedule.updatedAt)
    ? schedule.updatedAt
    : 0;
}

function withSchedule(
  source: ProjectSource,
  schedule: ProjectSourceSchedule | null,
): ProjectSource {
  if (!schedule) {
    if (!source.schedule) return source;
    const { schedule: _unscheduled, ...withoutSchedule } = source;
    return withoutSchedule;
  }

  return source.schedule === schedule ? source : { ...source, schedule };
}

/**
 * Picks the schedule a user set most recently across two copies of the same
 * source. A device that has never seen a schedule holds no opinion, so any
 * schedule beats none; "off" is a schedule of its own and can win.
 */
export function mergeSourceSchedules(
  current: ProjectSource,
  incoming: ProjectSource,
): ProjectSourceSchedule | null {
  const left = current.schedule;
  const right = incoming.schedule;
  if (!left || !right) return right ?? left ?? null;

  const winner =
    scheduleUpdatedAt(right) >= scheduleUpdatedAt(left) ? right : left;
  if (winner.cadence === 'off') return winner;

  // Attempt bookkeeping is written by whichever device ran the sync, so keep
  // the most recent attempt even when the other side set the cadence.
  const attempt =
    (scheduleAttemptAt(right) ?? -1) >= (scheduleAttemptAt(left) ?? -1)
      ? right
      : left;
  // A claim is resolved by an attempt recorded at or after it no matter which
  // side ran it, so the surviving claim is re-checked against the merged
  // attempt instead of only its own side's.
  const claim = mergeScheduleSyncClaims(left, right);
  const liveClaim =
    claim && claim.claimedAt > (scheduleAttemptAt(attempt) ?? -1)
      ? claim
      : null;

  return {
    cadence: winner.cadence,
    updatedAt: scheduleUpdatedAt(winner),
    ...(scheduleAttemptAt(attempt) !== null
      ? { lastAttemptAt: attempt.lastAttemptAt }
      : {}),
    ...(attempt.lastError ? { lastError: attempt.lastError } : {}),
    ...(liveClaim
      ? { claimedAt: liveClaim.claimedAt, claimedBy: liveClaim.claimedBy }
      : {}),
  };
}

// ---------------------------------------------------------------------------
// Source merging
// ---------------------------------------------------------------------------

/**
 * Merges two copies of the connected-source list, newest snapshot per id
 * winning, then drops every source a deletion marker retires. Replacement
 * markers suppress their id unconditionally; plain deletions lose to a source
 * whose snapshot is newer than the tombstone (a legitimate reconnect).
 */
export function mergeProjectSources(
  current: ProjectSource[],
  incoming: ProjectSource[],
  deletionMarkers: VenomDeletionMarker[] = [],
): ProjectSource[] {
  const byId = new Map(current.map((source) => [source.id, source]));
  for (const source of incoming) {
    const existing = byId.get(source.id);
    if (!existing) {
      byId.set(source.id, source);
      continue;
    }

    // The snapshot and the schedule are edited independently: a cadence change
    // never moves syncedAt, so picking the newer snapshot must not silently
    // discard the newer schedule (or the other way round).
    const winner = source.syncedAt >= existing.syncedAt ? source : existing;
    byId.set(
      source.id,
      withSchedule(winner, mergeSourceSchedules(existing, source)),
    );
  }

  const markersById = new Map(
    deletionMarkers.map((marker) => [marker.id, marker] as const),
  );
  return [...byId.values()].filter((source) => {
    const marker = markersById.get(source.id);
    if (!marker) return true;
    // A refresh already put a newer source in this one's place, so its id can
    // never legitimately return: a device whose clock runs fast (or that
    // re-synced the old id before it learned about the refresh) must not
    // resurrect it just by claiming a snapshot newer than the tombstone.
    if (isReplacementMarker(marker)) return false;
    return marker.deletedAt < Date.parse(source.syncedAt);
  });
}
