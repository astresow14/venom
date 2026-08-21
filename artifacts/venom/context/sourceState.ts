import type {
  ProjectSource,
  ProjectSourceSchedule,
  ProjectSourceScheduleCadence,
  VenomDeletionMarker,
} from "@workspace/api-client-react";

/**
 * A source retired by a refresh is gone for good: something newer already
 * stands in its place, so no incoming copy — however recent it claims to be —
 * may bring it back. A plain removal keeps the softer rule, because
 * reconnecting the same source afterwards has to be allowed.
 */
export function isReplacementMarker(marker: VenomDeletionMarker): boolean {
  return marker.replaced === true;
}

export function mergeSourceDeletionMarkers(
  limit: number,
  ...markerLists: VenomDeletionMarker[][]
) {
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

  return boundSourceDeletionMarkers([...merged.values()], limit);
}

/**
 * Caps the tombstone list without letting a permanent retirement fall off the
 * end. Plain deletion markers are evicted oldest-first as before; replacement
 * markers are kept in preference to them, because losing one would let a stale
 * device hand a refreshed-away source back. Only a workspace whose replacement
 * markers alone fill the cap can shed one, and then the newest survive.
 */
function boundSourceDeletionMarkers(
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
  const kept = new Set([...replaced, ...deleted.slice(0, limit - replaced.length)]);
  return newestFirst.filter((marker) => kept.has(marker));
}

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/**
 * Human-readable "last successful sync" label for a connected source card.
 */
export function describeLastSync(syncedAt: string, now: number): string {
  const syncedTime = Date.parse(syncedAt);
  if (Number.isNaN(syncedTime)) return "Last synced recently";

  const elapsed = now - syncedTime;
  if (elapsed < 0 || elapsed < MINUTE_MS) return "Last synced just now";
  if (elapsed < HOUR_MS) {
    const minutes = Math.floor(elapsed / MINUTE_MS);
    return `Last synced ${minutes}m ago`;
  }
  if (elapsed < DAY_MS) {
    const hours = Math.floor(elapsed / HOUR_MS);
    return `Last synced ${hours}h ago`;
  }

  const days = Math.floor(elapsed / DAY_MS);
  if (days <= 30) return `Last synced ${days}d ago`;
  return `Last synced ${syncedAt.slice(0, 10)}`;
}

export type SourceScheduleCadence = ProjectSourceScheduleCadence;

/** Cadences a source can actually be updated on, in the order users see them. */
export const SOURCE_SCHEDULE_CADENCES: SourceScheduleCadence[] = [
  "daily",
  "weekly",
];

export const SOURCE_SCHEDULE_CADENCE_LABELS: Record<
  SourceScheduleCadence,
  string
> = {
  off: "Off",
  daily: "Daily",
  weekly: "Weekly",
};

const CADENCE_INTERVAL_MS: Partial<Record<SourceScheduleCadence, number>> = {
  daily: DAY_MS,
  weekly: 7 * DAY_MS,
};

/**
 * A scheduled sync that failed retries well before its next cadence slot, but
 * far enough apart that a source Venom can never read stops hammering the
 * connect endpoint.
 */
const FAILED_SYNC_RETRY_MS = HOUR_MS;

const SOURCE_SCHEDULE_ERROR_MAX_CHARS = 300;

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
    typeof schedule.claimedAt === "number" &&
    Number.isFinite(schedule.claimedAt)
      ? schedule.claimedAt
      : null;
  const claimedBy =
    typeof schedule.claimedBy === "string" && schedule.claimedBy
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

function scheduleInterval(schedule: ProjectSourceSchedule): number | null {
  return CADENCE_INTERVAL_MS[schedule.cadence] ?? null;
}

