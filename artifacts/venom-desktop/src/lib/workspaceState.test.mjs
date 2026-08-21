import assert from 'node:assert/strict';
import test from 'node:test';

import { SaveVenomWorkspaceBody } from '../../../../lib/api-zod/src/generated/api.ts';
import { validateVenomBoardState } from '../../../api-server/src/routes/venom-board-validation.ts';
import { messageCitationSegments } from './messageCitations.ts';
import {
  ARCHIVED_CITATION_LIMIT,
  availableTaskStatuses,
  createDefaultState,
  createDefaultModelPreferences,
  createDefaultVoicePreferences,
  mergeModelPreferences,
  mergeVoicePreferences,
  mergeWorkspaceStates,
  normalizeModelPreferences,
  normalizeVoicePreferences,
  normalizeWorkspaceState,
  prepareWorkspaceStateForSave,
  stageIdForTaskStatus,
} from './workspaceState.ts';

test('loads a legacy desktop workspace and produces a current save payload', () => {
  const legacyState = {
    projects: [
      {
        id: 'legacy-project',
        name: 'Legacy project',
        description: '',
        accent: '#000000',
        sourceCount: 0,
        updatedAt: 100,
        tasks: [
          {
            id: 'todo-task',
            title: 'Waiting',
            status: 'todo',
            createdAt: 10,
          },
          {
            id: 'active-task',
            title: 'Working',
            status: 'in_progress',
            createdAt: 20,
          },
          {
            id: 'done-task',
            title: 'Shipped',
            status: 'done',
            createdAt: 30,
          },
        ],
      },
    ],
    conversations: [],
    clusters: [],
    activeProjectId: 'legacy-project',
    activeConversationId: null,
    tombstones: {
      projects: [],
      tasks: [],
      conversations: [],
      messages: [],
      clusters: [],
    },
  };

  const normalized = normalizeWorkspaceState(legacyState);
  const project = normalized.projects[0];

  assert.deepEqual(
    project.boardStages.map((stage) => [stage.name, stage.isDone]),
    [
      ['To Do', false],
      ['Active', false],
      ['Done', true],
    ],
  );
  assert.deepEqual(
    project.tasks.map((task) => task.stageId),
    project.boardStages.map((stage) => stage.id),
  );
  assert.ok(
    project.tasks.every(
      (task) =>
        Number.isInteger(task.position) &&
        Number.isInteger(task.updatedAt) &&
        task.values &&
        Object.keys(task.values).length === 0,
    ),
  );
  assert.deepEqual(project.fieldDefinitions, []);
  assert.deepEqual(normalized.tombstones.stages, []);
  assert.deepEqual(normalized.tombstones.fields, []);

  const savePayload = JSON.parse(
    JSON.stringify({ state: normalized, baseRevision: 4 }),
  );
  assert.equal(SaveVenomWorkspaceBody.safeParse(savePayload).success, true);
  assert.deepEqual(validateVenomBoardState(savePayload.state), []);
});

test('normalization resolves board invariants enforced by the API', () => {
  const normalized = normalizeWorkspaceState({
    projects: [
      {
        id: 'invalid-board',
        name: 'Invalid board',
        description: '',
        accent: '#000000',
        sourceCount: 0,
        updatedAt: 100,
        boardStages: [
          {
            id: 'todo-a',
            name: 'To Do',
            position: 8,
            isDone: false,
            updatedAt: 100,
          },
          {
            id: 'todo-b',
            name: ' to do ',
            position: 8,
            isDone: false,
            updatedAt: 100,
          },
          {
            id: 'done',
            name: 'Done',
            position: 8,
            isDone: true,
            updatedAt: 100,
          },
        ],
        fieldDefinitions: [
          {
            id: 'empty-select',
            name: 'Priority',
            type: 'single_select',
            options: [],
            position: 4,
            showOnCard: true,
            updatedAt: 100,
          },
        ],
        tasks: [
          {
            id: 'first',
            title: 'First',
            stageId: 'todo-a',
            position: 5,
            createdAt: 10,
            updatedAt: 10,
            values: {},
          },
          {
            id: 'second',
            title: 'Second',
            stageId: 'todo-a',
            position: 5,
            createdAt: 20,
            updatedAt: 20,
            values: {},
          },
        ],
      },
    ],
    conversations: [],
    clusters: [],
    activeProjectId: 'invalid-board',
    activeConversationId: null,
    tombstones: {
      projects: [],
      tasks: [],
      conversations: [],
      messages: [],
      clusters: [],
      stages: [],
      fields: [],
    },
  });

  assert.deepEqual(validateVenomBoardState(normalized), []);
  assert.deepEqual(
    normalized.projects[0].tasks.map((task) => task.position),
    [0, 1],
  );
  assert.deepEqual(normalized.projects[0].fieldDefinitions, []);
  assert.equal(normalized.projects[0].boardStages.length, 2);
});

