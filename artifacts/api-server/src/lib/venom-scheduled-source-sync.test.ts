import assert from "node:assert/strict";
import test from "node:test";

import * as sharedMergeRules from "@workspace/venom-workspace-merge";
import {
  applyRefreshedScheduledSource,
  BASE_SYNCS_PER_PASS,
  claimScheduledSourceAttempt,
  createDeletionMarkers,
  isReplacementMarker,
  mergeDeletionMarkers,
  TOMBSTONE_LIMITS,
  countDueScheduledSources,
  createVenomScheduledSourceSyncWorker,
  FAILED_SYNC_RETRY_MS,
  MAX_SYNCS_PER_PASS,
  MAX_WORKSPACES_PER_PASS,
  nextDueScheduledSource,
  recordScheduledSourceSyncFailure,
  scheduleAttemptAt,
  scheduledSourceRefreshRequest,
  scheduleUpdatedAt,
  MAX_SCAN_PAGES_PER_PASS,
  SCHEDULED_SOURCE_SYNC_INTERVAL_MS,
  SCHEDULED_SYNC_CONCURRENCY,
  SCHEDULED_SYNC_LAUNCH_DEADLINE_MS,
  scheduledSourceSnapshotUnchanged,
  scheduledSyncBudget,
  scheduledSyncDueAt,
  UNSUPPORTED_SCHEDULED_SOURCE_MESSAGE,
  withReplacedSourceTombstone,
  workspaceSources,
  type ScheduledSourceSyncAlertSink,
  type ScheduledSourceSyncDeps,
  type ScheduledSyncPassSummary,
  type StoredProjectSource,
  type StoredSourceSchedule,
  type StoredWorkspaceState,
} from "./venom-scheduled-source-sync";
import { createSourceAttestation } from "./source-attestations";
import {
  sourceId,
  type GitHubRequest,
  type WebsiteFetcher,
} from "../routes/venom-sources-router";

process.env.SOURCE_ATTESTATION_SECRET =
  process.env.SOURCE_ATTESTATION_SECRET ?? "venom-scheduled-sync-test-secret";

// Relative to the real clock because the connect builders stamp syncedAt
// with `new Date()` themselves; every pacing expectation is an offset anyway.
const NOW = Date.now();
const DAY_MS = 24 * 60 * 60_000;

const USER_ID = "user_scheduleOwner1";
const PROJECT_ID = "proj_default";
const WEBSITE_URL = "https://example.com/";
const WEBSITE_SOURCE_ID = sourceId(PROJECT_ID, `website:${WEBSITE_URL}`);
const GITHUB_REPO = "octocat/hello";
const GITHUB_SOURCE_ID = sourceId(PROJECT_ID, `github:${GITHUB_REPO}`);

const FRESH_HTML = [
  "<html><head><title>Example Domain</title>",
  '<meta name="keywords" content="example, documentation">',
  "</head><body><p>Fresh copy of the example content, refreshed on the server.</p></body></html>",
].join("");

function websiteStoredSource(
  overrides: Partial<StoredProjectSource> = {},
): StoredProjectSource {
  return {
    id: WEBSITE_SOURCE_ID,
    projectId: PROJECT_ID,
    provider: "website",
    name: "Example Domain",
    url: WEBSITE_URL,
    status: "connected",
    syncedAt: new Date(NOW - 3 * DAY_MS).toISOString(),
    summary: "Example Domain • public website",
    context: "[source:cite_old] website: Example Domain. Stale copy.",
    citations: [
      {
        id: "cite_old",
        provider: "website",
        kind: "website",
        title: "Example Domain",
        url: WEBSITE_URL,
        excerpt: "Stale copy",
        reference: null,
      },
    ],
    clusters: [],
    schedule: { cadence: "daily", updatedAt: NOW - 5 * DAY_MS },
    ...overrides,
  };
}

function githubStoredSource(
  overrides: Partial<StoredProjectSource> = {},
): StoredProjectSource {
  return {
    ...websiteStoredSource(),
    id: GITHUB_SOURCE_ID,
    provider: "github",
    name: GITHUB_REPO,
    url: `https://github.com/${GITHUB_REPO}`,
    context: "[source:cite_old_gh] github: octocat/hello. Stale copy.",
    citations: [
      {
        id: "cite_old_gh",
        provider: "github",
        kind: "repository",
        title: GITHUB_REPO,
        url: `https://github.com/${GITHUB_REPO}`,
        excerpt: "Stale repository copy",
        reference: null,
      },
    ],
    ...overrides,
  };
}

function workspaceState(
  sources: StoredProjectSource[],
): StoredWorkspaceState {
  return {
    sources,
    projects: [
      { id: PROJECT_ID, name: "Default", updatedAt: NOW - 10 * DAY_MS },
    ],
    conversations: [{ id: "conv_1", title: "Untouched" }],
  };
}

type FakeStore = ScheduledSourceSyncDeps["store"] & {
  rows: Map<string, { state: unknown; revision: number; updatedAt: Date }>;
  updateCalls: Array<{ userId: string; baseRevision: number }>;
  failNextUpdates: number;
  /** Simulates another writer (a client save) landing between CAS attempts. */
  mutate(userId: string, mutator: (state: StoredWorkspaceState) => StoredWorkspaceState): void;
};

function fakeStore(initial: Record<string, StoredWorkspaceState>): FakeStore {
  const rows = new Map(
    Object.entries(initial).map(([userId, state]) => [
      userId,
      { state: structuredClone(state) as unknown, revision: 1, updatedAt: new Date(NOW) },
    ]),
  );
  const store: FakeStore = {
    rows,
    updateCalls: [],
    failNextUpdates: 0,
    mutate(userId, mutator) {
      const row = rows.get(userId);
      if (!row) throw new Error(`no row for ${userId}`);
      row.state = mutator(structuredClone(row.state) as StoredWorkspaceState);
      row.revision += 1;
    },
    async get(userId) {
      const row = rows.get(userId);
      if (!row) return undefined;
      return {
        state: structuredClone(row.state),
        revision: row.revision,
        updatedAt: row.updatedAt,
      };
    },
    async create() {
      throw new Error("scheduled sync must never create workspaces");
    },
    async update(userId, state, baseRevision, updatedAt) {
      store.updateCalls.push({ userId, baseRevision });
      const row = rows.get(userId);
      if (!row || row.revision !== baseRevision) return undefined;
      if (store.failNextUpdates > 0) {
        store.failNextUpdates -= 1;
        // A concurrent writer won the row: revision moves on without us.
        row.revision += 1;
        return undefined;
      }
      row.state = structuredClone(state);
      row.revision += 1;
      row.updatedAt = updatedAt;
      return {
        state: structuredClone(row.state),
        revision: row.revision,
        updatedAt: row.updatedAt,
      };
    },
  };
  return store;
}

type LogEntry = {
  level: string;
  message: string;
  context: Record<string, unknown>;
};

type Harness = {
  store: FakeStore;
  deps: ScheduledSourceSyncDeps;
  websiteCalls: URL[];
  githubCalls: string[];
  logs: LogEntry[];
  clock: { now: number };
};