function scheduleAttemptAt(schedule: ProjectSourceSchedule): number | null {
  return typeof schedule.lastAttemptAt === "number" &&
    Number.isFinite(schedule.lastAttemptAt)
    ? schedule.lastAttemptAt
    : null;
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
function mergeSourceSchedules(
  current: ProjectSource,
  incoming: ProjectSource,
): ProjectSourceSchedule | null {
  const left = current.schedule;
  const right = incoming.schedule;
  if (!left || !right) return right ?? left ?? null;

  const winner =
    scheduleUpdatedAt(right) >= scheduleUpdatedAt(left) ? right : left;
  if (winner.cadence === "off") return winner;

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

/** A source with no schedule is treated as an explicit "off", never synced. */
export function sourceScheduleCadence(
  source: ProjectSource,
): SourceScheduleCadence {
  return source.schedule?.cadence ?? "off";
}

function scheduleUpdatedAt(schedule: ProjectSourceSchedule): number {
  return typeof schedule.updatedAt === "number" &&
    Number.isFinite(schedule.updatedAt)
    ? schedule.updatedAt
    : 0;
}

/**
 * When a scheduled source is next allowed to re-sync, or null when it has no
 * schedule. Successful syncs are paced by the cadence measured from the last
 * snapshot; a failed attempt is paced by the shorter retry window so a
 * temporary outage does not cost a whole cadence.
 *
 * Unattended updates run on the API server now, so schedules hold even when
 * nobody has Venom open. The pacing and replace rules from here down to
 * replaceRefreshedSource are mirrored by that worker
 * (artifacts/api-server/src/lib/venom-scheduled-source-sync.ts); the client
 * keeps them to render cards and merge schedule bookkeeping across devices.
 * Change the two sides together.
 */
export function scheduledSyncDueAt(source: ProjectSource): number | null {
  const schedule = source.schedule;
  if (!schedule) return null;

  const interval = scheduleInterval(schedule);
  if (interval === null) return null;

  const dueAt = underlyingScheduledSyncDueAt(source, schedule, interval);
  // A live claim means some signed-in device is already on this source, so
  // everyone else holds back until the claim's lease has run out.
  const claim = scheduleSyncClaim(schedule);
  return claim
    ? Math.max(dueAt, claim.claimedAt + SCHEDULED_SYNC_CLAIM_LEASE_MS)
    : dueAt;
}

/** When the schedule itself says the source needs a re-sync, claims aside. */
function underlyingScheduledSyncDueAt(
  source: ProjectSource,
  schedule: ProjectSourceSchedule,
  interval: number,
): number {
  const lastAttemptAt = scheduleAttemptAt(schedule);
  if (lastAttemptAt !== null && schedule.lastError) {
    return lastAttemptAt + FAILED_SYNC_RETRY_MS;
  }

  const syncedAt = Date.parse(source.syncedAt);
  return (
    Math.max(Number.isNaN(syncedAt) ? 0 : syncedAt, lastAttemptAt ?? 0) +
    interval
  );
}

export function isScheduledSyncDue(
  source: ProjectSource,
  now: number,
): boolean {
  const dueAt = scheduledSyncDueAt(source);
  return dueAt !== null && dueAt <= now;
}

/**
 * The scheduled source that should be re-synced next. Venom syncs one source
 * at a time so an unattended update never floods the connect endpoints, and
 * the longest-overdue source always goes first.
 */
export function nextScheduledSource(
  sources: ProjectSource[],
  now: number,
): ProjectSource | null {
  const due = sources
    .map((source) => ({ source, dueAt: scheduledSyncDueAt(source) }))
    .filter(
      (candidate): candidate is { source: ProjectSource; dueAt: number } =>
        candidate.dueAt !== null && candidate.dueAt <= now,
    )
    .sort(
      (left, right) =>
        left.dueAt - right.dueAt || left.source.id.localeCompare(right.source.id),
    );

  return due.length ? due[0].source : null;
}

/**
 * Turns an unattended update schedule on, changes its cadence, or (with a null
 * cadence) turns it off. Returns null when nothing changed so callers can skip
 * a pointless state update and cloud save.
 */
export function setSourceSchedule(
  sources: ProjectSource[],
  sourceId: string,
  cadence: SourceScheduleCadence | null,
  changedAt: number = Date.now(),
): ProjectSource[] | null {
  const index = sources.findIndex((source) => source.id === sourceId);
  if (index === -1) return null;

  const source = sources[index];
  const nextCadence = cadence ?? "off";
  if (sourceScheduleCadence(source) === nextCadence) return null;

  // Attempt pacing carries across a cadence change; a stale failure does not,
  // because a user picking a different cadence is also asking Venom to retry.
  // A live claim also carries: another device may be mid-sync, and a cadence
  // change must not hand its slot to a second device.
  const lastAttemptAt = source.schedule
    ? scheduleAttemptAt(source.schedule)
    : null;
  const claim = source.schedule ? scheduleSyncClaim(source.schedule) : null;
  const next = [...sources];
  next[index] = {
    ...source,
    schedule:
      nextCadence === "off"
        ? { cadence: "off", updatedAt: changedAt }
        : {
            cadence: nextCadence,
            updatedAt: changedAt,
            ...(lastAttemptAt !== null ? { lastAttemptAt } : {}),
            ...(claim
              ? { claimedAt: claim.claimedAt, claimedBy: claim.claimedBy }
              : {}),
          },
  };
  return next;
}

/**
 * Records a failed unattended sync on the source itself so the failure stays
 * visible on its card, survives a reload, and paces the next retry. The
 * previous snapshot is deliberately left untouched.
 */
export function recordScheduledSyncFailure(
  sources: ProjectSource[],
  sourceId: string,
  attemptedAt: number,
  message: string,
): ProjectSource[] | null {
  const index = sources.findIndex((source) => source.id === sourceId);
  if (index === -1) return null;

  const source = sources[index];
  if (!source.schedule || source.schedule.cadence === "off") return null;

  const lastError =
    message.trim().slice(0, SOURCE_SCHEDULE_ERROR_MAX_CHARS) ||
    "Venom could not update this source.";
  // The failure is this attempt's outcome, so whatever claim staked it is
  // spent and must not keep pausing the schedule on other devices.
  const {
    claimedAt: _claimedAt,
    claimedBy: _claimedBy,
    ...schedule
  } = source.schedule;
  const next = [...sources];
  next[index] = {
    ...source,
    schedule: { ...schedule, lastAttemptAt: attemptedAt, lastError },
  };
  return next;
}

/**
 * Stakes this device's claim on the next scheduled sync of a source. The
 * claim only counts once it has been saved to the account's workspace and
 * read back; recording it in the synced state first is what keeps a second
 * signed-in device from paying for the same update. Returns null when there
 * is nothing to claim so callers can skip a pointless state update.
 */
export function claimScheduledSync(
  sources: ProjectSource[],
  sourceId: string,
  claimedBy: string,
  claimedAt: number = Date.now(),
): ProjectSource[] | null {
  const index = sources.findIndex((source) => source.id === sourceId);
  if (index === -1) return null;

  const source = sources[index];
  const schedule = source.schedule;
  if (!schedule || scheduleInterval(schedule) === null) return null;

  const next = [...sources];
  next[index] = { ...source, schedule: { ...schedule, claimedAt, claimedBy } };
  return next;
}

/**
 * Withdraws this device's own claim (lost save, expired lease, abandoned
 * sync) so the source does not stay paused for the rest of the lease. Another
 * device's claim is left alone.
 */
export function releaseScheduledSyncClaim(
  sources: ProjectSource[],
  sourceId: string,
  claimedBy: string,
): ProjectSource[] | null {
  const index = sources.findIndex((source) => source.id === sourceId);
  if (index === -1) return null;

  const source = sources[index];
  const schedule = source.schedule;
  if (!schedule || schedule.claimedBy !== claimedBy) return null;

  const {
    claimedAt: _claimedAt,
    claimedBy: _claimedBy,
    ...withoutClaim
  } = schedule;
  const next = [...sources];
  next[index] = { ...source, schedule: withoutClaim };
  return next;
}

/** The live claim carried by one source in a list, if any. */
export function sourceScheduleClaim(
  sources: ProjectSource[],
  sourceId: string,
): ScheduledSyncClaim | null {
  const source = sources.find((item) => item.id === sourceId);
  return source?.schedule ? scheduleSyncClaim(source.schedule) : null;
}

/**
 * Whether this device's claim on a source still entitles it to fire the
 * connect request: the claim must still be the schedule's live claim, its
 * lease must not have run out, and the source must still have been due when
 * the claim was staked — a sync another device completed in the meantime
 * re-paces the schedule past the claim and makes it moot.
 */
export function claimedScheduledSyncRunnable(
  source: ProjectSource,
  claimedBy: string,
  now: number,
): boolean {
  const schedule = source.schedule;
  if (!schedule) return false;

  const interval = scheduleInterval(schedule);
  if (interval === null) return false;

  const claim = scheduleSyncClaim(schedule);
  if (!claim || claim.claimedBy !== claimedBy) return false;
  if (now >= claim.claimedAt + SCHEDULED_SYNC_CLAIM_LEASE_MS) return false;

  return (
    underlyingScheduledSyncDueAt(source, schedule, interval) <= claim.claimedAt
  );
}

function describeDuration(elapsed: number): string {
  if (elapsed < HOUR_MS) {
    return `${Math.max(1, Math.round(elapsed / MINUTE_MS))}m`;
  }
  // Rounded rather than truncated so a schedule that was just re-paced reads
  // as a full cadence away instead of a second short of one.
  if (elapsed < DAY_MS) return `${Math.round(elapsed / HOUR_MS)}h`;
  return `${Math.round(elapsed / DAY_MS)}d`;
}

/**
 * Human-readable schedule summary for a connected source card, or null when
 * the source is only updated by hand.
 */
export function describeSourceSchedule(
  source: ProjectSource,
  now: number,
): string | null {
  const schedule = source.schedule;
  if (!schedule || schedule.cadence === "off") return null;

  const cadenceLabel =
    SOURCE_SCHEDULE_CADENCE_LABELS[schedule.cadence] ?? "Scheduled";

  // A live claim means a signed-in device is running this update right now,
  // so every device says so instead of counting down the claim's lease.
  const claim = scheduleSyncClaim(schedule);
  if (claim && now < claim.claimedAt + SCHEDULED_SYNC_CLAIM_LEASE_MS) {
    return `${cadenceLabel} updates · updating now`;
  }

  if (schedule.lastError) return `${cadenceLabel} updates · last update failed`;

  const dueAt = scheduledSyncDueAt(source);
  if (dueAt === null || dueAt <= now) return `${cadenceLabel} updates · due now`;
  return `${cadenceLabel} updates · next in ${describeDuration(dueAt - now)}`;
}

export type SourceRefreshRequest =
  | { provider: "github"; projectId: string; repository: string }
  | { provider: "website"; projectId: string; url: string };

const REPOSITORY_PATH_PATTERN = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;

function githubRepositoryPath(source: ProjectSource): string | null {
  const name = source.name.trim();
  if (REPOSITORY_PATH_PATTERN.test(name)) return name;

  const fromUrl = source.url
    .trim()
    .replace(/^https?:\/\/(www\.)?github\.com\//i, "")
    .replace(/\.git$/i, "")
    .replace(/\/+$/, "");
  return REPOSITORY_PATH_PATTERN.test(fromUrl) ? fromUrl : null;
}

/**
 * Describes how an already-connected source is re-synced. Refresh reuses the
 * original connect request so the server recomputes the same deterministic
 * source id, which is what lets a refresh replace a source in place.
 */
export function sourceRefreshRequest(
  source: ProjectSource,
): SourceRefreshRequest | null {
  if (source.provider === "github") {
    const repository = githubRepositoryPath(source);
    return repository
      ? { provider: "github", projectId: source.projectId, repository }
      : null;
  }

  const url = source.url.trim();
  return /^https:\/\/\S+$/i.test(url)
    ? { provider: "website", projectId: source.projectId, url }
    : null;
}

/**
 * Carries an unattended update schedule across a refresh. The connect
 * endpoints know nothing about schedules, so the refreshed snapshot would
 * otherwise silently drop one. A completed refresh also clears the last
 * failure and re-paces the schedule from this attempt.
 */
function carrySourceSchedule(
  previous: ProjectSource,
  refreshed: ProjectSource,
  refreshedAt: number,
): ProjectSource {
  const schedule = refreshed.schedule ?? previous.schedule;
  if (!schedule) return refreshed;
  if (schedule.cadence === "off") return { ...refreshed, schedule };

  return {
    ...refreshed,
    schedule: {
      cadence: schedule.cadence,
      updatedAt: scheduleUpdatedAt(schedule),
      lastAttemptAt: refreshedAt,
    },
  };
}

/**
 * Swaps a refreshed snapshot in for the source it was refreshed from so stale
 * metadata, citations, and clusters never linger beside the new ones. Returns
 * null when the refresh must be discarded instead of applied.
 */
export function replaceRefreshedSource(
  sources: ProjectSource[],
  previousSourceId: string,
  refreshed: ProjectSource,
  refreshedAt: number = Date.now(),
): { sources: ProjectSource[]; retiredSourceId: string | null } | null {
  const previousIndex = sources.findIndex(
    (source) => source.id === previousSourceId,
  );
  // The source was removed (or never restored) while the refresh was in
  // flight; applying it would resurrect deleted content.
  if (previousIndex === -1) return null;

  const previous = sources[previousIndex];
  if (previous.projectId !== refreshed.projectId) return null;

  const existing = sources.find((source) => source.id === refreshed.id);
  if (
    existing &&
    Date.parse(refreshed.syncedAt) < Date.parse(existing.syncedAt)
  ) {
    return null;
  }

  const next = sources.filter(
    (source) => source.id !== previousSourceId && source.id !== refreshed.id,
  );
  next.splice(
    Math.min(previousIndex, next.length),
    0,
    carrySourceSchedule(previous, refreshed, refreshedAt),
  );

  return {
    sources: next,
    retiredSourceId: previous.id === refreshed.id ? null : previous.id,
  };
}

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
