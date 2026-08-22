/**
 * Server-side scheduled source sync.
 *
 * A user who puts a source on a daily or weekly schedule expects "daily" to
 * mean daily — not "daily, while Venom happens to be open". This worker walks
 * the stored workspaces on the server, finds sources whose schedule has come
 * due, and replays the original connect request for them, so a snapshot is
 * fresh when the user comes back even if nobody opened a client in between.
 *
 * The pacing rules here deliberately mirror the client's pure schedule logic
 * in artifacts/venom/context/sourceState.ts (scheduledSyncDueAt,
 * nextScheduledSource, sourceRefreshRequest, recordScheduledSyncFailure,
 * replaceRefreshedSource). The two sides share the stored schedule shape and
 * must stay in agreement: the client renders "next in 1d" and merges schedule
 * bookkeeping by these exact fields, and whichever side syncs first must look
 * already-handled to the other. Change them together.
 *
 * Concurrency: every write goes through the workspace store's compare-and-set
 * revision. A pass first *claims* an attempt (writes schedule.lastAttemptAt)
 * and only then fetches; a client (or a second server instance) that raced us
 * either loses the CAS and re-reads our claim, or wins it — in which case we
 * skip and re-evaluate next pass. Since dueness is measured from
 * lastAttemptAt, a claimed source is no longer due, which is what prevents a
 * double sync of work a client just did.
 *
 * Churn: an apply write bumps the workspace revision, and every signed-in
 * device reacts by re-merging and re-uploading state. When the freshly
 * fetched snapshot is identical to the stored one (a daily schedule on a
 * static site, most days), the worker therefore skips the apply write —
 * see scheduledSourceSnapshotUnchanged. The claim already stamped
 * lastAttemptAt, which both re-paces the cadence and lets the source card
 * say the server checked recently.
 *
 * Pacing under load: the pass measures before it spends. Every scanned
 * workspace is read and its due sources counted, then the per-pass sync
 * budget grows with the number of due workspaces (scheduledSyncBudget) up to
 * a hard ceiling, and every pass logs a due/synced/deferred summary — so a
 * growing backlog is visible in the API server logs while it is still
 * minutes deep, not after users notice late dailies. The pass is bounded in
 * time as well as in count: due workspaces sync through a small pool of
 * parallel claims, and no new sync launches after the launch deadline — so
 * even a surge of worst-case slow fetches ends near one interval instead of
 * monopolizing several ticks, and a tick that does land mid-pass logs that
 * it was skipped. Degraded upstreams defer work loudly rather than silently
 * suppressing the very passes that would report them. Fairness holds
 * throughout: at most one source per user per pass, and because each claim
 * write bumps the workspace's updated_at, a serviced user rotates behind the
 * still-waiting ones in the updated_at-ascending scan. Scanning itself
 * rotates too: each pass reads the front page of that order first, then
 * continues from a cursor that advances across passes while pages return
 * full — so workspaces whose schedules are simply not due yet (weeklies
 * mid-cycle, say) can camp at the front, unrewritten, without ever
 * permanently hiding overdue work beyond the window.
 */
import { isDeepStrictEqual } from "node:util";

import {
  ConnectGitHubSourceResponse,
  ConnectWebsiteSourceResponse,
} from "@workspace/api-zod";
import {
  createDeletionMarkers,
  mergeDeletionMarkers,
  TOMBSTONE_LIMITS,
} from "@workspace/venom-workspace-merge";
import {
  asRepositoryPath,
  fetchGitHubConnectedSource,
  fetchWebsiteConnectedSource,
  SourceRequestError,
  type AddressResolver,
  type GitHubRequest,
  type SourceAttestationSigner,
  type WebsiteFetcher,
} from "../routes/venom-sources-router";
import {
  MAX_VENOM_WORKSPACE_BYTES,
  workspacePayloadBytes,
  type WorkspaceRecord,
  type WorkspaceStore,
} from "../routes/venom-workspace-router";

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

export const SCHEDULED_SOURCE_SYNC_INTERVAL_MS = MINUTE_MS;

/** Mirrors CADENCE_INTERVAL_MS in the client's sourceState.ts. */
const CADENCE_INTERVAL_MS: Record<string, number> = {
  daily: DAY_MS,
  weekly: 7 * DAY_MS,
};

/** Mirrors FAILED_SYNC_RETRY_MS in the client's sourceState.ts. */
export const FAILED_SYNC_RETRY_MS = HOUR_MS;

const SOURCE_SCHEDULE_ERROR_MAX_CHARS = 300;

/**
 * How many workspaces one scan page returns. This is also the measurement
 * unit: the pass reads every scanned workspace to count due sources before
 * spending any sync budget, so it must stay above MAX_SYNCS_PER_PASS or a
 * backlog could saturate the budget without ever being measured as one.
 */
export const MAX_WORKSPACES_PER_PASS = 50;
/**
 * How many pages one pass may scan. The first page is always the front of
 * the updated_at-ascending order — the longest-unserviced workspaces — and
 * later pages continue from the rotating cursor, so a front camped with
 * scheduled-but-not-yet-due sources (which nothing ever rewrites) cannot
 * permanently hide overdue work behind it. Also the read bound: a pass
 * fetches at most MAX_SCAN_PAGES_PER_PASS × MAX_WORKSPACES_PER_PASS
 * workspaces while measuring.
 */