function harness(
  initial: Record<string, StoredWorkspaceState>,
  overrides: Partial<ScheduledSourceSyncDeps> = {},
): Harness {
  const store = fakeStore(initial);
  const websiteCalls: URL[] = [];
  const githubCalls: string[] = [];
  const logs: LogEntry[] = [];
  const clock = { now: NOW };

  const githubRoutes: Record<string, unknown> = {
    [`/repos/${GITHUB_REPO}`]: {
      name: "hello",
      full_name: GITHUB_REPO,
      html_url: `https://github.com/${GITHUB_REPO}`,
      description: "Fresh repository description",
      updated_at: new Date(NOW).toISOString(),
      open_issues_count: 1,
    },
    [`/repos/${GITHUB_REPO}/issues?state=open&per_page=20`]: [
      {
        number: 7,
        title: "Fresh issue",
        body: "Refreshed on the server",
        html_url: `https://github.com/${GITHUB_REPO}/issues/7`,
      },
      {
        number: 8,
        title: "Actually a pull request",
        body: "Must be filtered out",
        html_url: `https://github.com/${GITHUB_REPO}/pull/8`,
        pull_request: {},
      },
    ],
    [`/repos/${GITHUB_REPO}/pulls?state=open&per_page=10`]: [
      {
        number: 9,
        title: "Fresh pull request",
        body: "Open work",
        html_url: `https://github.com/${GITHUB_REPO}/pull/9`,
      },
    ],
  };

  const githubRequest: GitHubRequest = async <T>(path: string): Promise<T> => {
    githubCalls.push(path);
    const payload = githubRoutes[path];
    if (payload === undefined) throw new Error(`unexpected GitHub path ${path}`);
    return structuredClone(payload) as T;
  };

  const fetchWebsite: WebsiteFetcher = async (url) => {
    websiteCalls.push(url);
    return {
      status: 200,
      contentType: "text/html",
      contentLength: FRESH_HTML.length,
      html: FRESH_HTML,
    };
  };

  const log = (level: string) => (context: Record<string, unknown>, message: string) => {
    logs.push({ level, message, context });
  };

  const deps: ScheduledSourceSyncDeps = {
    listScheduledWorkspaceUserIds: async (limit, after) => {
      // Mirrors the real query: (updated_at, user id) ascending keyset pages.
      const ordered = [...store.rows.entries()]
        .map(([userId, row]) => ({
          userId,
          updatedAtMs: row.updatedAt.getTime(),
        }))
        .sort(
          (a, b) =>
            a.updatedAtMs - b.updatedAtMs ||
            (a.userId < b.userId ? -1 : a.userId > b.userId ? 1 : 0),
        );
      const fromCursor = after
        ? ordered.filter(
            (row) =>
              row.updatedAtMs > after.updatedAtMs ||
              (row.updatedAtMs === after.updatedAtMs &&
                row.userId > after.userId),
          )
        : ordered;
      return fromCursor.slice(0, limit);
    },
    store,
    isWorkspaceMember: (userId) => userId === USER_ID,
    githubRequest,
    resolveAddresses: async () => [{ address: "93.184.216.34" }],
    fetchWebsite,
    createAttestation: createSourceAttestation,
    log: {
      debug: log("debug"),
      info: log("info"),
      warn: log("warn"),
      error: log("error"),
    },
    now: () => clock.now,
    ...overrides,
  };

  return { store, deps, websiteCalls, githubCalls, logs, clock };
}

function storedSources(store: FakeStore, userId: string): StoredProjectSource[] {
  const row = store.rows.get(userId);
  assert.ok(row, `workspace row for ${userId}`);
  return workspaceSources(row.state as StoredWorkspaceState);
}

/** One pass's expected summary; overrides sit on an all-zero baseline. */
function passSummary(
  overrides: Partial<ScheduledSyncPassSummary> = {},
): ScheduledSyncPassSummary {
  return {
    workspaces: 0,
    dueWorkspaces: 0,
    dueSources: 0,
    synced: 0,
    failed: 0,
    deferred: 0,
    ...overrides,
  };
}

/** The summary line every pass emits, at debug/info/warn depending on load. */
function summaryLogs(logs: LogEntry[]): LogEntry[] {
  return logs.filter(
    (entry) => entry.message === "scheduled source sync pass summary",
  );
}

test("a due website source is re-synced with no client involved", async () => {
  const { store, deps, websiteCalls } = harness({
    [USER_ID]: workspaceState([websiteStoredSource()]),
  });
  const worker = createVenomScheduledSourceSyncWorker(deps);

  const summary = await worker.runPass();

  assert.deepEqual(
    summary,
    passSummary({ workspaces: 1, dueWorkspaces: 1, dueSources: 1, synced: 1 }),
  );
  assert.equal(websiteCalls.length, 1);

  const row = store.rows.get(USER_ID);
  assert.ok(row);
  // One write to claim the attempt, one to apply the refreshed snapshot.
  assert.equal(row.revision, 3);

  const sources = storedSources(store, USER_ID);
  assert.equal(sources.length, 1);
  const refreshed = sources[0];
  assert.equal(refreshed.id, WEBSITE_SOURCE_ID);
  assert.equal(typeof refreshed.syncedAt, "string");
  assert.ok(
    Date.parse(String(refreshed.syncedAt)) > NOW - 60_000,
    "snapshot timestamp is fresh",
  );
  assert.match(String(refreshed.context), /Fresh copy of the example content/);
  assert.match(String(refreshed.attestation), /^v1\./);
  assert.deepEqual(refreshed.schedule, {
    cadence: "daily",
    updatedAt: NOW - 5 * DAY_MS,
    lastAttemptAt: NOW,
  });

  // The rest of the workspace is carried through byte-for-byte.
  const state = row.state as StoredWorkspaceState;
  assert.deepEqual(state.projects, [
    { id: PROJECT_ID, name: "Default", updatedAt: NOW - 10 * DAY_MS },
  ]);
  assert.deepEqual(state.conversations, [{ id: "conv_1", title: "Untouched" }]);
  assert.equal(state.tombstones, undefined);
});

test("unchanged content skips the workspace write and still re-paces the schedule", async () => {
  const { store, deps, clock, websiteCalls } = harness({
    [USER_ID]: workspaceState([websiteStoredSource()]),
  });
  const worker = createVenomScheduledSourceSyncWorker(deps);

  // First pass: the stored copy is stale, so the fresh snapshot applies.
  assert.deepEqual(
    await worker.runPass(),
    passSummary({ workspaces: 1, dueWorkspaces: 1, dueSources: 1, synced: 1 }),
  );
  const row = store.rows.get(USER_ID);
  assert.ok(row);
  assert.equal(row.revision, 3);
  const [applied] = storedSources(store, USER_ID);

  // A day later the site serves byte-identical content. The check still
  // counts as a completed sync, but only the claim write may land — no
  // apply write, so no device has to re-download an unchanged snapshot.
  clock.now = NOW + DAY_MS + 60_000;
  assert.deepEqual(
    await worker.runPass(),
    passSummary({ workspaces: 1, dueWorkspaces: 1, dueSources: 1, synced: 1 }),
  );
  assert.equal(websiteCalls.length, 2);
  assert.equal(row.revision, 4, "claim write only; the apply was skipped");

  const [unchanged] = storedSources(store, USER_ID);
  assert.equal(unchanged.syncedAt, applied.syncedAt);
  assert.equal(unchanged.context, applied.context);
  assert.deepEqual(unchanged.citations, applied.citations);
  assert.equal(unchanged.attestation, applied.attestation);
  // The claim stamp is the "last checked" marker the card renders.
  assert.deepEqual(unchanged.schedule, {
    cadence: "daily",
    updatedAt: NOW - 5 * DAY_MS,
    lastAttemptAt: clock.now,
  });

  // The claim re-paced the cadence, so the skip cannot hot-loop the worker.
  assert.deepEqual(await worker.runPass(), passSummary({ workspaces: 1 }));
  assert.equal(websiteCalls.length, 2);
  assert.equal(row.revision, 4);
});