test('workspace merges preserve task, stage, and field tombstones', () => {
  const cloud = normalizeWorkspaceState({
    projects: [
      {
        id: 'merge-board',
        name: 'Merge board',
        description: '',
        accent: '#000000',
        sourceCount: 0,
        updatedAt: 100,
        boardStages: [
          {
            id: 'todo',
            name: 'To Do',
            position: 0,
            isDone: false,
            updatedAt: 100,
          },
          {
            id: 'active',
            name: 'Active',
            position: 1,
            isDone: false,
            updatedAt: 100,
          },
          {
            id: 'done',
            name: 'Done',
            position: 2,
            isDone: true,
            updatedAt: 100,
          },
        ],
        fieldDefinitions: [
          {
            id: 'priority',
            name: 'Priority',
            type: 'single_select',
            options: ['High'],
            position: 0,
            showOnCard: true,
            updatedAt: 100,
          },
        ],
        tasks: [
          {
            id: 'removed-task',
            title: 'Removed task',
            stageId: 'done',
            position: 0,
            createdAt: 10,
            updatedAt: 100,
            values: {},
          },
          {
            id: 'live-task',
            title: 'Live task',
            stageId: 'active',
            position: 0,
            createdAt: 20,
            updatedAt: 100,
            values: { priority: 'High' },
          },
        ],
      },
    ],
    conversations: [],
    clusters: [],
    activeProjectId: 'merge-board',
    activeConversationId: null,
    tombstones: {
      projects: [],
      tasks: [],
      conversations: [],
      messages: [],
      clusters: [],
      stages: [],
      fields: [],
    },
  });
  const device = {
    ...cloud,
    tombstones: {
      ...cloud.tombstones,
      tasks: [{ id: 'removed-task', deletedAt: 100 }],
      stages: [{ id: 'active', deletedAt: 100 }],
      fields: [{ id: 'priority', deletedAt: 100 }],
    },
  };

  const merged = mergeWorkspaceStates(cloud, device);
  const project = merged.projects[0];

  assert.ok(!project.tasks.some((task) => task.id === 'removed-task'));
  assert.ok(!project.boardStages.some((stage) => stage.id === 'active'));
  assert.deepEqual(project.fieldDefinitions, []);
  assert.deepEqual(project.tasks[0].values, {});
  assert.notEqual(project.tasks[0].stageId, 'active');
  assert.deepEqual(validateVenomBoardState(merged), []);
});

test('fixed desktop statuses only target stages that exist', () => {
  const project = normalizeWorkspaceState({
    projects: [
      {
        id: 'two-stage-board',
        name: 'Two stage board',
        description: '',
        accent: '#000000',
        sourceCount: 0,
        updatedAt: 100,
        boardStages: [
          {
            id: 'open',
            name: 'Open',
            position: 0,
            isDone: false,
            updatedAt: 100,
          },
          {
            id: 'closed',
            name: 'Closed',
            position: 1,
            isDone: true,
            updatedAt: 100,
          },
        ],
        fieldDefinitions: [],
        tasks: [],
      },
    ],
    conversations: [],
    clusters: [],
    activeProjectId: 'two-stage-board',
    activeConversationId: null,
    tombstones: {
      projects: [],
      tasks: [],
      conversations: [],
      messages: [],
      clusters: [],
      stages: [],
      fields: [],
    },
  }).projects[0];

  assert.deepEqual(availableTaskStatuses(project), ['todo', 'done']);
  assert.equal(stageIdForTaskStatus(project, 'todo'), 'open');
  assert.equal(stageIdForTaskStatus(project, 'in_progress'), null);
  assert.equal(stageIdForTaskStatus(project, 'done'), 'closed');

  const allDoneProject = {
    ...project,
    boardStages: project.boardStages.map((stage) => ({ ...stage, isDone: true })),
  };
  assert.deepEqual(availableTaskStatuses(allDoneProject), ['done']);
  assert.equal(stageIdForTaskStatus(allDoneProject, 'todo'), null);
});

test('oversized board collections are blocked before save without truncation', () => {
  const normalized = normalizeWorkspaceState({
    projects: [
      {
        id: 'oversized-board',
        name: 'Oversized board',
        description: '',
        accent: '#000000',
        sourceCount: 0,
        updatedAt: 100,
        tasks: [],
      },
    ],
    conversations: [],
    clusters: [],
    activeProjectId: 'oversized-board',
    activeConversationId: null,
    tombstones: {
      projects: [],
      tasks: [],
      conversations: [],
      messages: [],
      clusters: [],
    },
  });
  const oversized = {
    ...normalized,
    projects: [
      {
        ...normalized.projects[0],
        boardStages: Array.from({ length: 31 }, (_, index) => ({
          id: `stage-${index}`,
          name: `Stage ${index}`,
          position: index,
          isDone: index === 30,
          updatedAt: 100,
        })),
      },
    ],
  };

  assert.deepEqual(prepareWorkspaceStateForSave(oversized), {
    success: false,
    reason: 'board_limits',
  });
  assert.equal(oversized.projects[0].boardStages.length, 31);
});

