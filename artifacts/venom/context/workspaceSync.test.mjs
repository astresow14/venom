import assert from "node:assert/strict";
import test from "node:test";

import {
  createEmptyTombstones,
  flushWorkspaceState,
  mergeWorkspaceStates,
  resolveSuccessfulWorkspaceHydration,
} from "./workspaceSync.ts";

function project(id, updatedAt) {
  return {
    id,
    name: id,
    description: `${id} description`,
    accent: "#000000",
    sourceCount: 0,
    updatedAt,
    boardStages: [
      {
        id: `${id}-stage`,
        name: "To Do",
        position: 0,
        isDone: false,
        updatedAt,
      },
    ],
    fieldDefinitions: [],
    tasks: [],
  };
}

function message(id, createdAt) {
  return {
    id,
    role: "user",
    content: `${id} content`,
    createdAt,
    status: "sent",
  };
}

function conversation(id, projectId, updatedAt, messages = []) {
  return {
    id,
    title: id,
    projectId,
    updatedAt,
    messages,
  };
}

function cluster(id, projectId, lastUpdatedAt) {
  return {
    id,
    projectId,
    label: id,
    category: "topic",
    strength: 0.8,
    x: 0,
    y: 0,
    links: [],
    description: `${id} description`,
    summary: `${id} summary`,
    mentionCount: 1,
    lastUpdatedAt,
    sources: [],
  };
}

function state({
  projects,
  conversations,
  clusters,
  sources = [],
  activeProjectId,
  activeConversationId,
}) {
  return {
    projects,
    conversations,
    clusters,
    sources,
    activeProjectId,
    activeConversationId,
    tombstones: createEmptyTombstones(),
  };
}

test("merges both devices after they edit the same account revision", () => {
  const cloudState = state({
    projects: [project("shared", 10), project("cloud-project", 20)],
    conversations: [
      conversation("shared-chat", "shared", 20, [message("cloud-message", 20)]),
      conversation("cloud-chat", "cloud-project", 20),
    ],
    clusters: [cluster("cloud-cluster", "cloud-project", 20)],
    activeProjectId: "cloud-project",
    activeConversationId: "cloud-chat",
  });
  const deviceState = state({
    projects: [project("shared", 10), project("device-project", 30)],
    conversations: [
      conversation("shared-chat", "shared", 30, [
        message("device-message", 30),
      ]),
      conversation("device-chat", "device-project", 30),
    ],
    clusters: [cluster("device-cluster", "device-project", 30)],
    activeProjectId: "device-project",
    activeConversationId: "device-chat",
  });

  const merged = mergeWorkspaceStates(cloudState, deviceState);

  assert.deepEqual(
    merged.projects.map((item) => item.id).sort(),
    ["cloud-project", "device-project", "shared"],
  );
  assert.deepEqual(
    merged.conversations.map((item) => item.id).sort(),
    ["cloud-chat", "device-chat", "shared-chat"],
  );
  assert.deepEqual(
    merged.conversations
      .find((item) => item.id === "shared-chat")
      ?.messages.map((item) => item.id),
    ["cloud-message", "device-message"],
  );
  assert.deepEqual(
    merged.clusters.map((item) => item.id).sort(),
    ["cloud-cluster", "device-cluster"],
  );
  assert.equal(merged.activeProjectId, "device-project");
  assert.equal(merged.activeConversationId, "device-chat");
});

test("source tombstones prevent stale connected sources returning", () => {
  const connectedSource = {
    id: "source-example",
    projectId: "shared",
    provider: "website",
    name: "Example",
    url: "https://example.com",
    status: "connected",
    syncedAt: new Date(1_000).toISOString(),
    summary: "Example source",
    context: "[source:example] Example source",
    citations: [],
    clusters: [],
  };
  const cloudState = state({
    projects: [project("shared", 10)],
    conversations: [],
    clusters: [],
    sources: [connectedSource],
    activeProjectId: "shared",
    activeConversationId: null,
  });
  const deviceState = state({
    projects: [project("shared", 10)],
    conversations: [],
    clusters: [],
    activeProjectId: "shared",
    activeConversationId: null,
  });
  deviceState.tombstones.sources = [
    { id: connectedSource.id, deletedAt: 2_000 },
  ];

  const merged = mergeWorkspaceStates(cloudState, deviceState);

  assert.deepEqual(merged.sources, []);
  assert.deepEqual(merged.tombstones.sources, [
    { id: connectedSource.id, deletedAt: 2_000 },
  ]);
});