test("a pending failure still applies unchanged content so the card's error clears", async () => {
  const { store, deps, clock } = harness({
    [USER_ID]: workspaceState([websiteStoredSource()]),
  });
  const worker = createVenomScheduledSourceSyncWorker(deps);

  // Store the fresh snapshot, then shape the schedule the way a later failed
  // attempt leaves it: identical content, but a recorded failure.
  await worker.runPass();
  store.mutate(USER_ID, (state) => ({
    ...state,
    sources: workspaceSources(state).map((source) => ({
      ...source,
      schedule: {
        ...(source.schedule as Record<string, unknown>),
        cadence: "daily",
        lastAttemptAt: NOW + DAY_MS,
        lastError: "Website returned an unexpected response (500).",
      },
    })),
  }));

  clock.now = NOW + DAY_MS + FAILED_SYNC_RETRY_MS + 60_000;
  assert.deepEqual(
    await worker.runPass(),
    passSummary({ workspaces: 1, dueWorkspaces: 1, dueSources: 1, synced: 1 }),
  );

  // Claim + apply both wrote: skipping here would have left the stale
  // failure on the card and kept the hourly retry window live forever.
  assert.equal(store.rows.get(USER_ID)?.revision, 6);
  const [recovered] = storedSources(store, USER_ID);
  assert.equal(recovered.schedule?.lastError, undefined);
  assert.equal(recovered.schedule?.lastAttemptAt, clock.now);
});

test("snapshot comparison ignores only syncedAt and schedule bookkeeping", () => {
  const previous = websiteStoredSource({
    schedule: { cadence: "daily", updatedAt: NOW, lastAttemptAt: NOW },
  });
  const refreshed = websiteStoredSource({
    syncedAt: new Date(NOW).toISOString(),
    schedule: undefined,
  });

  assert.equal(scheduledSourceSnapshotUnchanged(previous, refreshed), true);

  // Any content drift forces the write.
  assert.equal(
    scheduledSourceSnapshotUnchanged(previous, {
      ...refreshed,
      context: "[source:cite_old] website: Example Domain. Different copy.",
    }),
    false,
  );
  assert.equal(
    scheduledSourceSnapshotUnchanged(previous, { ...refreshed, name: "Renamed" }),
    false,
  );
  assert.equal(
    scheduledSourceSnapshotUnchanged(previous, {
      ...refreshed,
      citations: [],
    }),
    false,
  );
  assert.equal(
    scheduledSourceSnapshotUnchanged(previous, {
      ...refreshed,
      attestation: "v1.someother",
    }),
    false,
  );
  // A stored field the connect replay would drop is a change, not a match.
  assert.equal(
    scheduledSourceSnapshotUnchanged(
      { ...previous, extraClientField: true },
      refreshed,
    ),
    false,
  );
  // A moved deterministic id must retire the old source via the tombstone.
  assert.equal(
    scheduledSourceSnapshotUnchanged(previous, {
      ...refreshed,
      id: "source_moved",
    }),
    false,
  );
  assert.equal(
    scheduledSourceSnapshotUnchanged(previous, {
      ...refreshed,
      projectId: "proj_other",
    }),
    false,
  );
  // A pending failure must still be cleared by an apply write.
  assert.equal(
    scheduledSourceSnapshotUnchanged(
      websiteStoredSource({
        schedule: {
          cadence: "daily",
          updatedAt: NOW,
          lastAttemptAt: NOW,
          lastError: "boom",
        },
      }),
      refreshed,
    ),
    false,
  );
});

test("a snapshot a client just refreshed is left alone", async () => {
  const { store, deps, websiteCalls } = harness({
    [USER_ID]: workspaceState([
      websiteStoredSource({ syncedAt: new Date(NOW - 60_000).toISOString() }),
    ]),
  });
  const worker = createVenomScheduledSourceSyncWorker(deps);

  const summary = await worker.runPass();

  assert.deepEqual(summary, passSummary({ workspaces: 1 }));
  assert.equal(websiteCalls.length, 0);
  assert.equal(store.updateCalls.length, 0);
  assert.equal(store.rows.get(USER_ID)?.revision, 1);
});

test("a failed sync keeps the previous snapshot and shows up on the card", async () => {
  const failing: WebsiteFetcher = async () => ({
    status: 500,
    contentType: "text/html",
    contentLength: 0,
    html: "",
  });
  const original = websiteStoredSource();
  const { store, deps, clock, websiteCalls } = harness(
    { [USER_ID]: workspaceState([original]) },
    { fetchWebsite: failing },
  );
  const worker = createVenomScheduledSourceSyncWorker(deps);

  const summary = await worker.runPass();
  assert.deepEqual(
    summary,
    passSummary({ workspaces: 1, dueWorkspaces: 1, dueSources: 1, failed: 1 }),
  );

  const [failed] = storedSources(store, USER_ID);
  // The stale snapshot survives untouched…
  assert.equal(failed.syncedAt, original.syncedAt);
  assert.deepEqual(failed.citations, original.citations);
  assert.equal(failed.context, original.context);
  // …and the failure is recorded where the source card reads it.
  assert.deepEqual(failed.schedule, {
    cadence: "daily",
    updatedAt: NOW - 5 * DAY_MS,
    lastAttemptAt: NOW,
    lastError: "Website returned an unexpected response (500).",
  });

  // Immediately after, the failure paces the retry: nothing is due.
  const idle = await worker.runPass();
  assert.deepEqual(idle, passSummary({ workspaces: 1 }));

  // Once the retry window passes, the source is picked up again.
  clock.now = NOW + FAILED_SYNC_RETRY_MS + 1;
  deps.fetchWebsite = async (url) => {
    websiteCalls.push(url);
    return {
      status: 200,
      contentType: "text/html",
      contentLength: FRESH_HTML.length,
      html: FRESH_HTML,
    };
  };
  const retried = await worker.runPass();
  assert.deepEqual(
    retried,
    passSummary({ workspaces: 1, dueWorkspaces: 1, dueSources: 1, synced: 1 }),
  );
  const [recovered] = storedSources(store, USER_ID);
  assert.equal(recovered.schedule?.lastError, undefined);
  assert.equal(recovered.schedule?.lastAttemptAt, clock.now);
});

test("losing the claim race skips the fetch entirely", async () => {
  const { store, deps, websiteCalls } = harness({
    [USER_ID]: workspaceState([websiteStoredSource()]),
  });
  store.failNextUpdates = 1;
  const worker = createVenomScheduledSourceSyncWorker(deps);

  const summary = await worker.runPass();

  // The due source was measured, but the lost claim spends no sync slot.
  assert.deepEqual(
    summary,
    passSummary({ workspaces: 1, dueWorkspaces: 1, dueSources: 1 }),
  );
  assert.equal(websiteCalls.length, 0);
  assert.equal(store.updateCalls.length, 1);
});

test("a source deleted while the fetch runs is not resurrected", async () => {
  const { store, deps } = harness({
    [USER_ID]: workspaceState([websiteStoredSource()]),
  });
  deps.fetchWebsite = async () => {
    // The user deletes the source on another device mid-fetch.
    store.mutate(USER_ID, (state) => ({
      ...state,
      sources: [],
      tombstones: { sources: [{ id: WEBSITE_SOURCE_ID, deletedAt: NOW }] },
    }));
    return {
      status: 200,
      contentType: "text/html",
      contentLength: FRESH_HTML.length,
      html: FRESH_HTML,
    };
  };
  const worker = createVenomScheduledSourceSyncWorker(deps);

  const summary = await worker.runPass();

  assert.deepEqual(
    summary,
    passSummary({ workspaces: 1, dueWorkspaces: 1, dueSources: 1 }),
  );
  assert.deepEqual(storedSources(store, USER_ID), []);
});

test("a due GitHub source re-syncs through the same membership gate as connect", async () => {
  const { store, deps, githubCalls } = harness({
    [USER_ID]: workspaceState([githubStoredSource()]),
  });
  const worker = createVenomScheduledSourceSyncWorker(deps);

  const summary = await worker.runPass();

  assert.deepEqual(
    summary,
    passSummary({ workspaces: 1, dueWorkspaces: 1, dueSources: 1, synced: 1 }),
  );
  assert.equal(githubCalls.length, 3);
  const [refreshed] = storedSources(store, USER_ID);
  assert.equal(refreshed.id, GITHUB_SOURCE_ID);
  assert.match(String(refreshed.context), /Fresh issue/);
  assert.ok(
    !String(refreshed.context).includes("Actually a pull request"),
    "issues listing keeps plain issues only",
  );
  assert.match(String(refreshed.attestation), /^v1\./);
});