test('connected-source tombstones survive desktop workspace merging', () => {
  const source = {
    id: 'source_example',
    projectId: 'proj_default',
    provider: 'website',
    name: 'Example',
    url: 'https://example.com',
    status: 'connected',
    syncedAt: new Date(1_000).toISOString(),
    summary: 'Example source',
    context: '[source:example] Example source',
    citations: [],
    clusters: [],
  };
  const cloud = {
    ...createDefaultState(),
    sources: [source],
  };
  const device = {
    ...createDefaultState(),
    sources: [],
    tombstones: {
      ...createDefaultState().tombstones,
      sources: [{ id: source.id, deletedAt: 2_000 }],
    },
  };

  const merged = mergeWorkspaceStates(cloud, device);

  assert.deepEqual(merged.sources, []);
  assert.deepEqual(merged.tombstones?.sources, [
    { id: source.id, deletedAt: 2_000 },
  ]);
});

test('a refresh-retired source cannot return through the desktop merge', () => {
  const source = {
    id: 'source_example',
    projectId: 'proj_default',
    provider: 'website',
    name: 'Example',
    url: 'https://example.com',
    status: 'connected',
    // Written by a device whose clock runs past the moment of the refresh.
    syncedAt: new Date(9_000).toISOString(),
    summary: 'Example source',
    context: '[source:example] Example source',
    citations: [],
    clusters: [],
  };
  const cloud = {
    ...createDefaultState(),
    sources: [source],
  };
  const device = {
    ...createDefaultState(),
    sources: [],
    tombstones: {
      ...createDefaultState().tombstones,
      sources: [{ id: source.id, deletedAt: 2_000, replaced: true }],
    },
  };

  const merged = mergeWorkspaceStates(cloud, device);

  assert.deepEqual(merged.sources, []);
  assert.deepEqual(merged.tombstones?.sources, [
    { id: source.id, deletedAt: 2_000, replaced: true },
  ]);

  // A later plain deletion of the same id must not downgrade the retirement.
  const laterRemoval = {
    ...createDefaultState(),
    sources: [],
    tombstones: {
      ...createDefaultState().tombstones,
      sources: [{ id: source.id, deletedAt: 6_000 }],
    },
  };
  const remerged = mergeWorkspaceStates(merged, laterRemoval);
  assert.deepEqual(remerged.sources, []);
  assert.deepEqual(remerged.tombstones?.sources, [
    { id: source.id, deletedAt: 6_000, replaced: true },
  ]);
});

test('a refresh-retired source stays retired once the deletion history is full', () => {
  const source = {
    id: 'source_example',
    projectId: 'proj_default',
    provider: 'website',
    name: 'Example',
    url: 'https://example.com',
    status: 'connected',
    syncedAt: new Date(9_000).toISOString(),
    summary: 'Example source',
    context: '[source:example] Example source',
    citations: [],
    clusters: [],
  };
  const cloud = {
    ...createDefaultState(),
    sources: [source],
  };
  // The 2000-entry source tombstone cap is completely filled with later plain
  // deletions; the permanent retirement must not be the entry evicted.
  const churn = Array.from({ length: 2_000 }, (_, index) => ({
    id: `source_churn_${index}`,
    deletedAt: 100_000 + index,
  }));
  const device = {
    ...createDefaultState(),
    sources: [],
    tombstones: {
      ...createDefaultState().tombstones,
      sources: [{ id: source.id, deletedAt: 2_000, replaced: true }, ...churn],
    },
  };

  const merged = mergeWorkspaceStates(cloud, device);

  assert.equal(merged.tombstones?.sources.length, 2_000);
  assert.deepEqual(
    merged.tombstones?.sources.filter((marker) => marker.replaced === true),
    [{ id: source.id, deletedAt: 2_000, replaced: true }],
  );
  assert.deepEqual(merged.sources, []);
});

// ─── Model preference tests ───────────────────────────────────────────────────

test('createDefaultModelPreferences returns a valid preferences object', () => {
  const prefs = createDefaultModelPreferences();
  assert.equal(prefs.enabledModelIds.length >= 1, true);
  assert.equal(typeof prefs.defaultModelId, 'string');
  assert.equal(typeof prefs.activeModelId, 'string');
  assert.equal(prefs.enabledModelIds.includes(prefs.defaultModelId), true);
  assert.equal(prefs.enabledModelIds.includes(prefs.activeModelId), true);
});

test('normalizeModelPreferences falls back gracefully when input is null', () => {
  const prefs = normalizeModelPreferences(null);
  assert.equal(prefs.enabledModelIds.length >= 1, true);
  assert.equal(prefs.enabledModelIds.includes(prefs.defaultModelId), true);
  assert.equal(prefs.enabledModelIds.includes(prefs.activeModelId), true);
});

