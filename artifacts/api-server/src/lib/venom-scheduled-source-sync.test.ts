import assert from "node:assert/strict";
import test from "node:test";

import {
  applyRefreshedScheduledSource,
  claimScheduledSourceAttempt,
  createVenomScheduledSourceSyncWorker,
  FAILED_SYNC_RETRY_MS,
  MAX_SYNCS_PER_PASS,
  nextDueScheduledSource,
  recordScheduledSourceSyncFailure,
  scheduledSourceRefreshRequest,
  scheduledSyncDueAt,
  UNSUPPORTED_SCHEDULED_SOURCE_MESSAGE,
  withReplacedSourceTombstone,
  workspaceSources,
  type ScheduledSourceSyncDeps,
  type StoredProjectSource,
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

type Harness = {
  store: FakeStore;
  deps: ScheduledSourceSyncDeps;
  websiteCalls: URL[];
  githubCalls: string[];
  logs: Array<{ level: string; message: string }>;
  clock: { now: number };
};

function harness(
  initial: Record<string, StoredWorkspaceState>,
  overrides: Partial<ScheduledSourceSyncDeps> = {},
): Harness {
  const store = fakeStore(initial);
  const websiteCalls: URL[] = [];
  const githubCalls: string[] = [];
  const logs: Array<{ level: string; message: string }> = [];
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

  const log = (level: string) => (_context: Record<string, unknown>, message: string) => {
    logs.push({ level, message });
  };

  const deps: ScheduledSourceSyncDeps = {
    listScheduledWorkspaceUserIds: async () => [...store.rows.keys()],
    store,
    isWorkspaceMember: (userId) => userId === USER_ID,
    githubRequest,
    resolveAddresses: async () => [{ address: "93.184.216.34" }],
    fetchWebsite,
    createAttestation: createSourceAttestation,
    log: { info: log("info"), warn: log("warn"), error: log("error") },
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

test("a due website source is re-synced with no client involved", async () => {
  const { store, deps, websiteCalls } = harness({
    [USER_ID]: workspaceState([websiteStoredSource()]),
  });
  const worker = createVenomScheduledSourceSyncWorker(deps);

  const summary = await worker.runPass();

  assert.deepEqual(summary, { workspaces: 1, synced: 1, failed: 0 });
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

test("a snapshot a client just refreshed is left alone", async () => {
  const { store, deps, websiteCalls } = harness({
    [USER_ID]: workspaceState([
      websiteStoredSource({ syncedAt: new Date(NOW - 60_000).toISOString() }),
    ]),
  });
  const worker = createVenomScheduledSourceSyncWorker(deps);

  const summary = await worker.runPass();

  assert.deepEqual(summary, { workspaces: 1, synced: 0, failed: 0 });
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
  assert.deepEqual(summary, { workspaces: 1, synced: 0, failed: 1 });

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
  assert.deepEqual(idle, { workspaces: 1, synced: 0, failed: 0 });

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
  assert.deepEqual(retried, { workspaces: 1, synced: 1, failed: 0 });
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

  assert.deepEqual(summary, { workspaces: 1, synced: 0, failed: 0 });
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

  assert.deepEqual(summary, { workspaces: 1, synced: 0, failed: 0 });
  assert.deepEqual(storedSources(store, USER_ID), []);
});

test("a due GitHub source re-syncs through the same membership gate as connect", async () => {
  const { store, deps, githubCalls } = harness({
    [USER_ID]: workspaceState([githubStoredSource()]),
  });
  const worker = createVenomScheduledSourceSyncWorker(deps);

  const summary = await worker.runPass();

  assert.deepEqual(summary, { workspaces: 1, synced: 1, failed: 0 });
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

  assert.deepEqual(summary, { workspaces: 1, synced: 0, failed: 1 });
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

  assert.deepEqual(summary, { workspaces: 1, synced: 0, failed: 1 });
  assert.equal(websiteCalls.length, 0);
  const [failed] = storedSources(store, USER_ID);
  assert.equal(failed.schedule?.lastError, UNSUPPORTED_SCHEDULED_SOURCE_MESSAGE);
});

test("one pass caps how many workspaces it syncs", async () => {
  const initial: Record<string, StoredWorkspaceState> = {};
  for (let index = 0; index < MAX_SYNCS_PER_PASS + 1; index += 1) {
    initial[`user_capCheck${index}`] = workspaceState([websiteStoredSource()]);
  }
  const { deps, websiteCalls } = harness(initial);
  const worker = createVenomScheduledSourceSyncWorker(deps);

  const summary = await worker.runPass();

  assert.equal(summary.synced, MAX_SYNCS_PER_PASS);
  assert.equal(websiteCalls.length, MAX_SYNCS_PER_PASS);

  // The next pass picks up the workspace the cap deferred.
  const second = await worker.runPass();
  assert.equal(second.synced, 1);
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

  assert.deepEqual(summary, { workspaces: 2, synced: 1, failed: 1 });
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