test("a non-member owner gets the connect route's refusal on the card", async () => {
  const outsider = "user_outsider99";
  const { store, deps, githubCalls } = harness({
    [outsider]: workspaceState([githubStoredSource()]),
  });
  const worker = createVenomScheduledSourceSyncWorker(deps);

  const summary = await worker.runPass();

  assert.deepEqual(
    summary,
    passSummary({ workspaces: 1, dueWorkspaces: 1, dueSources: 1, failed: 1 }),
  );
  assert.equal(githubCalls.length, 0);
  const [failed] = storedSources(store, outsider);
  assert.equal(
    failed.schedule?.lastError,
    "Your account is not authorized to use this workspace GitHub connection.",
  );
  assert.equal(failed.syncedAt, githubStoredSource().syncedAt);
});

test("a source whose connect request cannot be rebuilt records the remove-and-reconnect message", async () => {
  const { store, deps, websiteCalls } = harness({
    [USER_ID]: workspaceState([
      websiteStoredSource({ url: "http://insecure.example.com/" }),
    ]),
  });
  const worker = createVenomScheduledSourceSyncWorker(deps);

  const summary = await worker.runPass();

  assert.deepEqual(
    summary,
    passSummary({ workspaces: 1, dueWorkspaces: 1, dueSources: 1, failed: 1 }),
  );
  assert.equal(websiteCalls.length, 0);
  const [failed] = storedSources(store, USER_ID);
  assert.equal(failed.schedule?.lastError, UNSUPPORTED_SCHEDULED_SOURCE_MESSAGE);
});

test("a backlog beyond the surge ceiling drains bounded and defers the rest", async () => {
  // Two more due workspaces than even the surge budget may drain.
  const initial: Record<string, StoredWorkspaceState> = {};
  for (let index = 0; index < MAX_SYNCS_PER_PASS + 2; index += 1) {
    initial[`user_capCheck${index}`] = workspaceState([websiteStoredSource()]);
  }
  const { deps, websiteCalls, logs } = harness(initial);
  const worker = createVenomScheduledSourceSyncWorker(deps);

  const summary = await worker.runPass();

  assert.deepEqual(
    summary,
    passSummary({
      workspaces: MAX_SYNCS_PER_PASS + 2,
      dueWorkspaces: MAX_SYNCS_PER_PASS + 2,
      dueSources: MAX_SYNCS_PER_PASS + 2,
      synced: MAX_SYNCS_PER_PASS,
      deferred: 2,
    }),
  );
  assert.equal(websiteCalls.length, MAX_SYNCS_PER_PASS);

  // Deferred work is exactly what the warn-level summary exists to surface.
  const [warned] = summaryLogs(logs);
  assert.ok(warned);
  assert.equal(warned.level, "warn");
  assert.equal(warned.context.deferred, 2);
  assert.equal(warned.context.budget, MAX_SYNCS_PER_PASS);

  // The next pass picks up the workspaces the ceiling deferred.
  const second = await worker.runPass();
  assert.deepEqual(
    second,
    passSummary({
      workspaces: MAX_SYNCS_PER_PASS + 2,
      dueWorkspaces: 2,
      dueSources: 2,
      synced: 2,
    }),
  );
});

test("one user with many stale sources cannot starve other users' due sources", async () => {
  // Eight sources in one workspace, every one of them longer overdue than
  // any other user's — a per-source greedy drain would spend the whole pass
  // budget on this single hoarder.
  const hoarder = "user_hoarder0000";
  const hoarderSources = Array.from({ length: 8 }, (_, index) => {
    const url = `https://example.com/stale-${index}`;
    return websiteStoredSource({
      id: sourceId(PROJECT_ID, `website:${url}`),
      url,
      syncedAt: new Date(NOW - 30 * DAY_MS).toISOString(),
    });
  });

  const initial: Record<string, StoredWorkspaceState> = {
    [hoarder]: workspaceState(hoarderSources),
  };
  const others = Array.from({ length: 5 }, (_, index) => `user_patient${index}`);
  for (const userId of others) {
    initial[userId] = workspaceState([websiteStoredSource()]);
  }

  const { store, deps } = harness(initial);
  const worker = createVenomScheduledSourceSyncWorker(deps);

  const summary = await worker.runPass();

  // The whole backlog is measured (8 + 5 due sources)…
  assert.deepEqual(
    summary,
    passSummary({
      workspaces: 6,
      dueWorkspaces: 6,
      dueSources: 13,
      synced: 6,
    }),
  );

  // …but the hoarder got exactly one slot, and every other user's due
  // source was refreshed in the very same pass.
  const freshCount = (userId: string) =>
    storedSources(store, userId).filter((source) =>
      /Fresh copy/.test(String(source.context)),
    ).length;
  assert.equal(freshCount(hoarder), 1);
  for (const userId of others) {
    assert.equal(freshCount(userId), 1);
  }

  // The next pass hands the hoarder one more slot — one per pass, no more.
  const second = await worker.runPass();
  assert.deepEqual(
    second,
    passSummary({ workspaces: 6, dueWorkspaces: 1, dueSources: 7, synced: 1 }),
  );
  assert.equal(freshCount(hoarder), 2);
});

test("a front full of not-yet-due schedules cannot hide an overdue daily beyond the window", async () => {
  const initial: Record<string, StoredWorkspaceState> = {};
  for (let index = 0; index < MAX_WORKSPACES_PER_PASS; index += 1) {
    // Weekly schedules refreshed recently: scheduled, so the scan returns
    // them, but not due for days — and never rewritten, so their updated_at
    // never moves.
    initial[`user_weeklyCamper${String(index).padStart(2, "0")}`] =
      workspaceState([
        websiteStoredSource({ schedule: { cadence: "weekly", updatedAt: NOW } }),
      ]);
  }
  initial.user_overdueDaily = workspaceState([websiteStoredSource()]);
  const { deps, store } = harness(initial);
  // The campers are the oldest rows, so they fill the entire first page; the
  // overdue daily sits just beyond it. A fixed 50-row window would rescan
  // the campers every minute, forever.
  let age = 0;
  for (const [userId, row] of store.rows) {
    if (userId !== "user_overdueDaily") {
      row.updatedAt = new Date(NOW - 10 * DAY_MS + age * 1000);
      age += 1;
    }
  }
  const worker = createVenomScheduledSourceSyncWorker(deps);

  const summary = await worker.runPass();

  assert.deepEqual(
    summary,
    passSummary({
      workspaces: MAX_WORKSPACES_PER_PASS + 1,
      dueWorkspaces: 1,
      dueSources: 1,
      synced: 1,
    }),
  );
  const [refreshed] = storedSources(store, "user_overdueDaily");
  assert.match(String(refreshed.context), /Fresh copy/);
});