test('normalizeModelPreferences strips unknown model IDs from enabledModelIds', () => {
  const prefs = normalizeModelPreferences({
    enabledModelIds: ['totally-fake-model', 'venom-gpt'],
    defaultModelId: 'venom-gpt',
    activeModelId: 'venom-gpt',
    updatedAt: 0,
  });
  assert.deepEqual(prefs.enabledModelIds, ['venom-gpt']);
  assert.equal(prefs.defaultModelId, 'venom-gpt');
  assert.equal(prefs.activeModelId, 'venom-gpt');
});

test('normalizeModelPreferences ensures activeModelId is within enabled set', () => {
  const prefs = normalizeModelPreferences({
    enabledModelIds: ['venom-gpt'],
    defaultModelId: 'venom-gpt',
    activeModelId: 'venom-claude', // not enabled
    updatedAt: 0,
  });
  assert.equal(prefs.enabledModelIds.includes(prefs.activeModelId), true);
});

test('normalizeModelPreferences falls back to first enabled when defaultModelId is not in set', () => {
  const prefs = normalizeModelPreferences({
    enabledModelIds: ['venom-gemini'],
    defaultModelId: 'venom-claude', // not in set
    activeModelId: 'venom-gemini',
    updatedAt: 0,
  });
  assert.equal(prefs.defaultModelId, 'venom-gemini');
});

test('mergeModelPreferences picks the snapshot with higher updatedAt', () => {
  const cloud = { enabledModelIds: ['venom-gpt'], defaultModelId: 'venom-gpt', activeModelId: 'venom-gpt', updatedAt: 100 };
  const device = { enabledModelIds: ['venom-claude'], defaultModelId: 'venom-claude', activeModelId: 'venom-claude', updatedAt: 200 };
  const merged = mergeModelPreferences(cloud, device);
  assert.equal(merged.defaultModelId, 'venom-claude');
});

test('mergeModelPreferences falls back to cloud when device is undefined', () => {
  const cloud = { enabledModelIds: ['venom-gemini'], defaultModelId: 'venom-gemini', activeModelId: 'venom-gemini', updatedAt: 50 };
  const merged = mergeModelPreferences(cloud, undefined);
  assert.equal(merged.defaultModelId, 'venom-gemini');
});

test('createDefaultState includes modelPreferences', () => {
  const state = createDefaultState();
  assert.ok(state.modelPreferences, 'modelPreferences should be present');
  assert.equal(state.modelPreferences.enabledModelIds.length >= 1, true);
});

test('normalizeWorkspaceState preserves and normalizes modelPreferences', () => {
  const state = createDefaultState();
  const raw = { ...state, modelPreferences: { enabledModelIds: ['venom-gpt'], defaultModelId: 'venom-gpt', activeModelId: 'venom-gpt', updatedAt: 42 } };
  const normalized = normalizeWorkspaceState(raw);
  assert.equal(normalized.modelPreferences?.defaultModelId, 'venom-gpt');
  assert.equal(normalized.modelPreferences?.updatedAt, 42);
});

test('mergeWorkspaceStates merges modelPreferences by updatedAt', () => {
  const cloud = { ...createDefaultState(), modelPreferences: { enabledModelIds: ['venom-gpt'], defaultModelId: 'venom-gpt', activeModelId: 'venom-gpt', updatedAt: 10 } };
  const device = { ...createDefaultState(), modelPreferences: { enabledModelIds: ['venom-claude'], defaultModelId: 'venom-claude', activeModelId: 'venom-claude', updatedAt: 20 } };
  const merged = mergeWorkspaceStates(cloud, device);
  assert.equal(merged.modelPreferences?.defaultModelId, 'venom-claude');
});
// ---- voicePreferences (named voice presets, synced from mobile) ----

test('normalizeVoicePreferences falls back to the default preset', () => {
  assert.deepEqual(normalizeVoicePreferences(undefined), createDefaultVoicePreferences());
  assert.deepEqual(
    normalizeVoicePreferences({ presetId: 'not-a-voice', updatedAt: 50 }),
    { presetId: 'sam', talkativeness: 'balanced', updatedAt: 50 },
  );
  // Provider voice ids (alloy/nova/…) are not preset ids and must not survive.
  assert.equal(
    normalizeVoicePreferences({ presetId: 'shimmer', updatedAt: 1 }).presetId,
    'sam',
  );
  assert.equal(
    normalizeVoicePreferences({ presetId: 'isla', updatedAt: -3 }).updatedAt,
    0,
  );
  assert.deepEqual(
    normalizeVoicePreferences({ presetId: 'isla', updatedAt: 42.7 }),
    { presetId: 'isla', talkativeness: 'balanced', updatedAt: 42 },
  );
});

test('normalizeVoicePreferences bounds talkativeness like mobile does', () => {
  // Legacy payloads without the field default to balanced.
  assert.equal(
    normalizeVoicePreferences({ presetId: 'maya', updatedAt: 5 }).talkativeness,
    'balanced',
  );
  // Garbage never survives.
  assert.equal(
    normalizeVoicePreferences({
      presetId: 'maya',
      talkativeness: 'extremely-chatty',
      updatedAt: 5,
    }).talkativeness,
    'balanced',
  );
  // Every real level passes through untouched.
  for (const level of ['chatty', 'balanced', 'reserved']) {
    assert.equal(
      normalizeVoicePreferences({ presetId: 'maya', talkativeness: level, updatedAt: 5 })
        .talkativeness,
      level,
    );
  }
});