test("rejects a delayed account save before requesting with a new session", async () => {
  const accountAController = {
    userId: "account-a",
    inFlight: true,
    queued: null,
  };
  let activeController = accountAController;
  let activeUserId = "account-a";
  let releaseToken;
  const delayedToken = new Promise((resolve) => {
    releaseToken = resolve;
  });
  const saveCalls = [];
  let revision = 1;
  const delayedSave = flushWorkspaceState({
    nextState: state({
      projects: [project("account-a-project", 10)],
      conversations: [],
      clusters: [],
      activeProjectId: "account-a-project",
      activeConversationId: null,
    }),
    syncUserId: "account-a",
    controller: accountAController,
    getCurrentController: () => activeController,
    getActiveUserId: () => activeUserId,
    getLatestState: () => accountAController.queued,
    getRevision: () => revision,
    setRevision: (nextRevision) => {
      revision = nextRevision;
    },
    getToken: async () => delayedToken,
    saveState: async (...args) => {
      saveCalls.push(args);
      return { state: args[0], revision: 2, updatedAt: "saved" };
    },
    classifyFailure: () => ({ kind: "other" }),
    onSyncing: () => {},
    onSaved: async () => {},
    onConflictMerged: () => {},
    onTooLarge: () => {},
    onError: () => {},
  });

  activeController = {
    userId: "account-b",
    inFlight: false,
    queued: null,
  };
  activeUserId = "account-b";
  releaseToken();
  await delayedSave;

  assert.deepEqual(saveCalls, []);
  assert.equal(revision, 1);
});

test("ignores a delayed save response after the account changes", async () => {
  const accountAState = state({
    projects: [project("account-a-project", 10)],
    conversations: [],
    clusters: [],
    activeProjectId: "account-a-project",
    activeConversationId: null,
  });
  const accountAController = {
    userId: "account-a",
    inFlight: false,
    queued: null,
  };
  let activeController = accountAController;
  let activeUserId = "account-a";
  let revision = 1;
  let resolveSave;
  let saveStarted;
  const started = new Promise((resolve) => {
    saveStarted = resolve;
  });
  const delayedResponse = new Promise((resolve) => {
    resolveSave = resolve;
  });
  const savedCallbacks = [];

  const delayedSave = flushWorkspaceState({
    nextState: accountAState,
    syncUserId: "account-a",
    controller: accountAController,
    getCurrentController: () => activeController,
    getActiveUserId: () => activeUserId,
    getLatestState: () => accountAState,
    getRevision: () => revision,
    setRevision: (nextRevision) => {
      revision = nextRevision;
    },
    getToken: async () => "account-a-token",
    saveState: async (stateToSave, baseRevision, token) => {
      assert.equal(baseRevision, 1);
      assert.equal(token, "account-a-token");
      saveStarted();
      return delayedResponse;
    },
    classifyFailure: () => ({ kind: "other" }),
    onSyncing: () => {},
    onSaved: async (input) => {
      savedCallbacks.push(input);
    },
    onConflictMerged: () => {},
    onTooLarge: () => {},
    onError: () => {},
  });

  await started;
  activeController = {
    userId: "account-b",
    inFlight: false,
    queued: null,
  };
  activeUserId = "account-b";
  resolveSave({
    state: accountAState,
    revision: 2,
    updatedAt: "saved-for-account-a",
  });
  await delayedSave;

  assert.deepEqual(savedCallbacks, []);
  assert.equal(revision, 1);
});

test("retries a revision conflict with the merged workspace", async () => {
  const cloudState = state({
    projects: [project("cloud-project", 20)],
    conversations: [conversation("cloud-chat", "cloud-project", 20)],
    clusters: [cluster("cloud-cluster", "cloud-project", 20)],
    activeProjectId: "cloud-project",
    activeConversationId: "cloud-chat",
  });
  const deviceState = state({
    projects: [project("device-project", 30)],
    conversations: [conversation("device-chat", "device-project", 30)],
    clusters: [cluster("device-cluster", "device-project", 30)],
    activeProjectId: "device-project",
    activeConversationId: "device-chat",
  });
  const controller = {
    userId: "same-account",
    inFlight: false,
    queued: null,
  };
  let revision = 1;
  const saveCalls = [];
  const mergedStates = [];
  const conflict = new Error("conflict");
  conflict.snapshot = {
    state: cloudState,
    revision: 2,
    updatedAt: "cloud-update",
  };

  await flushWorkspaceState({
    nextState: deviceState,
    syncUserId: "same-account",
    controller,
    getCurrentController: () => controller,
    getActiveUserId: () => "same-account",
    getLatestState: () => deviceState,
    getRevision: () => revision,
    setRevision: (nextRevision) => {
      revision = nextRevision;
    },
    getToken: async () => "same-account-token",
    saveState: async (stateToSave, baseRevision, token) => {
      saveCalls.push({ state: stateToSave, baseRevision, token });
      if (saveCalls.length === 1) throw conflict;
      return {
        state: stateToSave,
        revision: 3,
        updatedAt: "merged-update",
      };
    },
    classifyFailure: (error) =>
      error === conflict
        ? { kind: "conflict", snapshot: error.snapshot }
        : { kind: "other" },
    onSyncing: () => {},
    onSaved: async () => {},
    onConflictMerged: (merged) => {
      mergedStates.push(merged);
    },
    onTooLarge: () => {},
    onError: () => {},
  });

  assert.equal(saveCalls.length, 2);
  assert.equal(saveCalls[0].baseRevision, 1);
  assert.equal(saveCalls[1].baseRevision, 2);
  assert.equal(saveCalls[1].token, "same-account-token");
  assert.deepEqual(
    saveCalls[1].state.projects.map((item) => item.id).sort(),
    ["cloud-project", "device-project"],
  );
  assert.deepEqual(
    saveCalls[1].state.conversations.map((item) => item.id).sort(),
    ["cloud-chat", "device-chat"],
  );
  assert.deepEqual(
    saveCalls[1].state.clusters.map((item) => item.id).sort(),
    ["cloud-cluster", "device-cluster"],
  );
  assert.equal(saveCalls[1].state.activeProjectId, "device-project");
  assert.equal(saveCalls[1].state.activeConversationId, "device-chat");
  assert.deepEqual(mergedStates, [saveCalls[1].state]);
  assert.equal(revision, 3);
});