test("the scan cursor rotates past a camped front across passes", async () => {
  // More campers than one pass may even read (4 pages × 50), with the only
  // due workspace behind all of them.
  const camperCount = MAX_SCAN_PAGES_PER_PASS * MAX_WORKSPACES_PER_PASS + 20;
  const initial: Record<string, StoredWorkspaceState> = {};
  for (let index = 0; index < camperCount; index += 1) {
    initial[`user_cursorCamper${String(index).padStart(3, "0")}`] =
      workspaceState([
        websiteStoredSource({ schedule: { cadence: "weekly", updatedAt: NOW } }),
      ]);
  }
  initial.user_behindTheCamp = workspaceState([websiteStoredSource()]);
  const { deps, store, logs } = harness(initial);
  let age = 0;
  for (const [userId, row] of store.rows) {
    if (userId !== "user_behindTheCamp") {
      row.updatedAt = new Date(NOW - 10 * DAY_MS + age * 1000);
      age += 1;
    }
  }
  const worker = createVenomScheduledSourceSyncWorker(deps);

  // Pass 1 exhausts its read bound without reaching the due workspace. That
  // is allowed — but it must not report a certified-idle pass, and it must
  // remember where it stopped.
  const first = await worker.runPass();
  assert.deepEqual(
    first,
    passSummary({
      workspaces: MAX_SCAN_PAGES_PER_PASS * MAX_WORKSPACES_PER_PASS,
    }),
  );
  const [firstLog] = summaryLogs(logs);
  assert.ok(firstLog, "saturated pass must log a summary");
  assert.equal(firstLog.level, "info");
  assert.equal(firstLog.context.scanSaturated, true);
  assert.equal(firstLog.context.pagesScanned, MAX_SCAN_PAGES_PER_PASS);

  // Pass 2 re-reads the front page (still first in line for genuinely due
  // work), then continues from the cursor instead of rescanning the same
  // camped middle — and reaches the workspace the camp was hiding.
  const second = await worker.runPass();
  assert.deepEqual(
    second,
    passSummary({
      workspaces: MAX_WORKSPACES_PER_PASS + 21,
      dueWorkspaces: 1,
      dueSources: 1,
      synced: 1,
    }),
  );
  const [refreshed] = storedSources(store, "user_behindTheCamp");
  assert.match(String(refreshed.context), /Fresh copy/);
});

test("a surge drains through a bounded pool of parallel claims", async () => {
  const initial: Record<string, StoredWorkspaceState> = {};
  for (let index = 0; index < 8; index += 1) {
    initial[`user_parallel0${index}`] = workspaceState([websiteStoredSource()]);
  }
  const { deps } = harness(initial);
  let inFetch = 0;
  let maxInFetch = 0;
  deps.fetchWebsite = async () => {
    inFetch += 1;
    maxInFetch = Math.max(maxInFetch, inFetch);
    // Suspend on a macrotask so every pooled sync is in its fetch at once.
    await new Promise((resolve) => setImmediate(resolve));
    inFetch -= 1;
    return {
      status: 200,
      contentType: "text/html",
      contentLength: FRESH_HTML.length,
      html: FRESH_HTML,
    };
  };
  const worker = createVenomScheduledSourceSyncWorker(deps);

  const summary = await worker.runPass();

  assert.deepEqual(
    summary,
    passSummary({ workspaces: 8, dueWorkspaces: 8, dueSources: 8, synced: 8 }),
  );
  assert.equal(maxInFetch, SCHEDULED_SYNC_CONCURRENCY);
});

test("slow fetches stop new launches at the deadline instead of holding the worker", async () => {
  // Six due workspaces, and every fetch consumes the whole launch window —
  // the worst case the reviewer of this budget cares about: a surge of
  // barely-responding upstreams.
  const initial: Record<string, StoredWorkspaceState> = {};
  for (let index = 0; index < 6; index += 1) {
    initial[`user_slowFetch0${index}`] = workspaceState([websiteStoredSource()]);
  }
  const { deps, logs, clock } = harness(initial);
  const slowResponse = () => {
    clock.now += SCHEDULED_SYNC_LAUNCH_DEADLINE_MS;
    return {
      status: 200,
      contentType: "text/html",
      contentLength: FRESH_HTML.length,
      html: FRESH_HTML,
    };
  };
  deps.fetchWebsite = async () => slowResponse();
  const worker = createVenomScheduledSourceSyncWorker(deps);

  const summary = await worker.runPass();

  // The first pooled wave launches before anyone can know the upstreams are
  // slow; in-flight syncs finish, but nothing new launches past the
  // deadline. The remainder is deferred, not silently queued behind a pass
  // that runs for many minutes.
  assert.deepEqual(
    summary,
    passSummary({
      workspaces: 6,
      dueWorkspaces: 6,
      dueSources: 6,
      synced: SCHEDULED_SYNC_CONCURRENCY,
      deferred: 6 - SCHEDULED_SYNC_CONCURRENCY,
    }),
  );
  const [warned] = summaryLogs(logs);
  assert.ok(warned);
  assert.equal(warned.level, "warn");
  assert.equal(warned.context.deadlineHit, true);
  assert.equal(warned.context.deferred, 6 - SCHEDULED_SYNC_CONCURRENCY);

  // The overloaded pass did not wedge anything: once upstreams recover, the
  // very next pass drains what was deferred.
  deps.fetchWebsite = async () => ({
    status: 200,
    contentType: "text/html",
    contentLength: FRESH_HTML.length,
    html: FRESH_HTML,
  });
  const second = await worker.runPass();
  assert.deepEqual(
    second,
    passSummary({ workspaces: 6, dueWorkspaces: 2, dueSources: 2, synced: 2 }),
  );
});

test("a tick landing mid-pass is skipped loudly, and the pass still completes", async () => {
  const { deps, logs, clock } = harness({
    [USER_ID]: workspaceState([websiteStoredSource()]),
  });
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  deps.fetchWebsite = async () => {
    await gate;
    return {
      status: 200,
      contentType: "text/html",
      contentLength: FRESH_HTML.length,
      html: FRESH_HTML,
    };
  };
  const worker = createVenomScheduledSourceSyncWorker(deps);

  const first = worker.runPass();
  // Let the pass reach its blocked fetch, then pretend 90 seconds pass and
  // the next interval tick fires.
  await new Promise((resolve) => setImmediate(resolve));
  clock.now += 90_000;
  const overlap = await worker.runPass();

  assert.deepEqual(overlap, passSummary());
  const skipped = logs.find(
    (entry) =>
      entry.message ===
      "scheduled source sync tick skipped; previous pass still running",
  );
  assert.ok(skipped, "overlap tick must log");
  assert.equal(skipped.level, "warn");
  assert.equal(skipped.context.runningForMs, 90_000);

  release();
  assert.deepEqual(
    await first,
    passSummary({ workspaces: 1, dueWorkspaces: 1, dueSources: 1, synced: 1 }),
  );
});

test("every pass logs a due-vs-synced summary at a level matching its load", async () => {
  const { deps, logs } = harness({
    [USER_ID]: workspaceState([websiteStoredSource()]),
  });
  const worker = createVenomScheduledSourceSyncWorker(deps);

  await worker.runPass();
  const [busy] = summaryLogs(logs);
  assert.ok(busy);
  assert.equal(busy.level, "info");
  assert.equal(busy.context.operation, "venom_scheduled_source_sync");
  assert.equal(busy.context.dueWorkspaces, 1);
  assert.equal(busy.context.dueSources, 1);
  assert.equal(busy.context.synced, 1);
  assert.equal(busy.context.deferred, 0);
  assert.equal(busy.context.budget, BASE_SYNCS_PER_PASS);
  assert.equal(busy.context.scanLimit, MAX_WORKSPACES_PER_PASS);
  assert.equal(busy.context.scanSaturated, false);

  // Nothing due afterwards: the heartbeat drops to debug so steady state
  // does not write an info line every minute.
  logs.length = 0;
  await worker.runPass();
  const [quiet] = summaryLogs(logs);
  assert.ok(quiet);
  assert.equal(quiet.level, "debug");
  assert.equal(quiet.context.dueSources, 0);
  assert.equal(summaryLogs(logs).length, 1);
});