test('mergeVoicePreferences picks the newer side, device wins ties', () => {
  assert.deepEqual(
    mergeVoicePreferences(
      { presetId: 'maya', updatedAt: 100 },
      { presetId: 'rowan', updatedAt: 200 },
    ),
    { presetId: 'rowan', talkativeness: 'balanced', updatedAt: 200 },
  );
  assert.deepEqual(
    mergeVoicePreferences(
      { presetId: 'maya', updatedAt: 300 },
      { presetId: 'rowan', updatedAt: 200 },
    ),
    { presetId: 'maya', talkativeness: 'balanced', updatedAt: 300 },
  );
  assert.deepEqual(
    mergeVoicePreferences(
      { presetId: 'maya', updatedAt: 200 },
      { presetId: 'rowan', updatedAt: 200 },
    ),
    { presetId: 'rowan', talkativeness: 'balanced', updatedAt: 200 },
  );
  assert.deepEqual(
    mergeVoicePreferences(undefined, undefined),
    createDefaultVoicePreferences(),
  );
  // Talkativeness rides the whole-object merge: the newer side's level wins intact.
  assert.deepEqual(
    mergeVoicePreferences(
      { presetId: 'maya', talkativeness: 'reserved', updatedAt: 500 },
      { presetId: 'rowan', talkativeness: 'chatty', updatedAt: 200 },
    ),
    { presetId: 'maya', talkativeness: 'reserved', updatedAt: 500 },
  );
});

test('voicePreferences survive a desktop workspace merge and save', () => {
  const cloudState = {
    ...createDefaultState(),
    voicePreferences: { presetId: 'maya', updatedAt: 100 },
  };
  const deviceState = {
    ...createDefaultState(),
    voicePreferences: { presetId: 'elijah', updatedAt: 900 },
  };

  const merged = mergeWorkspaceStates(cloudState, deviceState);
  assert.deepEqual(merged.voicePreferences, {
    presetId: 'elijah',
    talkativeness: 'balanced',
    updatedAt: 900,
  });

  // The synced save payload passes the shared API schema with the field set.
  const prepared = prepareWorkspaceStateForSave(merged);
  assert.equal(prepared.success, true);
  const savePayload = JSON.parse(
    JSON.stringify({ state: prepared.state, baseRevision: 4 }),
  );
  const parsed = SaveVenomWorkspaceBody.safeParse(savePayload);
  assert.equal(parsed.success, true, JSON.stringify(parsed.error?.issues));
  assert.deepEqual(parsed.data.state.voicePreferences, {
    presetId: 'elijah',
    talkativeness: 'balanced',
    updatedAt: 900,
  });
});

test('a mobile talkativeness choice survives a desktop hydrate/save round trip', () => {
  // Mobile set the dial to reserved; the cloud snapshot carries it.
  const cloudState = {
    ...createDefaultState(),
    voicePreferences: { presetId: 'maya', talkativeness: 'reserved', updatedAt: 900 },
  };
  // This desktop device has an older, pre-talkativeness snapshot.
  const deviceState = {
    ...createDefaultState(),
    voicePreferences: { presetId: 'sam', updatedAt: 100 },
  };

  // Hydrate (normalize + merge) must not strip the mobile-selected level…
  const merged = mergeWorkspaceStates(cloudState, deviceState);
  assert.deepEqual(merged.voicePreferences, {
    presetId: 'maya',
    talkativeness: 'reserved',
    updatedAt: 900,
  });

  // …and the save desktop writes back re-uploads it unchanged, so the next
  // mobile sync cannot be reset to the balanced fallback.
  const prepared = prepareWorkspaceStateForSave(merged);
  assert.equal(prepared.success, true);
  const savePayload = JSON.parse(
    JSON.stringify({ state: prepared.state, baseRevision: 7 }),
  );
  const parsed = SaveVenomWorkspaceBody.safeParse(savePayload);
  assert.equal(parsed.success, true, JSON.stringify(parsed.error?.issues));
  assert.deepEqual(parsed.data.state.voicePreferences, {
    presetId: 'maya',
    talkativeness: 'reserved',
    updatedAt: 900,
  });
});

test('legacy desktop states without voicePreferences normalize to default', () => {
  const legacy = { ...createDefaultState() };
  delete legacy.voicePreferences;
  assert.deepEqual(
    normalizeWorkspaceState(legacy).voicePreferences,
    createDefaultVoicePreferences(),
  );
});