export const MAX_SCAN_PAGES_PER_PASS = 4;

/**
 * How many syncs (successful or failed) one pass runs while the measured
 * backlog fits within it — the steady-state pace (300/hour at the 60-second
 * interval), deliberately gentle on GitHub and website hosts.
 */
export const BASE_SYNCS_PER_PASS = 5;
/**
 * The hard ceiling one backlogged pass may drain to — cover for bursts like
 * everyone's daily schedules maturing in the same hour. Its unit is
 * throughput, not time: the pass's wall clock is bounded separately by
 * SCHEDULED_SYNC_LAUNCH_DEADLINE_MS, so this ceiling says how much a healthy
 * fast pass may do, never how long a degraded one may run.
 */
export const MAX_SYNCS_PER_PASS = 20;

/**
 * Due workspaces sync through this many parallel claims. Every in-flight
 * sync is a different user's workspace (one source per user per pass) and
 * the revision CAS already fences concurrent writers — including other
 * server instances — so modest in-process parallelism adds no new races. It
 * exists because fetches are allowed to be slow (websites get a 10-second
 * timeout each): run serially, a full surge of those would hold the
 * single-flight worker for ~200 seconds and swallow the ticks in between.
 */
export const SCHEDULED_SYNC_CONCURRENCY = 4;
/**
 * No new sync launches once a pass has run this long; whatever remains due
 * is deferred to the next tick and counted — and warned about — in the pass
 * summary. Sized under SCHEDULED_SOURCE_SYNC_INTERVAL_MS so a fully degraded
 * pass (launches up to the deadline, plus the straggling in-flight fetches
 * it never aborts) still ends around a single interval, keeping the
 * every-minute summary heartbeat alive exactly when upstreams misbehave.
 * The elapsed clock starts before the measurement reads, so a slow store
 * shrinks the launch window too.
 */
export const SCHEDULED_SYNC_LAUNCH_DEADLINE_MS = 45_000;
const MAX_SAVE_ATTEMPTS = 3;

/** Mirrors the message the client showed for a source it cannot re-request. */
export const UNSUPPORTED_SCHEDULED_SOURCE_MESSAGE =
  "Venom cannot update this source automatically. Remove it and connect it again.";
/** Mirrors the connect route's 403 for a non-member owner. */
const GITHUB_MEMBERSHIP_MESSAGE =
  "Your account is not authorized to use this workspace GitHub connection.";
const GITHUB_FALLBACK_MESSAGE =
  "Venom could not connect this GitHub repository.";
const WEBSITE_FALLBACK_MESSAGE = "Venom could not read this website.";
const GITHUB_INVALID_MESSAGE = "GitHub returned unexpected data";
const WEBSITE_INVALID_MESSAGE = "Website source data is invalid";
const WORKSPACE_TOO_LARGE_MESSAGE =
  "The updated snapshot no longer fits in this workspace, so the previous one was kept.";

export type StoredSourceSchedule = {
  cadence: string;
  updatedAt?: number;
  lastAttemptAt?: number;
  lastError?: string;
  [key: string]: unknown;
};

/**
 * A source as it sits in the persisted workspace blob. Only the fields the
 * scheduler reasons about are typed; everything else is carried through
 * untouched by spreads.
 */
export type StoredProjectSource = {
  id: string;
  projectId: string;
  provider: string;
  name: string;
  url: string;
  syncedAt: string | Date;
  schedule?: StoredSourceSchedule;
  [key: string]: unknown;
};

type SourceDeletionMarker = {
  id: string;
  deletedAt: number;
  replaced?: boolean;
  [key: string]: unknown;
};

export type StoredWorkspaceState = Record<string, unknown>;