test("due counting sees every due source, not just the one a pass would pick", () => {
  const due = websiteStoredSource();
  const alsoDue = websiteStoredSource({ id: "source_second" });
  const retryElapsed = websiteStoredSource({
    id: "source_retry",
    schedule: {
      cadence: "daily",
      updatedAt: NOW,
      lastAttemptAt: NOW - 2 * FAILED_SYNC_RETRY_MS,
      lastError: "boom",
    },
  });
  const notYet = websiteStoredSource({
    id: "source_fresh",
    syncedAt: new Date(NOW - 60_000).toISOString(),
  });
  const retryPending = websiteStoredSource({
    id: "source_waiting",
    schedule: {
      cadence: "daily",
      updatedAt: NOW,
      lastAttemptAt: NOW - 60_000,
      lastError: "boom",
    },
  });
  const unscheduled = websiteStoredSource({
    id: "source_manual",
    schedule: undefined,
  });
  const off = websiteStoredSource({
    id: "source_off",
    schedule: { cadence: "off", updatedAt: NOW },
  });

  assert.equal(
    countDueScheduledSources(
      [due, alsoDue, retryElapsed, notYet, retryPending, unscheduled, off],
      NOW,
    ),
    3,
  );
  assert.equal(countDueScheduledSources([], NOW), 0);
});

test("the sync budget follows the measured backlog inside hard bounds", () => {
  assert.equal(scheduledSyncBudget(0), BASE_SYNCS_PER_PASS);
  assert.equal(scheduledSyncBudget(BASE_SYNCS_PER_PASS - 1), BASE_SYNCS_PER_PASS);
  assert.equal(scheduledSyncBudget(BASE_SYNCS_PER_PASS), BASE_SYNCS_PER_PASS);
  assert.equal(
    scheduledSyncBudget(BASE_SYNCS_PER_PASS + 7),
    BASE_SYNCS_PER_PASS + 7,
  );
  assert.equal(scheduledSyncBudget(MAX_SYNCS_PER_PASS), MAX_SYNCS_PER_PASS);
  assert.equal(scheduledSyncBudget(MAX_SYNCS_PER_PASS + 500), MAX_SYNCS_PER_PASS);
  // The scan window must be able to out-measure the surge ceiling, or the
  // deferred signal could never fire.
  assert.ok(MAX_WORKSPACES_PER_PASS > MAX_SYNCS_PER_PASS);
  // The launch deadline must leave room inside the tick interval for the
  // straggling in-flight fetches a pass never aborts.
  assert.ok(
    SCHEDULED_SYNC_LAUNCH_DEADLINE_MS < SCHEDULED_SOURCE_SYNC_INTERVAL_MS,
  );
  // Parallelism exists to compress slow surges, never to exceed the base
  // pace on its own.
  assert.ok(SCHEDULED_SYNC_CONCURRENCY >= 2);
  assert.ok(SCHEDULED_SYNC_CONCURRENCY <= BASE_SYNCS_PER_PASS);
  // Rotation needs at least the front page plus one cursor page, or a
  // camped front page would still be a wall.
  assert.ok(MAX_SCAN_PAGES_PER_PASS >= 2);
});

test("one broken workspace does not stall the rest of the pass", async () => {
  const broken = "user_brokenRow00";
  const { store, deps } = harness({
    [broken]: workspaceState([websiteStoredSource()]),
    [USER_ID]: workspaceState([websiteStoredSource()]),
  });
  const originalGet = store.get.bind(store);
  store.get = async (userId) => {
    if (userId === broken) throw new Error("row unreadable");
    return originalGet(userId);
  };
  const worker = createVenomScheduledSourceSyncWorker(deps);

  const summary = await worker.runPass();

  assert.deepEqual(
    summary,
    passSummary({
      workspaces: 2,
      dueWorkspaces: 1,
      dueSources: 1,
      synced: 1,
      failed: 1,
    }),
  );
  assert.equal(storedSources(store, USER_ID).length, 1);
  assert.match(String(storedSources(store, USER_ID)[0].context), /Fresh copy/);
});

test("dueness mirrors the client pacing rules", () => {
  const base = websiteStoredSource();
  const syncedAtMs = Date.parse(String(base.syncedAt));

  assert.equal(
    scheduledSyncDueAt(websiteStoredSource({ schedule: undefined })),
    null,
  );
  assert.equal(
    scheduledSyncDueAt(
      websiteStoredSource({ schedule: { cadence: "off", updatedAt: NOW } }),
    ),
    null,
  );
  assert.equal(scheduledSyncDueAt(base), syncedAtMs + DAY_MS);
  assert.equal(
    scheduledSyncDueAt(
      websiteStoredSource({
        schedule: { cadence: "weekly", updatedAt: NOW },
      }),
    ),
    syncedAtMs + 7 * DAY_MS,
  );
  // A failed attempt is paced by the shorter retry window.
  assert.equal(
    scheduledSyncDueAt(
      websiteStoredSource({
        schedule: {
          cadence: "daily",
          updatedAt: NOW,
          lastAttemptAt: NOW - 60_000,
          lastError: "boom",
        },
      }),
    ),
    NOW - 60_000 + FAILED_SYNC_RETRY_MS,
  );
  // Attempt bookkeeping without an error paces from the newest of the two.
  assert.equal(
    scheduledSyncDueAt(
      websiteStoredSource({
        schedule: {
          cadence: "daily",
          updatedAt: NOW,
          lastAttemptAt: syncedAtMs + 60_000,
        },
      }),
    ),
    syncedAtMs + 60_000 + DAY_MS,
  );
});

test("the longest-overdue source goes first, ids break ties", () => {
  const older = websiteStoredSource({
    id: "source_zz",
    syncedAt: new Date(NOW - 5 * DAY_MS).toISOString(),
  });
  const newer = websiteStoredSource({ id: "source_aa" });
  assert.equal(nextDueScheduledSource([newer, older], NOW)?.id, "source_zz");

  const tieLeft = websiteStoredSource({ id: "source_aa" });
  const tieRight = websiteStoredSource({ id: "source_bb" });
  assert.equal(
    nextDueScheduledSource([tieRight, tieLeft], NOW)?.id,
    "source_aa",
  );
  assert.equal(nextDueScheduledSource([], NOW), null);
});

test("claiming an attempt keeps the previous failure visible", () => {
  const source = websiteStoredSource({
    schedule: {
      cadence: "daily",
      updatedAt: NOW,
      lastAttemptAt: NOW - DAY_MS,
      lastError: "previous failure",
    },
  });
  const claimed = claimScheduledSourceAttempt([source], source.id, NOW);
  assert.ok(claimed);
  assert.deepEqual(claimed[0].schedule, {
    cadence: "daily",
    updatedAt: NOW,
    lastAttemptAt: NOW,
    lastError: "previous failure",
  });

  assert.equal(
    claimScheduledSourceAttempt(
      [websiteStoredSource({ schedule: { cadence: "off", updatedAt: NOW } })],
      WEBSITE_SOURCE_ID,
      NOW,
    ),
    null,
  );
});

test("failure records trim, fall back, and respect an off schedule", () => {
  const long = "x".repeat(400);
  const recorded = recordScheduledSourceSyncFailure(
    [websiteStoredSource()],
    WEBSITE_SOURCE_ID,
    NOW,
    long,
  );
  assert.ok(recorded);
  assert.equal(recorded[0].schedule?.lastError?.length, 300);

  const fallback = recordScheduledSourceSyncFailure(
    [websiteStoredSource()],
    WEBSITE_SOURCE_ID,
    NOW,
    "   ",
  );
  assert.ok(fallback);
  assert.equal(
    fallback[0].schedule?.lastError,
    "Venom could not update this source.",
  );

  assert.equal(
    recordScheduledSourceSyncFailure(
      [websiteStoredSource({ schedule: { cadence: "off", updatedAt: NOW } })],
      WEBSITE_SOURCE_ID,
      NOW,
      "boom",
    ),
    null,
  );
});

