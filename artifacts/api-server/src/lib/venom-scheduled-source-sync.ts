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
 */
import {
  ConnectGitHubSourceResponse,
  ConnectWebsiteSourceResponse,
} from "@workspace/api-zod";
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
const MAX_SOURCE_TOMBSTONES = 2000;

/** How many workspaces one pass will even look at. */
export const MAX_WORKSPACES_PER_PASS = 50;
/** How many syncs (successful or failed) one pass will run in total. */
export const MAX_SYNCS_PER_PASS = 5;
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

function scheduleAttemptAt(schedule: StoredSourceSchedule): number | null {
  return typeof schedule.lastAttemptAt === "number" &&
    Number.isFinite(schedule.lastAttemptAt)
    ? schedule.lastAttemptAt
    : null;
}

function scheduleUpdatedAt(schedule: StoredSourceSchedule): number {
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

function isReplacementMarker(marker: SourceDeletionMarker): boolean {
  return marker.replaced === true;
}

/** Mirrors the client's boundSourceDeletionMarkers eviction order. */
function boundSourceDeletionMarkers(
  markers: SourceDeletionMarker[],
  limit: number,
): SourceDeletionMarker[] {
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

/**
 * Writes the `replaced: true` tombstone for a retired source id so no device
 * can hand the refreshed-away source back. Only needed when the deterministic
 * id changed, which the connect replay makes rare by construction.
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
  const marker: SourceDeletionMarker = {
    id: retiredSourceId,
    deletedAt,
    replaced: true,
  };
  return {
    ...state,
    tombstones: {
      ...tombstones,
      sources: boundSourceDeletionMarkers(
        [...existing.filter((item) => item.id !== retiredSourceId), marker],
        MAX_SOURCE_TOMBSTONES,
      ),
    },
  };
}

type ScheduledSyncLogger = {
  info: (context: Record<string, unknown>, message: string) => void;
  warn: (context: Record<string, unknown>, message: string) => void;
  error: (context: Record<string, unknown>, message: string) => void;
};

export type ScheduledSourceSyncDeps = {
  /** Workspaces whose stored state contains at least one scheduled source. */
  listScheduledWorkspaceUserIds: (limit: number) => Promise<string[]>;
  store: WorkspaceStore;
  /** Same gate the GitHub connect route applies before proxying. */
  isWorkspaceMember: (userId: string) => boolean;
  githubRequest: GitHubRequest;
  resolveAddresses: AddressResolver;
  fetchWebsite: WebsiteFetcher;
  createAttestation: SourceAttestationSigner;
  log: ScheduledSyncLogger;
  now?: () => number;
};

export type ScheduledSyncPassSummary = {
  workspaces: number;
  synced: number;
  failed: number;
};

type WorkspaceOutcome = "synced" | "failed" | "skipped";

export function createVenomScheduledSourceSyncWorker(
  deps: ScheduledSourceSyncDeps,
) {
  const now = deps.now ?? Date.now;
  let running = false;

  function logContext(extra: Record<string, unknown>) {
    return { operation: "venom_scheduled_source_sync", ...extra };
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
      const failed = recordScheduledSourceSyncFailure(
        workspaceSources(state),
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
      if (updated) return;
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
      const applied = applyRefreshedScheduledSource(
        workspaceSources(state),
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
    }
    return outcome;
  }

  async function runPass(): Promise<ScheduledSyncPassSummary> {
    if (running) return { workspaces: 0, synced: 0, failed: 0 };
    running = true;
    try {
      const userIds = await deps.listScheduledWorkspaceUserIds(
        MAX_WORKSPACES_PER_PASS,
      );
      let synced = 0;
      let failed = 0;
      for (const userId of userIds) {
        if (synced + failed >= MAX_SYNCS_PER_PASS) break;
        try {
          const outcome = await syncWorkspace(userId);
          if (outcome === "synced") synced += 1;
          if (outcome === "failed") failed += 1;
        } catch (error) {
          // One workspace whose store reads blow up must not stall the rest.
          failed += 1;
          deps.log.error(
            logContext({
              userId,
              errorName: error instanceof Error ? error.name : "UnknownError",
            }),
            "scheduled source sync pass failed for a workspace",
          );
        }
      }
      return { workspaces: userIds.length, synced, failed };
    } finally {
      running = false;
    }
  }

  return { runPass };
}