test('a scheduled-sync claim survives a desktop workspace merge', () => {
  const source = {
    id: 'source_scheduled',
    projectId: 'proj_default',
    provider: 'website',
    name: 'Example',
    url: 'https://example.com',
    status: 'connected',
    syncedAt: new Date(1_000).toISOString(),
    summary: 'Example source',
    context: '[source:example] Example source',
    citations: [],
    clusters: [],
    schedule: {
      cadence: 'daily',
      updatedAt: 1_000,
      claimedAt: 2_000,
      claimedBy: 'phone-session',
    },
  };
  const cloud = { ...createDefaultState(), sources: [source] };

  // The desktop never runs scheduled syncs, but a desktop conflict save must
  // not wipe the claim a phone just recorded — that would hand the slot to a
  // second device and re-enable the double sync the claim prevents. The
  // newest cadence choice and the claim travel together.
  const device = {
    ...createDefaultState(),
    sources: [{ ...source, schedule: { cadence: 'weekly', updatedAt: 3_000 } }],
  };
  const merged = mergeWorkspaceStates(cloud, device);
  assert.deepEqual(merged.sources[0].schedule, {
    cadence: 'weekly',
    updatedAt: 3_000,
    claimedAt: 2_000,
    claimedBy: 'phone-session',
  });

  // An attempt recorded at or after the claim is that claim's outcome and
  // spends it.
  const attempted = {
    ...createDefaultState(),
    sources: [
      {
        ...source,
        schedule: {
          cadence: 'daily',
          updatedAt: 1_000,
          lastAttemptAt: 2_500,
          lastError: 'Venom could not read this website.',
        },
      },
    ],
  };
  const resolved = mergeWorkspaceStates(cloud, attempted);
  assert.deepEqual(resolved.sources[0].schedule, {
    cadence: 'daily',
    updatedAt: 1_000,
    lastAttemptAt: 2_500,
    lastError: 'Venom could not read this website.',
  });
});

// ── Response mode & blend preference sync ───────────────────────────────────

function conversationWith(prefs = {}, extra = {}) {
  return {
    id: 'conv-prefs',
    title: 'Prefs',
    projectId: null,
    messages: [
      { id: 'm1', role: 'user', content: 'hi', createdAt: 10, status: 'sent' },
    ],
    createdAt: 5,
    updatedAt: 100,
    ...prefs,
    ...extra,
  };
}

function stateWithConversation(conversation) {
  return normalizeWorkspaceState({
    ...createDefaultState(),
    conversations: [conversation],
    activeConversationId: conversation.id,
  });
}

test('normalizeWorkspaceState drops malformed response prefs', () => {
  const state = stateWithConversation(
    conversationWith({
      responseMode: 'shout',
      blend: { corners: ['a', 'b'], weights: [1, 0, 0] },
      modeUpdatedAt: -5,
    }),
  );
  const conv = state.conversations[0];
  assert.equal(conv.responseMode, undefined);
  assert.equal(conv.blend, undefined);
  assert.equal(conv.modeUpdatedAt, undefined);
});

test('normalizeWorkspaceState keeps valid response prefs and normalizes weights', () => {
  const state = stateWithConversation(
    conversationWith({
      responseMode: 'debate',
      blend: { corners: ['a', 'b', 'c'], weights: [0.25, 0.125, 0.125] },
      modeUpdatedAt: 50,
    }),
  );
  const conv = state.conversations[0];
  assert.equal(conv.responseMode, 'debate');
  assert.deepEqual(conv.blend.corners, ['a', 'b', 'c']);
  assert.ok(Math.abs(conv.blend.weights[0] - 0.5) < 1e-9);
  assert.equal(conv.modeUpdatedAt, 50);
});

test('merge keeps the preference block with the newer modeUpdatedAt', () => {
  const cloud = stateWithConversation(
    conversationWith({
      responseMode: 'verify',
      blend: { corners: ['a', 'b', 'c'], weights: [0.5, 0.25, 0.25] },
      modeUpdatedAt: 200,
    }),
  );
  // Device has newer chat content but an older preference change.
  const device = stateWithConversation(
    conversationWith(
      { responseMode: 'talk', modeUpdatedAt: 120 },
      {
        updatedAt: 300,
        messages: [
          { id: 'm1', role: 'user', content: 'hi', createdAt: 10, status: 'sent' },
          { id: 'm2', role: 'assistant', content: 'yo', createdAt: 20, status: 'sent' },
        ],
      },
    ),
  );

  const merged = mergeWorkspaceStates(cloud, device);
  const conv = merged.conversations[0];
  // Newest content wins for messages…
  assert.equal(conv.messages.length, 2);
  // …but the cloud's newer preference block wins whole.
  assert.equal(conv.responseMode, 'verify');
  assert.deepEqual(conv.blend.corners, ['a', 'b', 'c']);
  assert.equal(conv.modeUpdatedAt, 200);
});

test('merge tie on modeUpdatedAt keeps the device preference block', () => {
  const cloud = stateWithConversation(
    conversationWith({ responseMode: 'verify', modeUpdatedAt: 150 }),
  );
  const device = stateWithConversation(
    conversationWith({ responseMode: 'debate', modeUpdatedAt: 150 }),
  );
  const merged = mergeWorkspaceStates(cloud, device);
  assert.equal(merged.conversations[0].responseMode, 'debate');
});