test("applying a refresh mirrors the client's replace semantics", () => {
  const previous = websiteStoredSource();
  const refreshed = websiteStoredSource({
    syncedAt: new Date(NOW).toISOString(),
    schedule: undefined,
    context: "[source:cite_new] website: Example Domain. Fresh.",
  });

  const applied = applyRefreshedScheduledSource(
    [previous],
    previous.id,
    refreshed,
    NOW,
  );
  assert.ok(applied);
  assert.equal(applied.retiredSourceId, null);
  assert.deepEqual(applied.sources[0].schedule, {
    cadence: "daily",
    updatedAt: NOW - 5 * DAY_MS,
    lastAttemptAt: NOW,
  });

  // The refresh landed on a different deterministic id: the old one retires.
  const moved = applyRefreshedScheduledSource(
    [previous],
    previous.id,
    { ...refreshed, id: "source_moved" },
    NOW,
  );
  assert.ok(moved);
  assert.equal(moved.retiredSourceId, previous.id);
  const withTombstone = withReplacedSourceTombstone(
    { sources: moved.sources },
    moved.retiredSourceId!,
    NOW,
  );
  assert.deepEqual((withTombstone.tombstones as Record<string, unknown>).sources, [
    { id: previous.id, deletedAt: NOW, replaced: true },
  ]);

  // Discards: source gone, project moved, or a newer snapshot already there.
  assert.equal(
    applyRefreshedScheduledSource([], previous.id, refreshed, NOW),
    null,
  );
  assert.equal(
    applyRefreshedScheduledSource(
      [previous],
      previous.id,
      { ...refreshed, projectId: "proj_other" },
      NOW,
    ),
    null,
  );
  assert.equal(
    applyRefreshedScheduledSource(
      [websiteStoredSource({ syncedAt: new Date(NOW + DAY_MS).toISOString() })],
      previous.id,
      refreshed,
      NOW,
    ),
    null,
  );
});

// ---------------------------------------------------------------------------
// Drift guards: the server's tombstone rules must BE the shared cross-device
// rules from @workspace/venom-workspace-merge — the exact functions the phone
// and desktop apps run (their side is guarded the same way in
// artifacts/venom-desktop/src/lib/workspaceMergeRules.test.mjs). Reference
// identity fails the moment a hand-written server copy sneaks back in, and
// the fixture tests below pin the outcomes so the server and the lib cannot
// drift in lockstep unnoticed either.
// ---------------------------------------------------------------------------

test("server tombstone rules are the shared implementations, not local copies", () => {
  assert.equal(isReplacementMarker, sharedMergeRules.isReplacementMarker);
  assert.equal(mergeDeletionMarkers, sharedMergeRules.mergeDeletionMarkers);
  assert.equal(createDeletionMarkers, sharedMergeRules.createDeletionMarkers);
  assert.equal(TOMBSTONE_LIMITS, sharedMergeRules.TOMBSTONE_LIMITS);
  // The cap the server writes under is the apps' sources cap — the API
  // schema's maxItems bound for tombstones.sources — not a server constant.
  assert.equal(TOMBSTONE_LIMITS.sources, 2000);
});

// The schedule bookkeeping readers cannot be imported directly: the shared
// signatures take the validated client schedule shape, while the server reads
// the untrusted stored blob. They must still AGREE — dueness and carried
// schedules are paced off these reads on both sides — so run both over the
// same fixtures, hostile values included.
test("server schedule readers agree with the shared rules on the same fixtures", () => {
  type SharedSchedule = Parameters<
    typeof sharedMergeRules.scheduleAttemptAt
  >[0];
  const fixtures: Array<Record<string, unknown>> = [
    { cadence: "daily", updatedAt: 1_000, lastAttemptAt: 2_000 },
    { cadence: "weekly", updatedAt: 0, lastAttemptAt: 0 },
    { cadence: "daily", updatedAt: 5 },
    { cadence: "daily" },
    { cadence: "daily", updatedAt: Number.NaN, lastAttemptAt: Number.NaN },
    { cadence: "daily", updatedAt: Infinity, lastAttemptAt: -Infinity },
    { cadence: "off", updatedAt: "3", lastAttemptAt: "soon" },
    { cadence: "daily", updatedAt: null, lastAttemptAt: null },
    { cadence: "daily", updatedAt: -1, lastAttemptAt: -1 },
  ];
  for (const fixture of fixtures) {
    const label = JSON.stringify(fixture);
    assert.equal(
      scheduleAttemptAt(fixture as StoredSourceSchedule),
      sharedMergeRules.scheduleAttemptAt(fixture as unknown as SharedSchedule),
      `scheduleAttemptAt drifted for ${label}`,
    );
    assert.equal(
      scheduleUpdatedAt(fixture as StoredSourceSchedule),
      sharedMergeRules.scheduleUpdatedAt(fixture as unknown as SharedSchedule),
      `scheduleUpdatedAt drifted for ${label}`,
    );
  }
});

test("withReplacedSourceTombstone writes exactly what the shared rules produce", () => {
  const existing = [
    { id: "plain-keep", deletedAt: 1_000 },
    // An older plain marker for the id being retired: the retirement must
    // upgrade it to a replacement marker, not sit next to it.
    { id: "retired-source", deletedAt: 500 },
    { id: "replaced-keep", deletedAt: 250, replaced: true },
  ];
  const state: StoredWorkspaceState = {
    sources: [],
    tombstones: {
      sources: existing.map((marker) => ({ ...marker })),
      messages: [{ id: "msg", deletedAt: 9 }],
    },
  };

  const next = withReplacedSourceTombstone(state, "retired-source", 2_000);
  const tombstones = next.tombstones as Record<string, unknown>;

  // Byte-for-byte what the apps' shared rules produce on the same fixtures.
  assert.deepEqual(
    tombstones.sources,
    sharedMergeRules.mergeDeletionMarkers(
      sharedMergeRules.TOMBSTONE_LIMITS.sources,
      existing,
      sharedMergeRules.createDeletionMarkers(["retired-source"], 2_000, {
        replaced: true,
      }),
    ),
  );
  // Pinned outcome: newest first, the retired id upgraded to a replacement
  // marker at the retirement time, everything else untouched.
  assert.deepEqual(tombstones.sources, [
    { id: "retired-source", deletedAt: 2_000, replaced: true },
    { id: "plain-keep", deletedAt: 1_000 },
    { id: "replaced-keep", deletedAt: 250, replaced: true },
  ]);
  // Other tombstone collections pass through unmodified.
  assert.deepEqual(tombstones.messages, [{ id: "msg", deletedAt: 9 }]);

  // Clock-skew branch: a stored marker newer than the retirement write keeps
  // its (newer) deletedAt but the replacement flag is sticky — the shared
  // merge's rule, where the old server copy would have discarded the newer
  // timestamp instead.
  const skewed = withReplacedSourceTombstone(
    {
      sources: [],
      tombstones: { sources: [{ id: "retired-source", deletedAt: 3_000 }] },
    },
    "retired-source",
    2_000,
  );
  assert.deepEqual((skewed.tombstones as Record<string, unknown>).sources, [
    { id: "retired-source", deletedAt: 3_000, replaced: true },
  ]);
});

test("the marker cap evicts plain deletions before replacement markers, like the apps", () => {
  const limit = sharedMergeRules.TOMBSTONE_LIMITS.sources;
  // Fill the stored list to the cap, alternating plain and replaced markers
  // oldest-first, then retire one more source so the cap must evict.
  const existing: Array<{ id: string; deletedAt: number; replaced?: boolean }> =
    Array.from({ length: limit }, (_, index) => ({
      id: `marker-${index}`,
      deletedAt: 10_000 + index,
      ...(index % 2 === 1 ? { replaced: true } : {}),
    }));

  const next = withReplacedSourceTombstone(
    {
      sources: [],
      tombstones: { sources: existing.map((marker) => ({ ...marker })) },
    },
    "retired-over-cap",
    999_999_999,
  );
  const bounded = (next.tombstones as Record<string, unknown>)
    .sources as Array<{ id: string; deletedAt: number; replaced?: boolean }>;

  assert.deepEqual(
    bounded,
    sharedMergeRules.mergeDeletionMarkers(
      limit,
      existing,
      sharedMergeRules.createDeletionMarkers(["retired-over-cap"], 999_999_999, {
        replaced: true,
      }),
    ),
  );
  assert.equal(bounded.length, limit);
  // The new replacement marker landed at the front (newest first)…
  assert.deepEqual(bounded[0], {
    id: "retired-over-cap",
    deletedAt: 999_999_999,
    replaced: true,
  });
  // …the eviction victim was the oldest PLAIN marker…
  assert.ok(!bounded.some((marker) => marker.id === "marker-0"));
  // …and every replacement marker survived, including the oldest one.
  assert.ok(bounded.some((marker) => marker.id === "marker-1"));
  assert.equal(
    bounded.filter((marker) => marker.replaced === true).length,
    limit / 2 + 1,
  );
});