test("holds unscoped legacy data until the user explicitly chooses", () => {
  const localState = state({
    projects: [project("fresh-local", 1)],
    conversations: [],
    clusters: [],
    activeProjectId: "fresh-local",
    activeConversationId: null,
  });
  const legacyState = state({
    projects: [project("legacy-private", 2)],
    conversations: [],
    clusters: [],
    activeProjectId: "legacy-private",
    activeConversationId: null,
  });
  const emptyFreshState = state({
    projects: [project("new-account", 3)],
    conversations: [],
    clusters: [],
    activeProjectId: "new-account",
    activeConversationId: null,
  });

  const hydration = resolveSuccessfulWorkspaceHydration({
    cloudState: null,
    localState,
    legacyState,
    hasScopedState: false,
    createFreshState: () => emptyFreshState,
  });
  const uploads = [];
  if (hydration.shouldUpload) uploads.push(hydration.state);

  assert.equal(hydration.pendingLegacyImport, true);
  assert.equal(hydration.syncStatus, "pending");
  assert.equal(hydration.state, emptyFreshState);
  assert.notEqual(hydration.state, legacyState);
  assert.deepEqual(uploads, []);
});

test("restores the complete cloud workspace on a fresh device", () => {
  const cloudState = state({
    projects: [project("restored-project", 100)],
    conversations: [
      conversation("restored-chat", "restored-project", 100, [
        message("restored-message", 100),
      ]),
    ],
    clusters: [cluster("restored-cluster", "restored-project", 100)],
    activeProjectId: "restored-project",
    activeConversationId: "restored-chat",
  });
  const blankLocalState = state({
    projects: [],
    conversations: [],
    clusters: [],
    activeProjectId: null,
    activeConversationId: null,
  });

  const hydration = resolveSuccessfulWorkspaceHydration({
    cloudState,
    localState: blankLocalState,
    legacyState: null,
    hasScopedState: false,
    createFreshState: () => blankLocalState,
  });

  assert.equal(hydration.syncStatus, "synced");
  assert.equal(hydration.shouldUpload, false);
  assert.equal(hydration.pendingLegacyImport, false);
  assert.deepEqual(
    hydration.state.projects.map((item) => item.id),
    ["restored-project"],
  );
  assert.deepEqual(
    hydration.state.conversations.map((item) => item.id),
    ["restored-chat"],
  );
  assert.deepEqual(
    hydration.state.clusters.map((item) => item.id),
    ["restored-cluster"],
  );
  assert.equal(hydration.state.activeProjectId, "restored-project");
  assert.equal(hydration.state.activeConversationId, "restored-chat");
});

test("cloud hydration keeps local source deletion without mixing local projects", () => {
  const connectedSource = {
    id: "source-example",
    projectId: "restored-project",
    provider: "website",
    name: "Example",
    url: "https://example.com",
    status: "connected",
    syncedAt: new Date(1_000).toISOString(),
    summary: "Example source",
    context: "[source:example] Example source",
    citations: [],
    clusters: [],
  };
  const cloudState = state({
    projects: [project("restored-project", 100)],
    conversations: [],
    clusters: [],
    sources: [connectedSource],
    activeProjectId: "restored-project",
    activeConversationId: null,
  });
  const localState = state({
    projects: [project("stale-local-project", 200)],
    conversations: [],
    clusters: [],
    activeProjectId: "stale-local-project",
    activeConversationId: null,
  });
  localState.tombstones.sources = [
    { id: connectedSource.id, deletedAt: 2_000 },
  ];

  const hydration = resolveSuccessfulWorkspaceHydration({
    cloudState,
    localState,
    legacyState: null,
    hasScopedState: true,
    createFreshState: () => localState,
  });

  assert.deepEqual(
    hydration.state.projects.map((item) => item.id),
    ["restored-project"],
  );
  assert.deepEqual(hydration.state.sources, []);
  assert.deepEqual(hydration.state.tombstones.sources, [
    { id: connectedSource.id, deletedAt: 2_000 },
  ]);
  assert.equal(hydration.shouldUpload, true);
  assert.equal(hydration.syncStatus, "syncing");
});