test('merge treats a missing preference block as oldest', () => {
  const cloud = stateWithConversation(conversationWith());
  const device = stateWithConversation(
    conversationWith({ responseMode: 'debate', modeUpdatedAt: 10 }),
  );
  const merged = mergeWorkspaceStates(cloud, device);
  assert.equal(merged.conversations[0].responseMode, 'debate');

  // And the reverse: a device without prefs loses to a cloud with them.
  const merged2 = mergeWorkspaceStates(device, cloud);
  assert.equal(merged2.conversations[0].responseMode, 'debate');
});

test('speaker fields on messages survive the cross-device merge', () => {
  const turn = {
    id: 'm-turn',
    role: 'assistant',
    content: 'point taken',
    createdAt: 30,
    status: 'sent',
    speakerId: 'voice-a',
    speakerName: 'First take',
    modelId: 'venom-gpt',
    modelName: 'GPT-5',
  };
  const cloud = stateWithConversation(
    conversationWith({}, { messages: [turn], updatedAt: 400 }),
  );
  const device = stateWithConversation(conversationWith());
  const merged = mergeWorkspaceStates(cloud, device);
  const messages = merged.conversations[0].messages;
  const kept = messages.find((message) => message.id === 'm-turn');
  assert.ok(kept, 'debate turn should survive the merge');
  assert.equal(kept.speakerId, 'voice-a');
  assert.equal(kept.speakerName, 'First take');
});

test('save payload with response prefs and speaker fields passes the server contract', () => {
  const state = stateWithConversation(
    conversationWith(
      {
        responseMode: 'debate',
        blend: { corners: ['a', 'b', 'c'], weights: [0.5, 0.3, 0.2] },
        modeUpdatedAt: 60,
      },
      {
        messages: [
          {
            id: 'm-turn',
            role: 'assistant',
            content: 'take',
            createdAt: 30,
            status: 'sent',
            speakerId: 'voice-a',
            speakerName: 'First take',
          },
        ],
      },
    ),
  );
  const prepared = prepareWorkspaceStateForSave(state);
  assert.equal(prepared.success, true);
  const parsed = SaveVenomWorkspaceBody.safeParse({
    state: prepared.state,
    baseRevision: 1,
    clientId: 'client-test',
  });
  assert.equal(parsed.success, true, JSON.stringify(parsed.error?.issues ?? []));
});

// ---------------------------------------------------------------------------
// Retired-citation archive across desktop merges
// ---------------------------------------------------------------------------

const archivedCitation = (id, retiredAt) => ({
  id,
  title: `${id} title`,
  url: `https://example.com/${id}`,
  retiredAt,
});

const archiveProject = (id, updatedAt) => ({
  id,
  name: `${id} name`,
  description: '',
  accent: '#000000',
  sourceCount: 0,
  updatedAt,
  tasks: [],
});

const archiveConversation = (id, projectId, updatedAt, messages) => ({
  id,
  title: `${id} title`,
  projectId,
  updatedAt,
  messages,
});

test('desktop merges keep archive entries answers still cite', () => {
  const base = {
    ...createDefaultState(),
    projects: [archiveProject('proj', 10)],
    conversations: [
      archiveConversation('chat', 'proj', 50, [
        {
          id: 'm1',
          role: 'assistant',
          content: 'Based on [source:cite_cloud] and [source:cite_device].',
          createdAt: 50,
          status: 'sent',
        },
      ]),
    ],
    activeProjectId: 'proj',
    activeConversationId: 'chat',
  };
  const cloud = {
    ...base,
    archivedCitations: [archivedCitation('cite_cloud', 100)],
  };
  const device = {
    ...base,
    archivedCitations: [archivedCitation('cite_device', 200)],
  };

  const merged = mergeWorkspaceStates(cloud, device);

  assert.deepEqual(
    merged.archivedCitations.map((entry) => entry.id),
    ['cite_device', 'cite_cloud'],
  );

  // The archive must also survive the save pipeline inside the synced schema.
  const prepared = prepareWorkspaceStateForSave(merged);
  assert.equal(prepared.success, true);
  assert.deepEqual(
    prepared.state.archivedCitations.map((entry) => entry.id),
    ['cite_device', 'cite_cloud'],
  );
  const parsed = SaveVenomWorkspaceBody.safeParse({
    state: prepared.state,
    baseRevision: 1,
    clientId: 'client-test',
  });
  assert.equal(parsed.success, true, JSON.stringify(parsed.error?.issues ?? []));
});