export type ScheduledSourceRefreshRequest =
  | { provider: "github"; projectId: string; repository: string }
  | { provider: "website"; projectId: string; url: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function workspaceSources(
  state: StoredWorkspaceState,
): StoredProjectSource[] {
  const sources = state.sources;
  if (!Array.isArray(sources)) return [];
  return sources.filter(
    (source): source is StoredProjectSource =>
      isRecord(source) &&
      typeof source.id === "string" &&
      typeof source.projectId === "string",
  );
}

function scheduleInterval(schedule: StoredSourceSchedule): number | null {
  return CADENCE_INTERVAL_MS[schedule.cadence] ?? null;
}

/**
 * Reads the last attempt exactly like the shared lib's scheduleAttemptAt,
 * but against the loosely typed stored blob (the shared signature requires
 * the validated client schedule shape, which stored data has not earned).
 * The test suite asserts fixture-for-fixture agreement with the shared
 * reader, so this copy cannot drift silently.
 */
export function scheduleAttemptAt(
  schedule: StoredSourceSchedule,
): number | null {
  return typeof schedule.lastAttemptAt === "number" &&
    Number.isFinite(schedule.lastAttemptAt)
    ? schedule.lastAttemptAt
    : null;
}

/** Stored-blob twin of the shared scheduleUpdatedAt; parity-guarded too. */
export function scheduleUpdatedAt(schedule: StoredSourceSchedule): number {
  return typeof schedule.updatedAt === "number" &&
    Number.isFinite(schedule.updatedAt)
    ? schedule.updatedAt
    : 0;
}

function sourceSyncedAtMs(source: StoredProjectSource): number {
  const syncedAt =
    source.syncedAt instanceof Date
      ? source.syncedAt.getTime()
      : Date.parse(String(source.syncedAt));
  return Number.isNaN(syncedAt) ? 0 : syncedAt;
}

/**
 * When a scheduled source is next allowed to re-sync, or null when it has no
 * live schedule. Mirrors the client's scheduledSyncDueAt: successful syncs are
 * paced by the cadence measured from the last snapshot or attempt, a failed
 * attempt by the shorter retry window.
 */
export function scheduledSyncDueAt(
  source: StoredProjectSource,
): number | null {
  const schedule = source.schedule;
  if (!isRecord(schedule)) return null;

  const interval = scheduleInterval(schedule);
  if (interval === null) return null;

  const lastAttemptAt = scheduleAttemptAt(schedule);
  if (lastAttemptAt !== null && schedule.lastError) {
    return lastAttemptAt + FAILED_SYNC_RETRY_MS;
  }

  return Math.max(sourceSyncedAtMs(source), lastAttemptAt ?? 0) + interval;
}

/**
 * The scheduled source that should be re-synced next for one workspace, or
 * null when none is due. One source at a time, longest overdue first — the
 * same order the in-app runner used, so moving the schedule to the server
 * does not change which source wins.
 */
export function nextDueScheduledSource(
  sources: StoredProjectSource[],
  now: number,
): StoredProjectSource | null {
  const due = sources
    .map((source) => ({ source, dueAt: scheduledSyncDueAt(source) }))
    .filter(
      (candidate): candidate is { source: StoredProjectSource; dueAt: number } =>
        candidate.dueAt !== null && candidate.dueAt <= now,
    )
    .sort(
      (left, right) =>
        left.dueAt - right.dueAt ||
        left.source.id.localeCompare(right.source.id),
    );

  return due.length ? due[0].source : null;
}

/**
 * Every due source in one workspace, not just the one a pass would sync
 * next. This is the backlog unit the pass summary reports: it includes
 * sources queued behind the one-per-user rule, which is exactly the depth
 * that predicts how late a burst of "daily" schedules will run.
 */
export function countDueScheduledSources(
  sources: StoredProjectSource[],
  now: number,
): number {
  let due = 0;
  for (const source of sources) {
    const dueAt = scheduledSyncDueAt(source);
    if (dueAt !== null && dueAt <= now) due += 1;
  }
  return due;
}
const REPOSITORY_PATH_PATTERN = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;

function githubRepositoryPath(source: StoredProjectSource): string | null {
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
 * Rebuilds the original connect request for a stored source, exactly as the
 * client's sourceRefreshRequest does. Replaying the connect request is what
 * makes the server recompute the same deterministic source id, which in turn
 * lets the refreshed snapshot replace the source in place.
 */
export function scheduledSourceRefreshRequest(
  source: StoredProjectSource,
): ScheduledSourceRefreshRequest | null {
  if (source.provider === "github") {
    const repository = githubRepositoryPath(source);
    return repository
      ? { provider: "github", projectId: source.projectId, repository }
      : null;
  }
  if (source.provider !== "website") return null;

  const url = source.url.trim();
  return /^https:\/\/\S+$/i.test(url)
    ? { provider: "website", projectId: source.projectId, url }
    : null;
}

/**
 * Marks the attempt that is about to run. Writing lastAttemptAt *before*
 * fetching is the claim that keeps a second scheduler instance — or a client
 * doing its own manual refresh — from starting the same sync, because a
 * claimed source is no longer due. The previous failure is kept: the card
 * keeps showing it until a sync actually succeeds.
 */
export function claimScheduledSourceAttempt(
  sources: StoredProjectSource[],
  sourceId: string,
  attemptedAt: number,
): StoredProjectSource[] | null {
  const index = sources.findIndex((source) => source.id === sourceId);
  if (index === -1) return null;

  const source = sources[index];
  const schedule = source.schedule;
  if (!isRecord(schedule) || scheduleInterval(schedule) === null) return null;

  const next = [...sources];
  next[index] = {
    ...source,
    schedule: { ...schedule, lastAttemptAt: attemptedAt },
  };
  return next;
}

/**
 * Records a failed unattended sync on the source itself so the failure stays
 * visible on its card and paces the retry, leaving the previous snapshot
 * untouched. Mirrors the client's recordScheduledSyncFailure.
 */
export function recordScheduledSourceSyncFailure(
  sources: StoredProjectSource[],
  sourceId: string,
  attemptedAt: number,
  message: string,
): StoredProjectSource[] | null {
  const index = sources.findIndex((source) => source.id === sourceId);
  if (index === -1) return null;

  const source = sources[index];
  const schedule = source.schedule;
  if (!isRecord(schedule) || schedule.cadence === "off") return null;

  const lastError =
    message.trim().slice(0, SOURCE_SCHEDULE_ERROR_MAX_CHARS) ||
    "Venom could not update this source.";
  const next = [...sources];
  next[index] = {
    ...source,
    schedule: { ...schedule, lastAttemptAt: attemptedAt, lastError },
  };
  return next;
}

/**
 * Carries the schedule across a refresh (the connect builders know nothing
 * about schedules), clears the last failure, and re-paces from this attempt.
 * Mirrors the client's carrySourceSchedule.
 */
function carrySourceSchedule(
  previous: StoredProjectSource,
  refreshed: StoredProjectSource,
  refreshedAt: number,
): StoredProjectSource {
  const schedule = refreshed.schedule ?? previous.schedule;
  if (!isRecord(schedule)) return refreshed;
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
 * Swaps the refreshed snapshot in for the source it was refreshed from.
 * Returns null when the refresh must be discarded instead: the source was
 * removed while the fetch was in flight (applying would resurrect deleted
 * content), it moved projects, or a newer snapshot already landed. Mirrors
 * the client's replaceRefreshedSource.
 */
export function applyRefreshedScheduledSource(
  sources: StoredProjectSource[],
  previousSourceId: string,
  refreshed: StoredProjectSource,
  refreshedAt: number,
): { sources: StoredProjectSource[]; retiredSourceId: string | null } | null {
  const previousIndex = sources.findIndex(
    (source) => source.id === previousSourceId,
  );
  if (previousIndex === -1) return null;

  const previous = sources[previousIndex];
  if (previous.projectId !== refreshed.projectId) return null;

  const existing = sources.find((source) => source.id === refreshed.id);
  if (existing && sourceSyncedAtMs(refreshed) < sourceSyncedAtMs(existing)) {
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

/** A source with the volatile bookkeeping fields removed, for comparison. */
function comparableSnapshot(
  source: StoredProjectSource,
): Record<string, unknown> {
  const { syncedAt: _syncedAt, schedule: _schedule, ...content } = source;
  return content;
}

/**
 * Whether applying the freshly fetched snapshot would change nothing a device
 * could see besides syncedAt. The comparison covers the whole snapshot —
 * name, context, citations, clusters, summary, attestation, and any other
 * stored field — so the write is only skipped when it is provably a no-op;
 * a stored field the replay would drop still forces the write. Two
 * exceptions keep the semantics of a successful sync intact:
 *
 * - a pending schedule.lastError must still be cleared by an apply write, or
 *   the card would show a stale failure (and the retry window would keep
 *   re-fetching hourly) forever, and
 * - a snapshot whose deterministic id moved is never "unchanged", because the
 *   old source must be retired with a tombstone.
 */
export function scheduledSourceSnapshotUnchanged(
  previous: StoredProjectSource,
  refreshed: StoredProjectSource,
): boolean {
  if (previous.id !== refreshed.id) return false;
  if (previous.projectId !== refreshed.projectId) return false;
  if (isRecord(previous.schedule) && previous.schedule.lastError) return false;

  return isDeepStrictEqual(
    comparableSnapshot(previous),
    comparableSnapshot(refreshed),
  );
}

/**
 * The tombstone rules themselves — the replacement marker semantics, the
 * newest-deletedAt-per-id merge, and the replacement-aware cap — are NOT
 * defined here. They are the shared cross-device rules from
 * @workspace/venom-workspace-merge, the exact functions the phone and desktop
 * apps run, re-exported so this module's test suite can assert identity the
 * same way the apps' suites do. A hand-written server copy is how a scheduled
 * server sync ends up reviving a source a device retired; do not reintroduce
 * one.
 */
export {
  createDeletionMarkers,
  isReplacementMarker,
  mergeDeletionMarkers,
  TOMBSTONE_LIMITS,
} from "@workspace/venom-workspace-merge";

/**
 * Writes the `replaced: true` tombstone for a retired source id so no device
 * can hand the refreshed-away source back. Only needed when the deterministic
 * id changed, which the connect replay makes rare by construction. The marker,
 * the per-id merge, and the sources cap all come from the shared rules, so a
 * server-written tombstone can never disagree with what a device would write.
 */
export function withReplacedSourceTombstone(
  state: StoredWorkspaceState,
  retiredSourceId: string,
  deletedAt: number,
): StoredWorkspaceState {
  const tombstones = isRecord(state.tombstones) ? state.tombstones : {};
  const existing = Array.isArray(tombstones.sources)
    ? (tombstones.sources.filter(isRecord) as SourceDeletionMarker[])
    : [];
  return {
    ...state,
    tombstones: {
      ...tombstones,
      sources: mergeDeletionMarkers(
        TOMBSTONE_LIMITS.sources,
        existing,
        createDeletionMarkers([retiredSourceId], deletedAt, {
          replaced: true,
        }),
      ),
    },
  };
}

type ScheduledSyncLogger = {
  debug: (context: Record<string, unknown>, message: string) => void;
  info: (context: Record<string, unknown>, message: string) => void;
  warn: (context: Record<string, unknown>, message: string) => void;
  error: (context: Record<string, unknown>, message: string) => void;
};

/**
 * Where persistent-failure alerts are kept. The card on the source (see
 * recordScheduledSourceSyncFailure) only helps someone who opens Settings;
 * the sink is what lets repeated unattended failures reach the notification
 * bell of a user who relies on the scheduler precisely because they are not
 * around. Alert bookkeeping is strictly best-effort: a sink error is logged
 * and swallowed so it can never break the sync itself.
 */
export type ScheduledSourceSyncAlertSink = {
  /** One failed attempt, called only after the card write landed. */
  recordFailure(input: {
    userId: string;
    source: StoredProjectSource;
    message: string;
    failedAt: number;
  }): Promise<void>;
  /** A sync succeeded; covers the previous and refreshed source ids. */
  recordSuccess(input: { userId: string; sourceIds: string[] }): Promise<void>;
};
/** One row of the scheduled-workspace scan, keyed for keyset pagination. */
export type ScheduledScanRow = {
  userId: string;
  /** The workspace's updated_at in epoch milliseconds — the scan-order key. */
  updatedAtMs: number;
};
export type ScheduledScanCursor = ScheduledScanRow;

export type ScheduledSourceSyncDeps = {
  /**
   * One page of workspaces whose stored state contains at least one
   * scheduled source, in (updated_at, user id) ascending order — strictly
   * after the cursor when one is given.
   */
  listScheduledWorkspaceUserIds: (
    limit: number,
    after?: ScheduledScanCursor,
  ) => Promise<ScheduledScanRow[]>;
  store: WorkspaceStore;
  /** Same gate the GitHub connect route applies before proxying. */
  isWorkspaceMember: (userId: string) => boolean;
  githubRequest: GitHubRequest;
  resolveAddresses: AddressResolver;
  fetchWebsite: WebsiteFetcher;
  createAttestation: SourceAttestationSigner;
  log: ScheduledSyncLogger;
  alerts?: ScheduledSourceSyncAlertSink;
  now?: () => number;
};

export type ScheduledSyncPassSummary = {
  /** Workspaces the scan window returned, due or not. */
  workspaces: number;
  /** Workspaces that held at least one due source when the pass read them. */
  dueWorkspaces: number;
  /** Due sources across every scanned workspace, queued ones included. */
  dueSources: number;
  synced: number;
  failed: number;
  /** Due workspaces the budget could not attempt; the next pass retries. */
  deferred: number;
};

type WorkspaceOutcome = "synced" | "unchanged" | "failed" | "skipped";

export function createVenomScheduledSourceSyncWorker(
  deps: ScheduledSourceSyncDeps,
) {
  const now = deps.now ?? Date.now;
  let running = false;
  let passStartedAt = 0;
  /**
   * Where scanning resumes after the front page. Advances while pages come
   * back full, resets once a pass reaches the end of the order — in-memory
   * on purpose: a restart merely restarts the rotation, and the CAS claims
   * keep a second instance's overlapping scans harmless.
   */
  let scanCursor: ScheduledScanCursor | null = null;

  function logContext(extra: Record<string, unknown>) {
    return { operation: "venom_scheduled_source_sync", ...extra };
  }

  /** Best-effort alert bookkeeping; a sink failure never breaks the sync. */
  async function notifyAlertFailure(
    userId: string,
    source: StoredProjectSource,
    message: string,
  ): Promise<void> {
    if (!deps.alerts) return;
    try {
      await deps.alerts.recordFailure({
        userId,
        source,
        message,
        failedAt: now(),
      });
    } catch (error) {
      deps.log.warn(
        logContext({
          userId,
          sourceId: source.id,
          errorName: error instanceof Error ? error.name : "UnknownError",
        }),
        "scheduled source sync could not record the failure alert",
      );
    }
  }

  /** Best-effort alert clearing; a sink failure never breaks the sync. */
  async function notifyAlertSuccess(
    userId: string,
    sourceIds: string[],
  ): Promise<void> {
    if (!deps.alerts) return;
    try {
      await deps.alerts.recordSuccess({ userId, sourceIds });
    } catch (error) {
      deps.log.warn(
        logContext({
          userId,
          sourceIds,
          errorName: error instanceof Error ? error.name : "UnknownError",
        }),
        "scheduled source sync could not clear the source sync alerts",
      );
    }
  }

  /**
   * Fetches the refreshed snapshot for one due source, signs it for the
   * workspace owner, and validates it against the same response schema the
   * connect routes enforce. Throws SourceRequestError with a card-worthy
   * message on any failure.
   */
  async function buildRefreshedSource(
    userId: string,
    request: ScheduledSourceRefreshRequest,
  ): Promise<StoredProjectSource> {
    let connectedSource;
    let schema;
    let invalidMessage;
    if (request.provider === "github") {
      // The connector is a workspace resource; a scheduled sync must pass the
      // exact membership gate the interactive connect route applies.
      if (!deps.isWorkspaceMember(userId)) {
        throw new SourceRequestError(GITHUB_MEMBERSHIP_MESSAGE, 403);
      }
      const repositoryPath = asRepositoryPath(request.repository);
      if (!repositoryPath) {
        throw new SourceRequestError(UNSUPPORTED_SCHEDULED_SOURCE_MESSAGE, 400);
      }
      connectedSource = await fetchGitHubConnectedSource(
        deps.githubRequest,
        request.projectId,
        repositoryPath,
      );
      schema = ConnectGitHubSourceResponse;
      invalidMessage = GITHUB_INVALID_MESSAGE;
    } else {
      connectedSource = await fetchWebsiteConnectedSource(
        {
          resolveAddresses: deps.resolveAddresses,
          fetchWebsite: deps.fetchWebsite,
        },
        request.projectId,
        request.url,
      );
      schema = ConnectWebsiteSourceResponse;
      invalidMessage = WEBSITE_INVALID_MESSAGE;
    }

    const source = {
      ...connectedSource,
      attestation: deps.createAttestation({
        userId,
        projectId: connectedSource.projectId,
        sourceId: connectedSource.id,
        context: connectedSource.context,
        citations: connectedSource.citations,
      }),
    };

    const parsed = schema.safeParse(source);
    if (!parsed.success) {
      throw new SourceRequestError(invalidMessage, 502);
    }

    // The workspace blob stores syncedAt the way the connect response JSON
    // serializes it: as an ISO string.
    return {
      ...parsed.data,
      syncedAt: parsed.data.syncedAt.toISOString(),
    } as StoredProjectSource;
  }

  /**
   * Best-effort CAS loop that records a failure on the source card. Losing
   * every retry means a client is actively saving; its own merge will carry
   * newer bookkeeping anyway.
   */
  async function recordFailure(
    userId: string,
    sourceId: string,
    message: string,
  ): Promise<void> {
    for (let attempt = 0; attempt < MAX_SAVE_ATTEMPTS; attempt += 1) {
      const record = await deps.store.get(userId);
      if (!record || !isRecord(record.state)) return;
      const state = record.state as StoredWorkspaceState;
      const sources = workspaceSources(state);
      const failed = recordScheduledSourceSyncFailure(
        sources,
        sourceId,
        now(),
        message,
      );
      // The schedule was turned off or the source removed meanwhile — there
      // is no card left to show the failure on.
      if (!failed) return;
      const updated = await deps.store.update(
        userId,
        { ...state, sources: failed },
        record.revision,
        new Date(now()),
      );
      if (updated) {
        // Count the streak only for failures that actually reached the card,
        // so the alert can never claim more than Settings would show.
        const source = sources.find((item) => item.id === sourceId);
        if (source) await notifyAlertFailure(userId, source, message);
        return;
      }
    }
    deps.log.warn(
      logContext({ userId, sourceId }),
      "scheduled source sync could not record a failure after repeated conflicts",
    );
  }

  /**
   * CAS loop that swaps the refreshed snapshot in. Re-reads and re-applies on
   * every conflict so a workspace the user is actively editing never gets
   * clobbered — the replace rules re-run against the fresh state each time.
   * A snapshot identical to the stored one short-circuits without writing:
   * the claim already re-paced the schedule, so a no-op apply would only bump
   * the revision and make every signed-in device re-download the workspace.
   */
  async function applyRefresh(
    userId: string,
    startRecord: WorkspaceRecord,
    previousSourceId: string,
    refreshed: StoredProjectSource,
  ): Promise<WorkspaceOutcome> {
    let record: WorkspaceRecord | undefined = startRecord;
    for (let attempt = 0; attempt < MAX_SAVE_ATTEMPTS; attempt += 1) {
      if (!record || !isRecord(record.state)) return "skipped";
      const state = record.state as StoredWorkspaceState;
      const sources = workspaceSources(state);

      const previous = sources.find(
        (source) => source.id === previousSourceId,
      );
      if (previous && scheduledSourceSnapshotUnchanged(previous, refreshed)) {
        return "unchanged";
      }

      const applied = applyRefreshedScheduledSource(
        sources,
        previousSourceId,
        refreshed,
        now(),
      );
      if (!applied) {
        deps.log.info(
          logContext({ userId, sourceId: previousSourceId }),
          "scheduled source refresh discarded; the source changed while the sync ran",
        );
        return "skipped";
      }

      let nextState: StoredWorkspaceState = {
        ...state,
        sources: applied.sources,
      };
      if (applied.retiredSourceId) {
        nextState = withReplacedSourceTombstone(
          nextState,
          applied.retiredSourceId,
          now(),
        );
      }

      if (workspacePayloadBytes(nextState) > MAX_VENOM_WORKSPACE_BYTES) {
        await recordFailure(
          userId,
          previousSourceId,
          WORKSPACE_TOO_LARGE_MESSAGE,
        );
        return "failed";
      }

      const updated = await deps.store.update(
        userId,
        nextState,
        record.revision,
        new Date(now()),
      );
      if (updated) return "synced";
      record = await deps.store.get(userId);
    }

    // The claim already re-paced the schedule, so giving up here costs one
    // cadence slot at worst — and this many conflicts means a client is
    // actively syncing this workspace right now.
    deps.log.warn(
      logContext({ userId, sourceId: previousSourceId }),
      "scheduled source refresh dropped after repeated save conflicts",
    );
    return "skipped";
  }

  async function syncWorkspace(userId: string): Promise<WorkspaceOutcome> {
    const record = await deps.store.get(userId);
    if (!record || !isRecord(record.state)) return "skipped";
    const state = record.state as StoredWorkspaceState;
    const sources = workspaceSources(state);

    const due = nextDueScheduledSource(sources, now());
    if (!due) return "skipped";

    const claimedSources = claimScheduledSourceAttempt(sources, due.id, now());
    if (!claimedSources) return "skipped";
    const claimed = await deps.store.update(
      userId,
      { ...state, sources: claimedSources },
      record.revision,
      new Date(now()),
    );
    // Lost the claim race to a client save or another instance; whatever won
    // carries newer bookkeeping, so re-evaluate from scratch next pass.
    if (!claimed) return "skipped";

    const request = scheduledSourceRefreshRequest(due);
    if (!request) {
      await recordFailure(userId, due.id, UNSUPPORTED_SCHEDULED_SOURCE_MESSAGE);
      return "failed";
    }

    let refreshed: StoredProjectSource;
    try {
      refreshed = await buildRefreshedSource(userId, request);
    } catch (error) {
      const fallback =
        request.provider === "github"
          ? GITHUB_FALLBACK_MESSAGE
          : WEBSITE_FALLBACK_MESSAGE;
      const message =
        error instanceof SourceRequestError ? error.message : fallback;
      deps.log.warn(
        logContext({
          userId,
          sourceId: due.id,
          provider: request.provider,
          errorName: error instanceof Error ? error.name : "UnknownError",
        }),
        "scheduled source sync attempt failed",
      );
      await recordFailure(userId, due.id, message);
      return "failed";
    }

    const outcome = await applyRefresh(userId, claimed, due.id, refreshed);
    if (outcome === "synced") {
      deps.log.info(
        logContext({ userId, sourceId: due.id, provider: request.provider }),
        "scheduled source re-synced on the server",
      );
      // The streak is over. The refresh may have retired due.id for a new
      // deterministic id, so clear alerts under both.
      await notifyAlertSuccess(userId, [...new Set([due.id, refreshed.id])]);
    }
    if (outcome === "unchanged") {
      deps.log.info(
        logContext({ userId, sourceId: due.id, provider: request.provider }),
        "scheduled source snapshot unchanged; skipped the workspace write",
      );
    }
    return outcome;
  }

  async function runPass(): Promise<ScheduledSyncPassSummary> {
    if (running) {
      // A tick that lands while the previous pass still runs would otherwise
      // vanish without a trace — and that silence hits exactly when slow
      // upstreams make backlog visibility matter most. The launch deadline
      // makes this rare; when it happens anyway, say so.
      deps.log.warn(
        logContext({ runningForMs: now() - passStartedAt }),
        "scheduled source sync tick skipped; previous pass still running",
      );
      return {
        workspaces: 0,
        dueWorkspaces: 0,
        dueSources: 0,
        synced: 0,
        failed: 0,
        deferred: 0,
      };
    }
    running = true;
    passStartedAt = now();
    try {
      // Measure before spending: scan pages of workspaces and count what is
      // actually due. A pass that only counted what it had budget to attempt
      // would hide exactly the backlog growth this summary exists to expose.
      // The first page is always the front of the updated_at order; when it
      // yields less due work than the surge ceiling, later pages continue
      // from the rotating cursor. The cursor advances monotonically while
      // pages return full, so a front camped with not-yet-due schedules is
      // only ever a delay for the workspaces behind it, never a wall. (Due
      // work a pass finds but defers past its budget re-enters through the
      // front page or within one rotation — claims bump updated_at, so
      // whatever was actually attempted rotates to the back on its own.)
      let synced = 0;
      let failed = 0;
      let dueSources = 0;
      let scannedWorkspaces = 0;
      let pagesScanned = 0;
      let reachedEnd = false;
      const seenUserIds = new Set<string>();
      const dueUserIds: string[] = [];
      let continueAfter = scanCursor;
      while (pagesScanned < MAX_SCAN_PAGES_PER_PASS) {
        const page = await deps.listScheduledWorkspaceUserIds(
          MAX_WORKSPACES_PER_PASS,
          pagesScanned === 0 ? undefined : continueAfter ?? undefined,
        );
        pagesScanned += 1;
        for (const row of page) {
          if (seenUserIds.has(row.userId)) continue;
          seenUserIds.add(row.userId);
          scannedWorkspaces += 1;
          try {
            const record = await deps.store.get(row.userId);
            if (!record || !isRecord(record.state)) continue;
            const due = countDueScheduledSources(
              workspaceSources(record.state as StoredWorkspaceState),
              now(),
            );
            if (due === 0) continue;
            dueSources += due;
            dueUserIds.push(row.userId);
          } catch (error) {
            // One workspace whose store reads blow up must not stall the
            // rest.
            failed += 1;
            deps.log.error(
              logContext({
                userId: row.userId,
                errorName:
                  error instanceof Error ? error.name : "UnknownError",
              }),
              "scheduled source sync pass failed for a workspace",
            );
          }
        }
        if (page.length < MAX_WORKSPACES_PER_PASS) {
          // The order is exhausted; the next pass rotates back to the front.
          reachedEnd = true;
          break;
        }
        const tail = page[page.length - 1];
        continueAfter = laterScanCursor(continueAfter, {
          updatedAtMs: tail.updatedAtMs,
          userId: tail.userId,
        });
        // More due work than the surge ceiling could ever attempt already
        // fills the pass; further reads would only refine counts the
        // scanSaturated flag marks as floors anyway.
        if (dueUserIds.length >= MAX_SYNCS_PER_PASS) break;
      }
      scanCursor = reachedEnd ? null : continueAfter;

      // The budget follows the measured backlog, so a burst of same-hour
      // daily schedules drains at surge pace instead of quietly running
      // hours late. syncWorkspace re-reads and CAS-claims before fetching,
      // so acting on a measurement that meanwhile went stale only costs a
      // skip, never a double sync. A small pool of parallel claims keeps a
      // surge inside the pass's time budget, and the launch deadline stops
      // new work when it is not — deferring the remainder out loud instead
      // of holding the worker through the next ticks.
      const budget = scheduledSyncBudget(dueUserIds.length);
      let cursor = 0;
      let inFlight = 0;
      let deadlineHit = false;
      const syncNext = async (): Promise<void> => {
        while (cursor < dueUserIds.length) {
          // In-flight syncs count against the budget pessimistically; a skip
          // (lost claim race) refunds its slot when it settles, and this
          // worker keeps draining, so skips still consume no budget.
          if (synced + failed + inFlight >= budget) return;
          if (now() - passStartedAt >= SCHEDULED_SYNC_LAUNCH_DEADLINE_MS) {
            deadlineHit = true;
            return;
          }
          const userId = dueUserIds[cursor];
          cursor += 1;
          inFlight += 1;
          try {
            const outcome = await syncWorkspace(userId);
            // An unchanged check still ran a full fetch, so it spends a slot
            // in the pass budget like any other completed sync.
            if (outcome === "synced" || outcome === "unchanged") synced += 1;
            if (outcome === "failed") failed += 1;
          } catch (error) {
            failed += 1;
            deps.log.error(
              logContext({
                userId,
                errorName:
                  error instanceof Error ? error.name : "UnknownError",
              }),
              "scheduled source sync pass failed for a workspace",
            );
          } finally {
            inFlight -= 1;
          }
        }
      };
      await Promise.all(
        Array.from(
          { length: Math.min(SCHEDULED_SYNC_CONCURRENCY, dueUserIds.length) },
          () => syncNext(),
        ),
      );
      const deferred = dueUserIds.length - cursor;

      const summary: ScheduledSyncPassSummary = {
        workspaces: scannedWorkspaces,
        dueWorkspaces: dueUserIds.length,
        dueSources,
        synced,
        failed,
        deferred,
      };
      // Deferred work means the pass could not attempt everything due —
      // the backlog outgrew the surge budget, or slow fetches hit the launch
      // deadline. Either deserves a warning while the lag is still minutes,
      // not hours, deep. A busy pass logs at info; an idle pass keeps the
      // same heartbeat at debug so steady state does not write a line every
      // minute.
      const context = logContext({
        ...summary,
        budget,
        deadlineHit,
        passMs: now() - passStartedAt,
        pagesScanned,
        scanLimit: MAX_WORKSPACES_PER_PASS,
        // A scan that stopped before the end of the order means the due
        // counts are floors, not totals: more scheduled workspaces are
        // waiting beyond what this pass could read.
        scanSaturated: !reachedEnd,
      });
      const message = "scheduled source sync pass summary";
      if (deferred > 0) {
        deps.log.warn(context, message);
      } else if (dueSources > 0 || synced > 0 || failed > 0) {
        deps.log.info(context, message);
      } else if (!reachedEnd) {
        // Nothing due in what was read — but the read was cut short, so
        // this is not a certified-idle pass and must not hide at debug.
        deps.log.info(context, message);
      } else {
        deps.log.debug(context, message);
      }
      return summary;
    } finally {
      running = false;
    }
  }

  return { runPass };
}

/**
 * How many syncs the current pass may run: the steady-state pace while the
 * measured backlog fits inside it, then one slot per due workspace — a pass
 * never syncs two sources for the same user, so a larger budget would be
 * unusable — capped at the per-pass ceiling.
 */
export function scheduledSyncBudget(dueWorkspaceCount: number): number {
  return Math.min(
    Math.max(BASE_SYNCS_PER_PASS, dueWorkspaceCount),
    MAX_SYNCS_PER_PASS,
  );
}

/** The later of two scan positions in (updated_at, user id) order. */
function laterScanCursor(
  a: ScheduledScanCursor | null,
  b: ScheduledScanCursor,
): ScheduledScanCursor {
  if (!a) return b;
  if (a.updatedAtMs !== b.updatedAtMs) {
    return a.updatedAtMs > b.updatedAtMs ? a : b;
  }
  return a.userId > b.userId ? a : b;
}