test("stored refresh requests rebuild the original connect call", () => {
  assert.deepEqual(scheduledSourceRefreshRequest(githubStoredSource()), {
    provider: "github",
    projectId: PROJECT_ID,
    repository: GITHUB_REPO,
  });
  assert.deepEqual(
    scheduledSourceRefreshRequest(
      githubStoredSource({ name: "Hello Repo", url: "https://github.com/octocat/hello.git" }),
    ),
    { provider: "github", projectId: PROJECT_ID, repository: GITHUB_REPO },
  );
  assert.deepEqual(scheduledSourceRefreshRequest(websiteStoredSource()), {
    provider: "website",
    projectId: PROJECT_ID,
    url: WEBSITE_URL,
  });
  assert.equal(
    scheduledSourceRefreshRequest(
      websiteStoredSource({ url: "http://insecure.example.com/" }),
    ),
    null,
  );
  assert.equal(
    scheduledSourceRefreshRequest(
      websiteStoredSource({ provider: "mystery" }),
    ),
    null,
  );
});

// ---------------------------------------------------------------------------
// Persistent-failure alert sink
// ---------------------------------------------------------------------------

function alertRecorder() {
  const failures: Array<{
    userId: string;
    sourceId: string;
    provider: string;
    message: string;
    failedAt: number;
  }> = [];
  const successes: Array<{ userId: string; sourceIds: string[] }> = [];
  const sink: ScheduledSourceSyncAlertSink = {
    async recordFailure(input) {
      failures.push({
        userId: input.userId,
        sourceId: input.source.id,
        provider: input.source.provider,
        message: input.message,
        failedAt: input.failedAt,
      });
    },
    async recordSuccess(input) {
      successes.push({ userId: input.userId, sourceIds: [...input.sourceIds] });
    },
  };
  return { failures, successes, sink };
}

test("a failed attempt reaches the alert sink with the card's own message", async () => {
  const recorder = alertRecorder();
  const failing: WebsiteFetcher = async () => ({
    status: 500,
    contentType: "text/html",
    contentLength: 0,
    html: "",
  });
  const { deps } = harness(
    { [USER_ID]: workspaceState([websiteStoredSource()]) },
    { fetchWebsite: failing, alerts: recorder.sink },
  );
  const worker = createVenomScheduledSourceSyncWorker(deps);

  const summary = await worker.runPass();

  assert.deepEqual(
    summary,
    passSummary({ workspaces: 1, dueWorkspaces: 1, dueSources: 1, failed: 1 }),
  );
  assert.deepEqual(recorder.failures, [
    {
      userId: USER_ID,
      sourceId: WEBSITE_SOURCE_ID,
      provider: "website",
      message: "Website returned an unexpected response (500).",
      failedAt: NOW,
    },
  ]);
  assert.deepEqual(recorder.successes, []);
});

test("an unsupported scheduled source counts toward the alert streak too", async () => {
  const recorder = alertRecorder();
  const { deps } = harness(
    {
      [USER_ID]: workspaceState([
        githubStoredSource({
          name: "Not a repository path",
          url: "https://example.com/not-github",
        }),
      ]),
    },
    { alerts: recorder.sink },
  );
  const worker = createVenomScheduledSourceSyncWorker(deps);

  const summary = await worker.runPass();

  assert.deepEqual(
    summary,
    passSummary({ workspaces: 1, dueWorkspaces: 1, dueSources: 1, failed: 1 }),
  );
  assert.equal(recorder.failures.length, 1);
  assert.equal(recorder.failures[0].provider, "github");
  assert.equal(
    recorder.failures[0].message,
    UNSUPPORTED_SCHEDULED_SOURCE_MESSAGE,
  );
});

test("a successful sync tells the sink to clear the source's alerts", async () => {
  const recorder = alertRecorder();
  const { deps } = harness(
    { [USER_ID]: workspaceState([websiteStoredSource()]) },
    { alerts: recorder.sink },
  );
  const worker = createVenomScheduledSourceSyncWorker(deps);

  const summary = await worker.runPass();

  assert.deepEqual(
    summary,
    passSummary({ workspaces: 1, dueWorkspaces: 1, dueSources: 1, synced: 1 }),
  );
  assert.deepEqual(recorder.failures, []);
  // The connect replay recomputed the same deterministic id, so the retired
  // and refreshed ids collapse into one entry.
  assert.deepEqual(recorder.successes, [
    { userId: USER_ID, sourceIds: [WEBSITE_SOURCE_ID] },
  ]);
});

test("a source removed mid-flight records no alert", async () => {
  const recorder = alertRecorder();
  const { store, deps } = harness(
    { [USER_ID]: workspaceState([websiteStoredSource()]) },
    { alerts: recorder.sink },
  );
  deps.fetchWebsite = async () => {
    // The user deletes the source on another device while the fetch runs;
    // the failure then has no card to land on, so no streak either.
    store.mutate(USER_ID, (state) => ({ ...state, sources: [] }));
    return { status: 500, contentType: "text/html", contentLength: 0, html: "" };
  };
  const worker = createVenomScheduledSourceSyncWorker(deps);

  const summary = await worker.runPass();

  assert.deepEqual(
    summary,
    passSummary({ workspaces: 1, dueWorkspaces: 1, dueSources: 1, failed: 1 }),
  );
  assert.deepEqual(recorder.failures, []);
  assert.deepEqual(recorder.successes, []);
});

test("alert sink failures are swallowed and never break the sync", async () => {
  const throwing: ScheduledSourceSyncAlertSink = {
    async recordFailure() {
      throw new Error("alerts table is having a day");
    },
    async recordSuccess() {
      throw new Error("alerts table is having a day");
    },
  };

  // Failure path: the card write still lands.
  const failing: WebsiteFetcher = async () => ({
    status: 500,
    contentType: "text/html",
    contentLength: 0,
    html: "",
  });
  const failure = harness(
    { [USER_ID]: workspaceState([websiteStoredSource()]) },
    { fetchWebsite: failing, alerts: throwing },
  );
  const failedSummary = await createVenomScheduledSourceSyncWorker(
    failure.deps,
  ).runPass();
  assert.deepEqual(
    failedSummary,
    passSummary({ workspaces: 1, dueWorkspaces: 1, dueSources: 1, failed: 1 }),
  );
  const [failedSource] = storedSources(failure.store, USER_ID);
  assert.equal(
    failedSource.schedule?.lastError,
    "Website returned an unexpected response (500).",
  );
  assert.ok(
    failure.logs.some(
      (entry) =>
        entry.level === "warn" &&
        entry.message ===
          "scheduled source sync could not record the failure alert",
    ),
  );

  // Success path: the refresh still lands.
  const success = harness(
    { [USER_ID]: workspaceState([websiteStoredSource()]) },
    { alerts: throwing },
  );
  const syncedSummary = await createVenomScheduledSourceSyncWorker(
    success.deps,
  ).runPass();
  assert.deepEqual(
    syncedSummary,
    passSummary({ workspaces: 1, dueWorkspaces: 1, dueSources: 1, synced: 1 }),
  );
  assert.ok(
    success.logs.some(
      (entry) =>
        entry.level === "warn" &&
        entry.message ===
          "scheduled source sync could not clear the source sync alerts",
    ),
  );
});