test('a stale desktop cannot resurrect an entry a refresh already restored', () => {
  const liveCitation = {
    id: 'cite_back',
    provider: 'github',
    kind: 'issue',
    title: 'Reopened issue',
    url: 'https://github.com/acme/venom/issues/12',
    excerpt: 'Drawer stays open on mobile.',
    reference: 'acme/venom#12',
  };
  const refreshedSource = {
    id: 'source-refreshed',
    projectId: 'proj',
    provider: 'github',
    name: 'acme/venom',
    url: 'https://github.com/acme/venom',
    status: 'connected',
    syncedAt: new Date(5_000).toISOString(),
    summary: 'Repo source',
    context: '[source:cite_back] Reopened issue',
    citations: [liveCitation],
    clusters: [],
  };
  const base = {
    ...createDefaultState(),
    projects: [archiveProject('proj', 10)],
    conversations: [
      archiveConversation('chat', 'proj', 100, [
        {
          id: 'm1',
          role: 'assistant',
          content: 'See [source:cite_back] and [source:cite_gone].',
          createdAt: 100,
          status: 'sent',
        },
      ]),
    ],
    sources: [refreshedSource],
    activeProjectId: 'proj',
    activeConversationId: 'chat',
  };
  // The device that ran the refresh already dropped cite_back; this desktop
  // synced before that and would re-upload the stale entry wholesale.
  const cloud = {
    ...base,
    archivedCitations: [archivedCitation('cite_gone', 900)],
  };
  const staleDesktop = {
    ...base,
    archivedCitations: [
      archivedCitation('cite_back', 800),
      archivedCitation('cite_gone', 900),
    ],
  };

  const merged = mergeWorkspaceStates(cloud, staleDesktop);

  assert.deepEqual(
    merged.archivedCitations.map((entry) => entry.id),
    ['cite_gone'],
  );

  // Live rendering is unchanged: the restored marker resolves to the live
  // citation and the still-gone marker keeps its archived title.
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
      { kind: 'text', text: 'See ' },
      { kind: 'citation', citation: liveCitation },
      { kind: 'text', text: ' and ' },
      {
        kind: 'archived',
        citationId: 'cite_gone',
        label: 'cite_gone title (archived)',
        archived: archivedCitation('cite_gone', 900),
      },
      { kind: 'text', text: '.' },
    ],
  );
});

test('a desktop merge keeps the archive pruned after a project deletion elsewhere', () => {
  const keptChat = archiveConversation('kept-chat', 'proj-keep', 40, [
    {
      id: 'm-keep',
      role: 'assistant',
      content: 'Still based on [source:cite_kept].',
      createdAt: 40,
      status: 'sent',
    },
  ]);
  // The cloud already reflects the deletion: the project, its chat, and the
  // archive entry only that chat cited are gone.
  const cloud = {
    ...createDefaultState(),
    projects: [archiveProject('proj-keep', 10)],
    conversations: [keptChat],
    activeProjectId: 'proj-keep',
    activeConversationId: 'kept-chat',
    tombstones: {
      ...createDefaultState().tombstones,
      projects: [{ id: 'proj-gone', deletedAt: 2_000 }],
      conversations: [{ id: 'gone-chat', deletedAt: 2_000 }],
    },
    archivedCitations: [archivedCitation('cite_kept', 300)],
  };
  // The stale desktop still holds the deleted project, its chat, and the
  // archive entry that chat alone cited.
  const staleDesktop = {
    ...createDefaultState(),
    projects: [archiveProject('proj-keep', 10), archiveProject('proj-gone', 10)],
    conversations: [
      keptChat,
      archiveConversation('gone-chat', 'proj-gone', 100, [
        {
          id: 'm-gone',
          role: 'assistant',
          content: 'Cited [source:cite_gone].',
          createdAt: 100,
          status: 'sent',
        },
      ]),
    ],
    activeProjectId: 'proj-gone',
    activeConversationId: 'gone-chat',
    archivedCitations: [
      archivedCitation('cite_kept', 300),
      archivedCitation('cite_gone', 400),
    ],
  };

  const merged = mergeWorkspaceStates(cloud, staleDesktop);

  assert.deepEqual(
    merged.projects.map((item) => item.id),
    ['proj-keep'],
  );
  assert.deepEqual(
    merged.archivedCitations.map((entry) => entry.id),
    ['cite_kept'],
  );
});

test('a stale archive pile cannot regrow the desktop merge or evict cited evidence', () => {
  const base = {
    ...createDefaultState(),
    projects: [archiveProject('proj', 10)],
    conversations: [
      archiveConversation('chat', 'proj', 50, [
        {
          id: 'm1',
          role: 'assistant',
          content: 'Kept because of [source:cite_needed].',
          createdAt: 50,
          status: 'sent',
        },
      ]),
    ],
    activeProjectId: 'proj',
    activeConversationId: 'chat',
  };
  const cloud = {
    ...base,
    // The oldest entry in the union: capping before pruning would evict it.
    archivedCitations: [archivedCitation('cite_needed', 1)],
  };
  const staleDesktop = {
    ...base,
    archivedCitations: Array.from(
      { length: ARCHIVED_CITATION_LIMIT + 20 },
      (_, index) => archivedCitation(`cite_stale_${index}`, 1_000 + index),
    ),
  };

  const merged = mergeWorkspaceStates(cloud, staleDesktop);

  assert.deepEqual(
    merged.archivedCitations.map((entry) => entry.id),
    ['cite_needed'],
  );
});
