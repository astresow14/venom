import assert from "node:assert/strict";
import test from "node:test";

import {
  ALL_VOICE_TALKATIVENESS_LEVELS,
  ARCHIVED_CITATION_LIMIT,
  createEmptyTombstones,
  DEFAULT_VOICE_PRESET_ID,
  DEFAULT_VOICE_TALKATIVENESS,
  dropRestoredArchivedCitations,
  dropUncitedArchivedCitations,
  flushWorkspaceState,
  mergeArchivedCitations,
  mergeVoicePreferences,
  mergeWorkspaceStates,
  normalizeModelPreferences,
  normalizeVoicePreferences,
  normalizeWorkspaceState,
  parseSyncedProjectIds,
  resolveSuccessfulWorkspaceHydration,
  workspaceProjectIds,
} from "./workspaceSync.ts";
import {
  citedCitationIds,
  messageCitationSegments,
  remapConversationCitations,
  restoredCitationRemap,
} from "./messageCitations.ts";

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

test("a refresh-retired source cannot return from a device with a fast clock", () => {
  const retiredSource = {
    id: "source-example",
    projectId: "shared",
    provider: "website",
    name: "Example",
    url: "https://example.com",
    status: "connected",
    // The other device's clock runs ahead of the one that ran the refresh.
    syncedAt: new Date(9_000).toISOString(),
    summary: "Example source",
    context: "[source:example] Example source",
    citations: [],
    clusters: [],
  };
  const cloudState = state({
    projects: [project("shared", 10)],
    conversations: [],
    clusters: [],
    sources: [retiredSource],
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
  // The refresh happened before the stale snapshot claims to have synced.
  deviceState.tombstones.sources = [
    { id: retiredSource.id, deletedAt: 2_000, replaced: true },
  ];

  const merged = mergeWorkspaceStates(cloudState, deviceState);
  assert.deepEqual(merged.sources, []);
  assert.deepEqual(merged.tombstones.sources, [
    { id: retiredSource.id, deletedAt: 2_000, replaced: true },
  ]);

  const hydration = resolveSuccessfulWorkspaceHydration({
    cloudState,
    localState: deviceState,
    legacyState: null,
    hasScopedState: true,
    createFreshState: () => deviceState,
  });
  assert.deepEqual(hydration.state.sources, []);
  assert.deepEqual(hydration.state.tombstones.sources, [
    { id: retiredSource.id, deletedAt: 2_000, replaced: true },
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

// ---- modelPreferences normalization ----

test("normalizeModelPreferences returns defaults for undefined input", () => {
  const prefs = normalizeModelPreferences(undefined);
  assert.deepEqual(prefs.enabledModelIds, ["venom-gpt"]);
  assert.equal(prefs.defaultModelId, "venom-gpt");
  assert.equal(prefs.activeModelId, "venom-gpt");
  assert.equal(prefs.updatedAt, 0);
});

test("normalizeModelPreferences rejects unknown model ids in enabledModelIds", () => {
  const prefs = normalizeModelPreferences({
    enabledModelIds: ["unknown-model", "venom-claude"],
    defaultModelId: "venom-claude",
    activeModelId: "venom-claude",
    updatedAt: 100,
  });
  assert.deepEqual(prefs.enabledModelIds, ["venom-claude"]);
  assert.equal(prefs.defaultModelId, "venom-claude");
  assert.equal(prefs.activeModelId, "venom-claude");
});

test("normalizeModelPreferences ensures at least one enabled model when all invalid", () => {
  const prefs = normalizeModelPreferences({
    enabledModelIds: ["bad-model"],
    defaultModelId: "bad-model",
    activeModelId: "bad-model",
    updatedAt: 0,
  });
  assert.equal(prefs.enabledModelIds.length, 1);
  assert.equal(prefs.enabledModelIds[0], "venom-gpt");
  assert.equal(prefs.defaultModelId, "venom-gpt");
  assert.equal(prefs.activeModelId, "venom-gpt");
});

test("normalizeModelPreferences recovers default to first enabled when default is not in enabled list", () => {
  const prefs = normalizeModelPreferences({
    enabledModelIds: ["venom-claude", "venom-gemini"],
    defaultModelId: "venom-gpt", // not in enabled
    activeModelId: "venom-claude",
    updatedAt: 50,
  });
  assert.equal(prefs.defaultModelId, "venom-claude");
  assert.equal(prefs.activeModelId, "venom-claude");
});

test("normalizeModelPreferences recovers active to default when active is not in enabled list", () => {
  const prefs = normalizeModelPreferences({
    enabledModelIds: ["venom-gpt", "venom-claude"],
    defaultModelId: "venom-gpt",
    activeModelId: "venom-gemini", // not in enabled
    updatedAt: 75,
  });
  assert.equal(prefs.activeModelId, "venom-gpt"); // falls back to default
});

test("mergeWorkspaceStates picks higher updatedAt modelPreferences (device wins on tie)", () => {
  const cloudPrefs = {
    enabledModelIds: ["venom-gpt"],
    defaultModelId: "venom-gpt",
    activeModelId: "venom-gpt",
    updatedAt: 100,
  };
  const devicePrefs = {
    enabledModelIds: ["venom-claude"],
    defaultModelId: "venom-claude",
    activeModelId: "venom-claude",
    updatedAt: 200,
  };
  const cloudState = state({
    projects: [project("proj", 10)],
    conversations: [],
    clusters: [],
    activeProjectId: "proj",
    activeConversationId: null,
  });
  cloudState.modelPreferences = cloudPrefs;
  const deviceState = state({
    projects: [project("proj", 10)],
    conversations: [],
    clusters: [],
    activeProjectId: "proj",
    activeConversationId: null,
  });
  deviceState.modelPreferences = devicePrefs;

  const merged = mergeWorkspaceStates(cloudState, deviceState);
  assert.equal(merged.modelPreferences.activeModelId, "venom-claude");
  assert.equal(merged.modelPreferences.updatedAt, 200);
});

test("mergeWorkspaceStates cloud modelPreferences wins when cloud updatedAt is higher", () => {
  const cloudPrefs = {
    enabledModelIds: ["venom-gemini"],
    defaultModelId: "venom-gemini",
    activeModelId: "venom-gemini",
    updatedAt: 500,
  };
  const devicePrefs = {
    enabledModelIds: ["venom-gpt"],
    defaultModelId: "venom-gpt",
    activeModelId: "venom-gpt",
    updatedAt: 100,
  };
  const base = state({
    projects: [project("proj", 10)],
    conversations: [],
    clusters: [],
    activeProjectId: "proj",
    activeConversationId: null,
  });
  const cloudState = { ...base, modelPreferences: cloudPrefs };
  const deviceState = { ...base, modelPreferences: devicePrefs };

  const merged = mergeWorkspaceStates(cloudState, deviceState);
  assert.equal(merged.modelPreferences.activeModelId, "venom-gemini");
  assert.equal(merged.modelPreferences.updatedAt, 500);
});

test("mergeWorkspaceStates normalizes modelPreferences with removed model id on device", () => {
  // Simulates a legacy device state with an unknown model id
  const devicePrefs = {
    enabledModelIds: ["legacy-model"],
    defaultModelId: "legacy-model",
    activeModelId: "legacy-model",
    updatedAt: 999,
  };
  const base = state({
    projects: [project("proj", 10)],
    conversations: [],
    clusters: [],
    activeProjectId: "proj",
    activeConversationId: null,
  });
  const cloudState = { ...base };
  const deviceState = { ...base, modelPreferences: devicePrefs };

  const merged = mergeWorkspaceStates(cloudState, deviceState);
  // Should recover to defaults since all model ids are invalid
  assert.equal(merged.modelPreferences.enabledModelIds.length, 1);
  assert.equal(merged.modelPreferences.enabledModelIds[0], "venom-gpt");
});

test("cloud hydration keeps chat the device wrote but never uploaded", () => {
  const cloudState = state({
    projects: [project("restored-project", 100)],
    conversations: [
      conversation("restored-chat", "restored-project", 100, [
        message("synced-message", 100),
      ]),
    ],
    clusters: [cluster("synced-cluster", "restored-project", 100)],
    activeProjectId: "restored-project",
    activeConversationId: "restored-chat",
  });
  // What the device saved locally after its last successful cloud save: a
  // reply added to the restored chat, a whole new chat, and a new cluster.
  const localState = state({
    projects: [project("restored-project", 100)],
    conversations: [
      conversation("restored-chat", "restored-project", 200, [
        message("synced-message", 100),
        message("offline-message", 200),
      ]),
      conversation("offline-chat", "restored-project", 200, [
        message("offline-chat-message", 200),
      ]),
    ],
    clusters: [
      cluster("synced-cluster", "restored-project", 100),
      cluster("offline-cluster", "restored-project", 200),
    ],
    activeProjectId: "restored-project",
    activeConversationId: "offline-chat",
  });

  const hydration = resolveSuccessfulWorkspaceHydration({
    cloudState,
    localState,
    legacyState: null,
    hasScopedState: true,
    createFreshState: () => localState,
  });

  assert.deepEqual(
    hydration.state.conversations.map((item) => item.id).sort(),
    ["offline-chat", "restored-chat"],
  );
  assert.deepEqual(
    hydration.state.conversations
      .find((item) => item.id === "restored-chat")
      ?.messages.map((item) => item.id),
    ["synced-message", "offline-message"],
  );
  assert.deepEqual(
    hydration.state.clusters.map((item) => item.id).sort(),
    ["offline-cluster", "synced-cluster"],
  );
  assert.equal(hydration.state.activeConversationId, "offline-chat");
  // The restore now holds more than the cloud does, so it has to go back up.
  assert.equal(hydration.shouldUpload, true);
  assert.equal(hydration.syncStatus, "syncing");
});

test("cloud hydration keeps a project created while cloud saves failed", () => {
  const cloudState = state({
    projects: [project("restored-project", 100)],
    conversations: [conversation("restored-chat", "restored-project", 100, [])],
    clusters: [],
    activeProjectId: "restored-project",
    activeConversationId: "restored-chat",
  });
  // A project the device created after its last successful save, with the chat,
  // board card and cluster written inside it. None of it ever reached the
  // cloud, so only the device's own snapshot has it.
  const offlineProject = {
    ...project("offline-project", 200),
    tasks: [
      {
        id: "offline-card",
        title: "Offline card",
        stageId: "offline-project-stage",
        position: 0,
        createdAt: 200,
        updatedAt: 200,
        values: {},
      },
    ],
  };
  const localState = state({
    projects: [project("restored-project", 100), offlineProject],
    conversations: [
      conversation("restored-chat", "restored-project", 100, []),
      conversation("offline-chat", "offline-project", 200, [
        message("offline-message", 200),
      ]),
    ],
    clusters: [cluster("offline-cluster", "offline-project", 200)],
    activeProjectId: "offline-project",
    activeConversationId: "offline-chat",
  });

  const hydration = resolveSuccessfulWorkspaceHydration({
    cloudState,
    localState,
    legacyState: null,
    hasScopedState: true,
    syncedProjectIds: ["restored-project"],
    createFreshState: () => localState,
  });

  assert.deepEqual(
    hydration.state.projects.map((item) => item.id).sort(),
    ["offline-project", "restored-project"],
  );
  assert.deepEqual(
    hydration.state.projects
      .find((item) => item.id === "offline-project")
      ?.tasks.map((item) => item.id),
    ["offline-card"],
  );
  assert.deepEqual(
    hydration.state.conversations.map((item) => item.id).sort(),
    ["offline-chat", "restored-chat"],
  );
  assert.deepEqual(
    hydration.state.conversations
      .find((item) => item.id === "offline-chat")
      ?.messages.map((item) => item.id),
    ["offline-message"],
  );
  assert.deepEqual(
    hydration.state.clusters.map((item) => item.id),
    ["offline-cluster"],
  );
  assert.equal(hydration.state.activeProjectId, "offline-project");
  assert.equal(hydration.state.activeConversationId, "offline-chat");
  assert.equal(hydration.shouldUpload, true);
  // The project is still unsynced, so the baseline must not claim it yet.
  assert.deepEqual(hydration.syncedProjectIds, ["restored-project"]);
});

test("cloud hydration drops a synced project another device deleted", () => {
  const cloudState = state({
    projects: [project("restored-project", 100)],
    conversations: [conversation("restored-chat", "restored-project", 100, [])],
    clusters: [],
    activeProjectId: "restored-project",
    activeConversationId: "restored-chat",
  });
  // Both projects reached the cloud from this device, so the one the cloud no
  // longer lists is a deletion from elsewhere — even though the local copy is
  // newer than anything the cloud holds.
  const localState = state({
    projects: [
      project("restored-project", 100),
      project("removed-elsewhere", 400),
    ],
    conversations: [
      conversation("restored-chat", "restored-project", 100, []),
      conversation("removed-chat", "removed-elsewhere", 400, [
        message("removed-message", 400),
      ]),
    ],
    clusters: [cluster("removed-cluster", "removed-elsewhere", 400)],
    activeProjectId: "removed-elsewhere",
    activeConversationId: "removed-chat",
  });

  const hydration = resolveSuccessfulWorkspaceHydration({
    cloudState,
    localState,
    legacyState: null,
    hasScopedState: true,
    syncedProjectIds: ["restored-project", "removed-elsewhere"],
    createFreshState: () => localState,
  });

  assert.deepEqual(
    hydration.state.projects.map((item) => item.id),
    ["restored-project"],
  );
  assert.deepEqual(
    hydration.state.conversations.map((item) => item.id),
    ["restored-chat"],
  );
  assert.deepEqual(hydration.state.clusters, []);
  assert.equal(hydration.state.activeProjectId, "restored-project");
  assert.equal(hydration.shouldUpload, false);
  // The deleted project stays in the baseline while the device still holds it,
  // so a reload that never persisted this merge reaches the same verdict.
  assert.deepEqual(hydration.syncedProjectIds.sort(), [
    "removed-elsewhere",
    "restored-project",
  ]);
});

test("cloud hydration drops local projects when no baseline was recorded", () => {
  const cloudState = state({
    projects: [project("restored-project", 100)],
    conversations: [],
    clusters: [],
    activeProjectId: "restored-project",
    activeConversationId: null,
  });
  const localState = state({
    projects: [project("unknown-local-project", 400)],
    conversations: [
      conversation("unknown-chat", "unknown-local-project", 400, []),
    ],
    clusters: [],
    activeProjectId: "unknown-local-project",
    activeConversationId: "unknown-chat",
  });

  const hydration = resolveSuccessfulWorkspaceHydration({
    cloudState,
    localState,
    legacyState: null,
    hasScopedState: true,
    syncedProjectIds: null,
    createFreshState: () => localState,
  });

  assert.deepEqual(
    hydration.state.projects.map((item) => item.id),
    ["restored-project"],
  );
  assert.deepEqual(hydration.state.conversations, []);
  assert.deepEqual(hydration.syncedProjectIds, ["restored-project"]);
});

test("cloud hydration honours a tombstone for a project never uploaded", () => {
  const cloudState = state({
    projects: [project("restored-project", 100)],
    conversations: [],
    clusters: [],
    activeProjectId: "restored-project",
    activeConversationId: null,
  });
  cloudState.tombstones.projects = [{ id: "retired-project", deletedAt: 300 }];
  const localState = state({
    projects: [project("restored-project", 100), project("retired-project", 200)],
    conversations: [conversation("retired-chat", "retired-project", 200, [])],
    clusters: [],
    activeProjectId: "retired-project",
    activeConversationId: "retired-chat",
  });

  const hydration = resolveSuccessfulWorkspaceHydration({
    cloudState,
    localState,
    legacyState: null,
    hasScopedState: true,
    syncedProjectIds: ["restored-project"],
    createFreshState: () => localState,
  });

  assert.deepEqual(
    hydration.state.projects.map((item) => item.id),
    ["restored-project"],
  );
  assert.deepEqual(hydration.state.conversations, []);
});

test("the save that recovers an offline project records it in the baseline", async () => {
  // A project created while saves were failing, with the chat, board card and
  // cluster written inside it. None of it has ever reached the cloud.
  const offlineProject = {
    ...project("offline-project", 200),
    tasks: [
      {
        id: "offline-card",
        title: "Offline card",
        stageId: "offline-project-stage",
        position: 0,
        createdAt: 200,
        updatedAt: 200,
        values: {},
      },
    ],
  };
  const deviceState = state({
    projects: [project("restored-project", 100), offlineProject],
    conversations: [
      conversation("offline-chat", "offline-project", 200, [
        message("offline-message", 200),
      ]),
    ],
    clusters: [cluster("offline-cluster", "offline-project", 200)],
    activeProjectId: "offline-project",
    activeConversationId: "offline-chat",
  });
  const controller = {
    userId: "same-account",
    inFlight: false,
    queued: null,
    retryAttempt: 0,
    retryTimer: null,
  };
  let revision = 1;
  let cloudIsDown = true;
  const recordedBaselines = [];
  const sharedOptions = {
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
    saveState: async (stateToSave, baseRevision) => {
      if (cloudIsDown) throw new Error("cloud unavailable");
      return {
        state: stateToSave,
        revision: baseRevision + 1,
        updatedAt: "recovered-update",
      };
    },
    classifyFailure: () => ({ kind: "other" }),
    onSyncing: () => {},
    // Mirrors what the device persists after a save: the projects the cloud is
    // now known to hold.
    onSaved: async ({ state: savedState }) => {
      recordedBaselines.push(workspaceProjectIds(savedState));
    },
    onConflictMerged: () => {},
    onTooLarge: () => {},
    onError: () => {},
  };

  await flushWorkspaceState({ ...sharedOptions, nextState: deviceState });

  // A failed save uploaded nothing, so it must not claim the project is backed
  // up; the work is retained for the retry instead.
  assert.deepEqual(recordedBaselines, []);
  assert.deepEqual(controller.queued, deviceState);

  cloudIsDown = false;
  const retried = controller.queued;
  controller.queued = null;
  await flushWorkspaceState({ ...sharedOptions, nextState: retried });

  // The recovery upload landed, so the baseline now covers the offline project.
  assert.deepEqual(recordedBaselines, [
    ["restored-project", "offline-project"],
  ]);

  // Which is what makes a later deletion from another device stick: the cloud
  // dropping the project no longer looks like work this device never uploaded.
  const cloudAfterDeletion = state({
    projects: [project("restored-project", 100)],
    conversations: [],
    clusters: [],
    activeProjectId: "restored-project",
    activeConversationId: null,
  });
  const hydration = resolveSuccessfulWorkspaceHydration({
    cloudState: cloudAfterDeletion,
    localState: deviceState,
    legacyState: null,
    hasScopedState: true,
    syncedProjectIds: recordedBaselines[0],
    createFreshState: () => deviceState,
  });

  assert.deepEqual(
    hydration.state.projects.map((item) => item.id),
    ["restored-project"],
  );
  assert.deepEqual(hydration.state.conversations, []);
  assert.deepEqual(hydration.state.clusters, []);
});

test("the save that recovers a deletion drops the project from the baseline", async () => {
  // Both projects reached the cloud from this device, so the baseline the first
  // save records lists them both.
  const syncedState = state({
    projects: [project("kept-project", 100), project("doomed-project", 100)],
    conversations: [
      conversation("kept-chat", "kept-project", 100, [message("kept", 100)]),
      conversation("doomed-chat", "doomed-project", 100, [
        message("doomed", 100),
      ]),
    ],
    clusters: [cluster("doomed-cluster", "doomed-project", 100)],
    activeProjectId: "doomed-project",
    activeConversationId: "doomed-chat",
  });
  // Then the project is deleted while saves are failing: the device drops it
  // and records the tombstone, but nothing has told the cloud yet.
  const deletedAt = 300;
  const deletedState = state({
    projects: [project("kept-project", 100)],
    conversations: [
      conversation("kept-chat", "kept-project", 100, [message("kept", 100)]),
    ],
    clusters: [],
    activeProjectId: "kept-project",
    activeConversationId: "kept-chat",
  });
  deletedState.tombstones.projects = [{ id: "doomed-project", deletedAt }];

  const controller = {
    userId: "same-account",
    inFlight: false,
    queued: null,
    retryAttempt: 0,
    retryTimer: null,
  };
  let revision = 1;
  let cloudIsDown = false;
  let latestState = syncedState;
  const recordedBaselines = [];
  const cloudSnapshots = [];
  const sharedOptions = {
    syncUserId: "same-account",
    controller,
    getCurrentController: () => controller,
    getActiveUserId: () => "same-account",
    getLatestState: () => latestState,
    getRevision: () => revision,
    setRevision: (nextRevision) => {
      revision = nextRevision;
    },
    getToken: async () => "same-account-token",
    saveState: async (stateToSave, baseRevision) => {
      if (cloudIsDown) throw new Error("cloud unavailable");
      cloudSnapshots.push(stateToSave);
      return {
        state: stateToSave,
        revision: baseRevision + 1,
        updatedAt: "recovered-update",
      };
    },
    classifyFailure: () => ({ kind: "other" }),
    onSyncing: () => {},
    // Mirrors what the device persists after a save: the projects the cloud is
    // now known to hold.
    onSaved: async ({ state: savedState }) => {
      recordedBaselines.push(workspaceProjectIds(savedState));
    },
    onConflictMerged: () => {},
    onTooLarge: () => {},
    onError: () => {},
  };

  await flushWorkspaceState({ ...sharedOptions, nextState: syncedState });
  assert.deepEqual(recordedBaselines, [["kept-project", "doomed-project"]]);

  // The deletion happens while the cloud is refusing saves, so it is retained
  // for the retry rather than recorded as backed up.
  cloudIsDown = true;
  latestState = deletedState;
  await flushWorkspaceState({ ...sharedOptions, nextState: deletedState });
  assert.equal(recordedBaselines.length, 1);

  cloudIsDown = false;
  const retried = controller.queued;
  controller.queued = null;
  await flushWorkspaceState({ ...sharedOptions, nextState: retried });

  // The recovery upload carried the deletion, so the baseline must forget the
  // project it removed instead of still claiming the cloud holds it.
  assert.deepEqual(recordedBaselines[1], ["kept-project"]);
  assert.deepEqual(
    cloudSnapshots.at(-1).projects.map((item) => item.id),
    ["kept-project"],
  );

  // A reload afterwards reads the cloud snapshot the recovery left behind. Even
  // a stale device snapshot that still holds the project — one written before
  // the deletion — must not merge it back.
  const hydration = resolveSuccessfulWorkspaceHydration({
    cloudState: cloudSnapshots.at(-1),
    localState: syncedState,
    legacyState: null,
    hasScopedState: true,
    syncedProjectIds: recordedBaselines[1],
    createFreshState: () => deletedState,
  });

  assert.deepEqual(
    hydration.state.projects.map((item) => item.id),
    ["kept-project"],
  );
  assert.deepEqual(
    hydration.state.conversations.map((item) => item.id),
    ["kept-chat"],
  );
  assert.deepEqual(hydration.state.clusters, []);
  assert.deepEqual(hydration.syncedProjectIds, ["kept-project"]);
});

test("workspaceProjectIds and parseSyncedProjectIds round-trip a baseline", () => {
  const saved = state({
    projects: [project("alpha", 1), project("beta", 2)],
    conversations: [],
    clusters: [],
    activeProjectId: "alpha",
    activeConversationId: null,
  });

  const baseline = workspaceProjectIds(saved);
  assert.deepEqual(baseline, ["alpha", "beta"]);
  assert.deepEqual(
    parseSyncedProjectIds(JSON.parse(JSON.stringify(baseline))),
    ["alpha", "beta"],
  );
  // Anything that is not a list of ids means "no baseline recorded", which
  // falls back to the stricter cloud-only scoping.
  assert.equal(parseSyncedProjectIds(null), null);
  assert.equal(parseSyncedProjectIds({ projects: ["alpha"] }), null);
  assert.deepEqual(parseSyncedProjectIds(["alpha", "", 7, "alpha"]), ["alpha"]);
});

test("cloud hydration will not resurrect chat another device deleted", () => {
  const cloudState = state({
    projects: [project("restored-project", 100)],
    conversations: [
      conversation("kept-chat", "restored-project", 100, [
        message("kept-message", 100),
      ]),
    ],
    clusters: [],
    activeProjectId: "restored-project",
    activeConversationId: "kept-chat",
  });
  cloudState.tombstones.conversations = [
    { id: "deleted-chat", deletedAt: 300 },
  ];
  cloudState.tombstones.messages = [{ id: "deleted-message", deletedAt: 300 }];
  cloudState.tombstones.clusters = [{ id: "deleted-cluster", deletedAt: 300 }];
  // A local snapshot from before the other device's deletions, still holding
  // the deleted chat, a deleted reply, a deleted cluster, and a project the
  // cloud has never heard of.
  const localState = state({
    projects: [
      project("restored-project", 100),
      project("stale-local-project", 200),
    ],
    conversations: [
      conversation("kept-chat", "restored-project", 200, [
        message("kept-message", 100),
        message("deleted-message", 200),
      ]),
      conversation("deleted-chat", "restored-project", 200, [
        message("orphan-message", 200),
      ]),
      conversation("stale-local-chat", "stale-local-project", 200, []),
    ],
    clusters: [cluster("deleted-cluster", "restored-project", 200)],
    activeProjectId: "stale-local-project",
    activeConversationId: "deleted-chat",
  });

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
  assert.deepEqual(
    hydration.state.conversations.map((item) => item.id),
    ["kept-chat"],
  );
  assert.deepEqual(
    hydration.state.conversations[0].messages.map((item) => item.id),
    ["kept-message"],
  );
  assert.deepEqual(hydration.state.clusters, []);
  assert.equal(hydration.state.activeProjectId, "restored-project");
  assert.equal(hydration.state.activeConversationId, "kept-chat");
});

test("cloud hydration ignores the starter content a fresh device seeded", () => {
  const cloudState = state({
    projects: [project("restored-project", 100)],
    conversations: [conversation("restored-chat", "restored-project", 100, [])],
    clusters: [],
    activeProjectId: "restored-project",
    activeConversationId: "restored-chat",
  });
  const seededState = state({
    projects: [project("proj_default", 500)],
    conversations: [conversation("conv_default", "proj_default", 500, [])],
    clusters: [cluster("seed-cluster", "proj_default", 500)],
    activeProjectId: "proj_default",
    activeConversationId: "conv_default",
  });

  const hydration = resolveSuccessfulWorkspaceHydration({
    cloudState,
    localState: seededState,
    legacyState: null,
    hasScopedState: false,
    createFreshState: () => seededState,
  });

  assert.deepEqual(
    hydration.state.projects.map((item) => item.id),
    ["restored-project"],
  );
  assert.deepEqual(
    hydration.state.conversations.map((item) => item.id),
    ["restored-chat"],
  );
  assert.deepEqual(hydration.state.clusters, []);
  assert.equal(hydration.shouldUpload, false);
  assert.equal(hydration.syncStatus, "synced");
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
// ---- retired citation archive ----

function archivedCitation(id, retiredAt) {
  return {
    id,
    title: `${id} title`,
    url: `https://example.com/${id}`,
    retiredAt,
  };
}

test("mergeArchivedCitations keeps the newest retirement per citation id", () => {
  const merged = mergeArchivedCitations(
    [archivedCitation("cite_a", 100), archivedCitation("cite_b", 300)],
    [{ ...archivedCitation("cite_a", 500), title: "Newer title" }],
  );

  assert.deepEqual(
    merged.map((entry) => [entry.id, entry.retiredAt, entry.title]),
    [
      ["cite_a", 500, "Newer title"],
      ["cite_b", 300, "cite_b title"],
    ],
  );
});

test("mergeArchivedCitations bounds the archive, evicting the oldest entries", () => {
  const overflowing = Array.from(
    { length: ARCHIVED_CITATION_LIMIT + 25 },
    (_, index) => archivedCitation(`cite_${index}`, index),
  );

  const merged = mergeArchivedCitations(overflowing);

  assert.equal(merged.length, ARCHIVED_CITATION_LIMIT);
  assert.equal(merged[0].retiredAt, ARCHIVED_CITATION_LIMIT + 24);
  assert.equal(merged[merged.length - 1].retiredAt, 25);
});

test("mergeArchivedCitations drops malformed entries from older payloads", () => {
  const merged = mergeArchivedCitations([
    archivedCitation("cite_ok", 10),
    { id: "cite_untitled", title: "", url: "https://example.com", retiredAt: 5 },
    { id: "", title: "No id", url: "https://example.com", retiredAt: 5 },
    { id: "cite_undated", title: "No date", url: "https://example.com" },
  ]);

  assert.deepEqual(
    merged.map((entry) => entry.id),
    ["cite_ok"],
  );
});

test("dropRestoredArchivedCitations drops entries a refresh brought back", () => {
  const archive = [
    archivedCitation("cite_back", 300),
    archivedCitation("cite_still_gone", 200),
  ];

  const pruned = dropRestoredArchivedCitations(archive, [
    { id: "cite_back", url: "https://example.com/cite_back" },
  ]);

  assert.deepEqual(
    pruned.map((entry) => entry.id),
    ["cite_still_gone"],
  );
});

test("dropRestoredArchivedCitations drops entries restored under a new id", () => {
  const archive = [archivedCitation("cite_old_id", 300)];
  const refreshed = [
    { id: "cite_new_id", url: "HTTPS://Example.com/cite_old_id " },
  ];

  // Nothing cites the archived id any more: the refresh remapped those markers
  // onto the live citation, so the entry is dead weight.
  assert.deepEqual(dropRestoredArchivedCitations(archive, refreshed), []);

  // An answer that still points at the archived id keeps its titled reference.
  assert.deepEqual(
    dropRestoredArchivedCitations(
      archive,
      refreshed,
      (id) => id === "cite_old_id",
    ).map((entry) => entry.id),
    ["cite_old_id"],
  );
});

test("dropRestoredArchivedCitations keeps evidence the refresh does not cover", () => {
  const archive = [archivedCitation("cite_gone", 300)];

  assert.deepEqual(
    dropRestoredArchivedCitations(archive, [
      { id: "cite_other", url: "https://example.com/other" },
    ]),
    archive,
  );
  assert.deepEqual(dropRestoredArchivedCitations(undefined, []), []);
});

test("dropUncitedArchivedCitations drops evidence no answer can reference", () => {
  const archive = [
    archivedCitation("cite_orphan", 300),
    archivedCitation("cite_cited", 200),
  ];
  const remaining = [
    conversation("kept-chat", "kept-project", 40, [
      {
        id: "m1",
        role: "assistant",
        content: "Still based on [source:cite_cited].",
        createdAt: 40,
        status: "sent",
      },
    ]),
  ];
  const stillCited = citedCitationIds(remaining);

  assert.deepEqual(
    dropUncitedArchivedCitations(archive, (id) => stillCited.has(id)).map(
      (entry) => entry.id,
    ),
    ["cite_cited"],
  );
  // Deleting the last project that cited anything empties the archive.
  assert.deepEqual(
    dropUncitedArchivedCitations(archive, (id) =>
      citedCitationIds([]).has(id),
    ),
    [],
  );
});

test("a refresh that restores an item shrinks the archive and renders live", () => {
  const liveCitation = {
    id: "cite_back",
    provider: "github",
    kind: "issue",
    title: "Reopened issue",
    url: "https://github.com/acme/venom/issues/12",
    excerpt: "Drawer stays open on mobile.",
    reference: "acme/venom#12",
  };
  const archive = mergeArchivedCitations([
    {
      id: "cite_retired",
      title: "Fix the drawer",
      url: "https://github.com/acme/venom/issues/12",
      retiredAt: 1_700,
    },
    archivedCitation("cite_untouched", 900),
  ]);
  const conversations = [
    conversation("chat", "proj", 100, [
      {
        id: "m1",
        role: "assistant",
        content: "The drawer bug [source:cite_retired] is open.",
        createdAt: 100,
        status: "sent",
      },
    ]),
  ];

  const remapped = remapConversationCitations(
    conversations,
    "proj",
    restoredCitationRemap(archive, [liveCitation]),
  );
  const stillCited = citedCitationIds(remapped);
  const pruned = dropRestoredArchivedCitations(archive, [liveCitation], (id) =>
    stillCited.has(id),
  );

  assert.deepEqual(
    pruned.map((entry) => entry.id),
    ["cite_untouched"],
  );
  // The answer now renders the live citation instead of an archived reference.
  assert.deepEqual(
    messageCitationSegments(
      remapped[0].messages[0].content,
      new Map([[liveCitation.id, liveCitation]]),
      new Map(pruned.map((entry) => [entry.id, entry])),
    ),
    [
      { kind: "text", text: "The drawer bug " },
      { kind: "citation", citation: liveCitation },
      { kind: "text", text: " is open." },
    ],
  );
});

test("normalizeWorkspaceState restores an archive missing from legacy state", () => {
  const legacy = state({
    projects: [project("proj", 10)],
    conversations: [],
    clusters: [],
    activeProjectId: "proj",
    activeConversationId: null,
  });
  delete legacy.archivedCitations;

  assert.deepEqual(normalizeWorkspaceState(legacy).archivedCitations, []);
});

test("mergeWorkspaceStates round-trips archive entries answers still cite", () => {
  const base = state({
    projects: [project("proj", 10)],
    conversations: [
      conversation("chat", "proj", 50, [
        {
          id: "m1",
          role: "assistant",
          content: "Based on [source:cite_cloud] and [source:cite_device].",
          createdAt: 50,
          status: "sent",
        },
      ]),
    ],
    clusters: [],
    activeProjectId: "proj",
    activeConversationId: "chat",
  });
  const cloudState = {
    ...base,
    archivedCitations: [archivedCitation("cite_cloud", 100)],
  };
  const deviceState = {
    ...base,
    archivedCitations: [archivedCitation("cite_device", 200)],
  };

  const merged = mergeWorkspaceStates(cloudState, deviceState);

  assert.deepEqual(
    merged.archivedCitations.map((entry) => entry.id),
    ["cite_device", "cite_cloud"],
  );
});

test("a stale device cannot resurrect an entry a refresh already restored", () => {
  const liveCitation = {
    id: "cite_back",
    provider: "github",
    kind: "issue",
    title: "Reopened issue",
    url: "https://github.com/acme/venom/issues/12",
    excerpt: "Drawer stays open on mobile.",
    reference: "acme/venom#12",
  };
  const refreshedSource = {
    id: "source-refreshed",
    projectId: "proj",
    provider: "github",
    name: "acme/venom",
    url: "https://github.com/acme/venom",
    status: "connected",
    syncedAt: new Date(5_000).toISOString(),
    summary: "Repo source",
    context: "[source:cite_back] Reopened issue",
    citations: [liveCitation],
    clusters: [],
  };
  const chat = conversation("chat", "proj", 100, [
    {
      id: "m1",
      role: "assistant",
      content: "See [source:cite_back] and [source:cite_gone].",
      createdAt: 100,
      status: "sent",
    },
  ]);
  const shared = {
    projects: [project("proj", 10)],
    conversations: [chat],
    clusters: [],
    sources: [refreshedSource],
    activeProjectId: "proj",
    activeConversationId: "chat",
  };
  // The device that ran the refresh already dropped cite_back from its
  // archive; only the evidence that is still gone remains archived there.
  const cloudState = {
    ...state(shared),
    archivedCitations: [archivedCitation("cite_gone", 900)],
  };
  // This device synced before the refresh restored the item, so its archive
  // still holds the stale entry and would re-upload it on the next merge.
  const staleDevice = {
    ...state(shared),
    archivedCitations: [
      archivedCitation("cite_back", 800),
      archivedCitation("cite_gone", 900),
    ],
  };

  const merged = mergeWorkspaceStates(cloudState, staleDevice);

  assert.deepEqual(
    merged.archivedCitations.map((entry) => entry.id),
    ["cite_gone"],
  );

  // Live rendering is unchanged: the restored marker resolves to the live
  // citation, and the still-gone marker keeps its archived title.
  const citationsById = new Map(
    merged.sources.flatMap((source) =>
      source.citations.map((citation) => [citation.id, citation]),
    ),
  );
  const archivedById = new Map(
    merged.archivedCitations.map((entry) => [entry.id, entry]),
  );
  assert.deepEqual(
    messageCitationSegments(
      merged.conversations[0].messages[0].content,
      citationsById,
      archivedById,
    ),
    [
      { kind: "text", text: "See " },
      { kind: "citation", citation: liveCitation },
      { kind: "text", text: " and " },
      {
        kind: "archived",
        citationId: "cite_gone",
        label: "cite_gone title (archived)",
        archived: archivedCitation("cite_gone", 900),
      },
      { kind: "text", text: "." },
    ],
  );
});

test("a merge keeps the archive pruned after a project deletion elsewhere", () => {
  const keptChat = conversation("kept-chat", "proj-keep", 40, [
    {
      id: "m-keep",
      role: "assistant",
      content: "Still based on [source:cite_kept].",
      createdAt: 40,
      status: "sent",
    },
  ]);
  // The cloud already reflects the deletion: the project, its chat, and the
  // archive entry only that chat cited are gone.
  const cloudState = {
    ...state({
      projects: [project("proj-keep", 10)],
      conversations: [keptChat],
      clusters: [],
      activeProjectId: "proj-keep",
      activeConversationId: "kept-chat",
    }),
    archivedCitations: [archivedCitation("cite_kept", 300)],
  };
  cloudState.tombstones.projects = [{ id: "proj-gone", deletedAt: 2_000 }];
  cloudState.tombstones.conversations = [{ id: "gone-chat", deletedAt: 2_000 }];

  // The stale device still holds the deleted project, its chat, and the
  // archive entry that chat alone cited.
  const staleDevice = {
    ...state({
      projects: [project("proj-keep", 10), project("proj-gone", 10)],
      conversations: [
        keptChat,
        conversation("gone-chat", "proj-gone", 100, [
          {
            id: "m-gone",
            role: "assistant",
            content: "Cited [source:cite_gone].",
            createdAt: 100,
            status: "sent",
          },
        ]),
      ],
      clusters: [],
      activeProjectId: "proj-gone",
      activeConversationId: "gone-chat",
    }),
    archivedCitations: [
      archivedCitation("cite_kept", 300),
      archivedCitation("cite_gone", 400),
    ],
  };

  const merged = mergeWorkspaceStates(cloudState, staleDevice);

  assert.deepEqual(
    merged.projects.map((item) => item.id),
    ["proj-keep"],
  );
  assert.deepEqual(
    merged.archivedCitations.map((entry) => entry.id),
    ["cite_kept"],
  );
});

test("a stale archive pile cannot regrow the merge or evict cited evidence", () => {
  const base = state({
    projects: [project("proj", 10)],
    conversations: [
      conversation("chat", "proj", 50, [
        {
          id: "m1",
          role: "assistant",
          content: "Kept because of [source:cite_needed].",
          createdAt: 50,
          status: "sent",
        },
      ]),
    ],
    clusters: [],
    activeProjectId: "proj",
    activeConversationId: "chat",
  });
  const cloudState = {
    ...base,
    // The oldest entry in the union: capping before pruning would evict it.
    archivedCitations: [archivedCitation("cite_needed", 1)],
  };
  const staleDevice = {
    ...base,
    archivedCitations: Array.from(
      { length: ARCHIVED_CITATION_LIMIT + 20 },
      (_, index) => archivedCitation(`cite_stale_${index}`, 1_000 + index),
    ),
  };

  const merged = mergeWorkspaceStates(cloudState, staleDevice);

  assert.deepEqual(
    merged.archivedCitations.map((entry) => entry.id),
    ["cite_needed"],
  );
});

// ---- voicePreferences (named voice presets) ----

test("normalizeVoicePreferences falls back to the default preset", () => {
  assert.deepEqual(normalizeVoicePreferences(undefined), {
    presetId: DEFAULT_VOICE_PRESET_ID,
    talkativeness: DEFAULT_VOICE_TALKATIVENESS,
    updatedAt: 0,
  });
  assert.deepEqual(normalizeVoicePreferences(null), {
    presetId: DEFAULT_VOICE_PRESET_ID,
    talkativeness: DEFAULT_VOICE_TALKATIVENESS,
    updatedAt: 0,
  });
  assert.deepEqual(
    normalizeVoicePreferences({ presetId: "not-a-voice", updatedAt: 50 }),
    {
      presetId: DEFAULT_VOICE_PRESET_ID,
      talkativeness: DEFAULT_VOICE_TALKATIVENESS,
      updatedAt: 50,
    },
  );
  // Provider voice ids are not preset ids and must not survive.
  assert.equal(
    normalizeVoicePreferences({ presetId: "nova", updatedAt: 1 }).presetId,
    DEFAULT_VOICE_PRESET_ID,
  );
});

test("normalizeVoicePreferences bounds updatedAt", () => {
  assert.equal(
    normalizeVoicePreferences({ presetId: "maya", updatedAt: -5 }).updatedAt,
    0,
  );
  assert.equal(
    normalizeVoicePreferences({ presetId: "maya", updatedAt: Number.NaN })
      .updatedAt,
    0,
  );
  assert.equal(
    normalizeVoicePreferences({ presetId: "maya", updatedAt: 12.9 }).updatedAt,
    12,
  );
  assert.deepEqual(
    normalizeVoicePreferences({ presetId: "maya", updatedAt: 100 }),
    {
      presetId: "maya",
      talkativeness: DEFAULT_VOICE_TALKATIVENESS,
      updatedAt: 100,
    },
  );
});

test("normalizeVoicePreferences bounds talkativeness", () => {
  // Absent or unrecognized levels land on balanced.
  assert.equal(
    normalizeVoicePreferences({ presetId: "maya", updatedAt: 1 }).talkativeness,
    DEFAULT_VOICE_TALKATIVENESS,
  );
  assert.equal(
    normalizeVoicePreferences({
      presetId: "maya",
      talkativeness: "verbose",
      updatedAt: 1,
    }).talkativeness,
    DEFAULT_VOICE_TALKATIVENESS,
  );
  assert.equal(
    normalizeVoicePreferences({
      presetId: "maya",
      talkativeness: 3,
      updatedAt: 1,
    }).talkativeness,
    DEFAULT_VOICE_TALKATIVENESS,
  );
  // Every real level survives normalization untouched.
  for (const level of ALL_VOICE_TALKATIVENESS_LEVELS) {
    assert.equal(
      normalizeVoicePreferences({
        presetId: "maya",
        talkativeness: level,
        updatedAt: 1,
      }).talkativeness,
      level,
    );
  }
});

test("mergeVoicePreferences picks the newer side, device wins ties", () => {
  const balanced = DEFAULT_VOICE_TALKATIVENESS;
  assert.deepEqual(
    mergeVoicePreferences(
      { presetId: "maya", updatedAt: 100 },
      { presetId: "rowan", updatedAt: 200 },
    ),
    { presetId: "rowan", talkativeness: balanced, updatedAt: 200 },
  );
  assert.deepEqual(
    mergeVoicePreferences(
      { presetId: "maya", updatedAt: 300 },
      { presetId: "rowan", updatedAt: 200 },
    ),
    { presetId: "maya", talkativeness: balanced, updatedAt: 300 },
  );
  assert.deepEqual(
    mergeVoicePreferences(
      { presetId: "maya", updatedAt: 200 },
      { presetId: "rowan", updatedAt: 200 },
    ),
    { presetId: "rowan", talkativeness: balanced, updatedAt: 200 },
  );
  assert.deepEqual(
    mergeVoicePreferences(undefined, { presetId: "isla", updatedAt: 10 }),
    { presetId: "isla", talkativeness: balanced, updatedAt: 10 },
  );
  assert.deepEqual(
    mergeVoicePreferences({ presetId: "elijah", updatedAt: 10 }, undefined),
    { presetId: "elijah", talkativeness: balanced, updatedAt: 10 },
  );
  assert.deepEqual(mergeVoicePreferences(undefined, undefined), {
    presetId: DEFAULT_VOICE_PRESET_ID,
    talkativeness: balanced,
    updatedAt: 0,
  });
});

test("talkativeness rides the voice-preferences merge as one object", () => {
  // Newer side wins wholesale — its talkativeness comes along.
  assert.deepEqual(
    mergeVoicePreferences(
      { presetId: "maya", talkativeness: "reserved", updatedAt: 100 },
      { presetId: "maya", talkativeness: "chatty", updatedAt: 200 },
    ),
    { presetId: "maya", talkativeness: "chatty", updatedAt: 200 },
  );
  // The older side's talkativeness never bleeds into the winner.
  assert.deepEqual(
    mergeVoicePreferences(
      { presetId: "rowan", talkativeness: "reserved", updatedAt: 300 },
      { presetId: "maya", talkativeness: "chatty", updatedAt: 200 },
    ),
    { presetId: "rowan", talkativeness: "reserved", updatedAt: 300 },
  );
});

test("voicePreferences survive a full workspace merge", () => {
  const base = state({
    projects: [project("proj", 10)],
    conversations: [],
    clusters: [],
    activeProjectId: "proj",
    activeConversationId: null,
  });
  const cloudState = {
    ...base,
    voicePreferences: { presetId: "maya", updatedAt: 100 },
  };
  const deviceState = {
    ...base,
    voicePreferences: {
      presetId: "marcus",
      talkativeness: "reserved",
      updatedAt: 250,
    },
  };

  const merged = mergeWorkspaceStates(cloudState, deviceState);
  assert.deepEqual(merged.voicePreferences, {
    presetId: "marcus",
    talkativeness: "reserved",
    updatedAt: 250,
  });
});

test("legacy states without voicePreferences normalize to the default", () => {
  const legacy = state({
    projects: [project("proj", 10)],
    conversations: [],
    clusters: [],
    activeProjectId: "proj",
    activeConversationId: null,
  });
  delete legacy.voicePreferences;

  assert.deepEqual(normalizeWorkspaceState(legacy).voicePreferences, {
    presetId: DEFAULT_VOICE_PRESET_ID,
    talkativeness: DEFAULT_VOICE_TALKATIVENESS,
    updatedAt: 0,
  });
});
