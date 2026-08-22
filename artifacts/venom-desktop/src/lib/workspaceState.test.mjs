import assert from 'node:assert/strict';
import test from 'node:test';

import { SaveVenomWorkspaceBody } from '../../../../lib/api-zod/src/generated/api.ts';
import { validateVenomBoardState } from '../../../api-server/src/routes/venom-board-validation.ts';
import { messageCitationSegments } from './messageCitations.ts';
import {
  ARCHIVED_CITATION_LIMIT,
  availableTaskStatuses,
  captureProjectRestoreSnapshot,
  createDefaultState,
  createDefaultModelPreferences,
  createDefaultVoicePreferences,
  createEmptyTombstones,
  deleteProjectFromState,
  fileConversationToProjectInState,
  mergeArchivedCitations,
  mergeModelPreferences,
  mergeVoicePreferences,
  mergeWorkspaceStates,
  normalizeModelPreferences,
  normalizeVoicePreferences,
  normalizeWorkspaceState,
  prepareWorkspaceStateForSave,
  PROJECT_RESTORE_WINDOW_MS,
  restoreProjectFromSnapshot,
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
  // Duplicate-named stages are kept and renamed (the rule shared with the
  // phone app via @workspace/venom-workspace-merge), never dropped: dropping
  // silently deleted a column the other device still showed. The renamed
  // board still satisfies the API's name-uniqueness gate asserted above.
  assert.deepEqual(
    normalized.projects[0].boardStages.map((stage) => [stage.id, stage.name]),
    [
      ['done', 'Done'],
      ['todo-a', 'To Do'],
      ['todo-b', 'to do (2)'],
    ],
  );
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

// ---- selectionPolicy (account-level auto model choice) ----

test('normalizeModelPreferences keeps valid selection policies verbatim', () => {
  for (const policy of ['manual', 'auto-cheapest', 'auto-max-power']) {
    const prefs = normalizeModelPreferences({
      enabledModelIds: ['venom-gpt'],
      defaultModelId: 'venom-gpt',
      activeModelId: 'venom-gpt',
      selectionPolicy: policy,
      updatedAt: 5,
    });
    assert.equal(prefs.selectionPolicy, policy);
  }
});

test('normalizeModelPreferences drops unknown selection policies', () => {
  for (const bad of ['cheapest', 'AUTO-CHEAPEST', 42, {}, null]) {
    const prefs = normalizeModelPreferences({
      enabledModelIds: ['venom-gpt'],
      defaultModelId: 'venom-gpt',
      activeModelId: 'venom-gpt',
      selectionPolicy: bad,
      updatedAt: 5,
    });
    assert.equal('selectionPolicy' in prefs, false);
  }
  // Absent stays absent — legacy snapshots are untouched.
  const legacy = normalizeModelPreferences({
    enabledModelIds: ['venom-gpt'],
    defaultModelId: 'venom-gpt',
    activeModelId: 'venom-gpt',
    updatedAt: 5,
  });
  assert.equal('selectionPolicy' in legacy, false);
});

test('mergeModelPreferences carries the policy with the winning block', () => {
  const cloud = {
    enabledModelIds: ['venom-gpt'],
    defaultModelId: 'venom-gpt',
    activeModelId: 'venom-gpt',
    selectionPolicy: 'auto-cheapest',
    updatedAt: 200,
  };
  const device = {
    enabledModelIds: ['venom-claude'],
    defaultModelId: 'venom-claude',
    activeModelId: 'venom-claude',
    updatedAt: 100,
  };
  // Cloud wins: its policy arrives with it.
  assert.equal(mergeModelPreferences(cloud, device).selectionPolicy, 'auto-cheapest');
  // Device wins on a newer write: switching back to manual sticks even
  // against an older cloud block that carried an auto policy.
  const deviceManual = { ...device, selectionPolicy: 'manual', updatedAt: 300 };
  assert.equal(mergeModelPreferences(cloud, deviceManual).selectionPolicy, 'manual');
});

test('mergeWorkspaceStates round-trips the selection policy', () => {
  const cloud = {
    ...createDefaultState(),
    modelPreferences: {
      enabledModelIds: ['venom-gpt'],
      defaultModelId: 'venom-gpt',
      activeModelId: 'venom-gpt',
      selectionPolicy: 'auto-max-power',
      updatedAt: 20,
    },
  };
  const device = {
    ...createDefaultState(),
    modelPreferences: {
      enabledModelIds: ['venom-claude'],
      defaultModelId: 'venom-claude',
      activeModelId: 'venom-claude',
      updatedAt: 10,
    },
  };
  const merged = mergeWorkspaceStates(cloud, device);
  assert.equal(merged.modelPreferences?.selectionPolicy, 'auto-max-power');
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

test('message attachment stamps and thumbnails survive the cross-device merge', () => {
  const imageStamp = {
    id: 'file-img',
    name: 'pixel.png',
    contentType: 'image/png',
    size: 68,
    kind: 'upload',
    // Image stamps carry a tiny data-URL thumbnail; it must ride the sync.
    thumbnail: 'data:image/jpeg;base64,dGh1bWI=',
  };
  const documentStamp = {
    id: 'file-doc',
    name: 'venom-brief.pdf',
    contentType: 'application/pdf',
    size: 900,
    kind: 'generated',
  };
  const cloud = stateWithConversation(
    conversationWith(
      {},
      {
        updatedAt: 200,
        messages: [
          {
            id: 'cloud-message',
            role: 'user',
            content: 'look at this',
            createdAt: 10,
            status: 'sent',
            attachments: [imageStamp],
          },
        ],
      },
    ),
  );
  const device = stateWithConversation(
    conversationWith(
      {},
      {
        updatedAt: 300,
        messages: [
          {
            id: 'device-message',
            role: 'assistant',
            content: 'here you go',
            createdAt: 20,
            status: 'sent',
            attachments: [documentStamp],
          },
        ],
      },
    ),
  );

  const merged = mergeWorkspaceStates(cloud, device);
  const conv = merged.conversations.find((item) => item.id === 'conv-prefs');
  assert.deepEqual(
    conv.messages.find((item) => item.id === 'cloud-message').attachments,
    [imageStamp],
  );
  assert.deepEqual(
    conv.messages.find((item) => item.id === 'device-message').attachments,
    [documentStamp],
  );
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

test('desktop cap eviction keeps cited entries ahead of newer uncited ones', () => {
  // Mirrors the mobile eviction test: the eviction order must stay identical
  // across the two apps or their syncs would flip-flop over which entries
  // survive the cap.
  const cited = [archivedCitation('cite_named_by_answer', 1)];
  const uncited = Array.from(
    { length: ARCHIVED_CITATION_LIMIT + 10 },
    (_, index) => archivedCitation(`cite_uncited_${index}`, 100 + index),
  );

  const merged = mergeArchivedCitations(
    (citationId) => citationId === 'cite_named_by_answer',
    uncited,
    cited,
  );

  assert.equal(merged.length, ARCHIVED_CITATION_LIMIT);
  // The cited entry is the oldest of all yet survives, at the tail of the
  // newest-first ordering; the oldest uncited entries are evicted instead.
  assert.equal(merged[merged.length - 1].id, 'cite_named_by_answer');
  assert.ok(!merged.some((entry) => entry.id === 'cite_uncited_0'));
  assert.ok(merged.some((entry) => entry.id === 'cite_uncited_11'));
  const retiredTimes = merged.map((entry) => entry.retiredAt);
  assert.deepEqual(
    retiredTimes,
    [...retiredTimes].sort((left, right) => right - left),
  );
});

// ---------------------------------------------------------------------------
// Project deletion (mirrors mobile VenomContext.deleteProject)
// ---------------------------------------------------------------------------

const DELETE_NOW = 1_755_600_000_000;

function deletionProject(id, name, updatedAt) {
  return {
    id,
    name,
    description: 'Fixture project',
    accent: '#e5e5e5',
    sourceCount: 0,
    updatedAt,
    boardStages: [
      {
        id: `stage_todo_${id}`,
        name: 'To Do',
        position: 0,
        isDone: false,
        updatedAt,
      },
      {
        id: `stage_done_${id}`,
        name: 'Done',
        position: 1,
        isDone: true,
        updatedAt,
      },
    ],
    fieldDefinitions: [
      {
        id: `field_owner_${id}`,
        name: 'Owner',
        type: 'text',
        options: [],
        position: 0,
        updatedAt,
      },
    ],
    tasks: [
      {
        id: `task_one_${id}`,
        title: 'First task',
        stageId: `stage_todo_${id}`,
        position: 0,
        createdAt: updatedAt,
        updatedAt,
        values: {},
      },
    ],
  };
}

function deletionConversation(id, projectId, updatedAt, content) {
  return {
    id,
    title: `${id} title`,
    projectId,
    updatedAt,
    messages: [
      {
        id: `msg_${id}`,
        role: 'assistant',
        content,
        createdAt: updatedAt,
        status: 'sent',
      },
    ],
  };
}

function deletionCluster(id, projectId, lastUpdatedAt) {
  return {
    id,
    projectId,
    label: `${id} label`,
    category: 'core',
    strength: 0.6,
    x: 0,
    y: 0,
    links: [],
    description: 'Fixture cluster',
    summary: 'Fixture cluster',
    mentionCount: 1,
    lastUpdatedAt,
    sources: [],
  };
}

function deletionSource(id, projectId, syncedAtMs) {
  return {
    id,
    projectId,
    provider: 'github',
    name: `${id} name`,
    url: `https://example.com/${id}`,
    status: 'connected',
    syncedAt: new Date(syncedAtMs).toISOString(),
    summary: 'Fixture source',
    context: 'Fixture source',
    citations: [],
    clusters: [],
  };
}

function threeProjectState() {
  return {
    projects: [
      deletionProject('proj_alpha', 'Alpha', DELETE_NOW - 5_000),
      deletionProject('proj_beta', 'Beta', DELETE_NOW - 2_000),
      deletionProject('proj_gamma', 'Gamma', DELETE_NOW - 3_000),
    ],
    conversations: [
      deletionConversation(
        'conv_alpha',
        'proj_alpha',
        DELETE_NOW - 5_000,
        'Only alpha cites [source:cite_alpha].',
      ),
      deletionConversation(
        'conv_beta',
        'proj_beta',
        DELETE_NOW - 2_000,
        'Beta cites [source:cite_beta].',
      ),
      deletionConversation(
        'conv_unfiled',
        null,
        DELETE_NOW - 1_000,
        'No markers here.',
      ),
    ],
    clusters: [
      deletionCluster('cl_alpha', 'proj_alpha', DELETE_NOW - 5_000),
      deletionCluster('cl_beta', 'proj_beta', DELETE_NOW - 2_000),
      deletionCluster('cl_unfiled', null, DELETE_NOW - 1_000),
    ],
    sources: [
      deletionSource('src_alpha', 'proj_alpha', DELETE_NOW - 5_000),
      deletionSource('src_beta', 'proj_beta', DELETE_NOW - 2_000),
    ],
    archivedCitations: [
      archivedCitation('cite_alpha', DELETE_NOW - 4_000),
      archivedCitation('cite_beta', DELETE_NOW - 4_000),
    ],
    activeProjectId: 'proj_alpha',
    activeConversationId: 'conv_alpha',
    tombstones: createEmptyTombstones(),
    modelPreferences: createDefaultModelPreferences(),
    voicePreferences: createDefaultVoicePreferences(),
  };
}

const deletionGenerateId = (prefix) => `${prefix}_fresh`;

test('deleting the active project lands on the most recently updated remaining project and tombstones every removed record', () => {
  const next = deleteProjectFromState({
    state: threeProjectState(),
    projectId: 'proj_alpha',
    deletedAt: DELETE_NOW,
    generateId: deletionGenerateId,
  });

  assert.deepEqual(
    next.projects.map((project) => project.id),
    ['proj_beta', 'proj_gamma'],
  );
  assert.equal(next.activeProjectId, 'proj_beta');
  assert.deepEqual(
    next.conversations.map((conversation) => conversation.id),
    ['conv_beta', 'conv_unfiled'],
  );
  assert.equal(next.activeConversationId, null);
  assert.deepEqual(
    next.clusters.map((cluster) => cluster.id),
    ['cl_beta', 'cl_unfiled'],
  );
  assert.deepEqual(
    next.sources.map((source) => source.id),
    ['src_beta'],
  );
  // Evidence only alpha's answers cited leaves the archive with the project.
  assert.deepEqual(
    next.archivedCitations.map((entry) => entry.id),
    ['cite_beta'],
  );

  // Same tombstones the phone writes, all stamped with the deletion time.
  const tombstones = next.tombstones;
  assert.deepEqual(tombstones.projects, [
    { id: 'proj_alpha', deletedAt: DELETE_NOW },
  ]);
  assert.deepEqual(
    tombstones.tasks.map((marker) => marker.id),
    ['task_one_proj_alpha'],
  );
  assert.deepEqual(
    tombstones.conversations.map((marker) => marker.id),
    ['conv_alpha'],
  );
  assert.deepEqual(
    tombstones.messages.map((marker) => marker.id),
    ['msg_conv_alpha'],
  );
  assert.deepEqual(
    tombstones.clusters.map((marker) => marker.id),
    ['cl_alpha'],
  );
  assert.deepEqual(
    tombstones.stages.map((marker) => marker.id).sort(),
    ['stage_done_proj_alpha', 'stage_todo_proj_alpha'],
  );
  assert.deepEqual(
    tombstones.fields.map((marker) => marker.id),
    ['field_owner_proj_alpha'],
  );
  assert.deepEqual(
    tombstones.sources.map((marker) => marker.id),
    ['src_alpha'],
  );
  for (const collection of Object.values(tombstones)) {
    for (const marker of collection) {
      assert.equal(marker.deletedAt, DELETE_NOW);
    }
  }
});

test('deleting a background project keeps the active workspace and conversation in place', () => {
  const state = {
    ...threeProjectState(),
    activeProjectId: 'proj_gamma',
    activeConversationId: 'conv_unfiled',
  };
  const next = deleteProjectFromState({
    state,
    projectId: 'proj_beta',
    deletedAt: DELETE_NOW,
    generateId: deletionGenerateId,
  });

  assert.deepEqual(
    next.projects.map((project) => project.id),
    ['proj_alpha', 'proj_gamma'],
  );
  assert.equal(next.activeProjectId, 'proj_gamma');
  assert.equal(next.activeConversationId, 'conv_unfiled');
  assert.equal(
    next.tombstones.projects.some((marker) => marker.id === 'proj_beta'),
    true,
  );
});

test('deleting the last project seeds a fresh fallback workspace under a new id', () => {
  const state = {
    ...threeProjectState(),
    projects: [deletionProject('proj_solo', 'Solo', DELETE_NOW - 1_000)],
    conversations: [
      deletionConversation(
        'conv_solo',
        'proj_solo',
        DELETE_NOW - 1_000,
        'Solo notes.',
      ),
    ],
    clusters: [],
    sources: [],
    archivedCitations: [],
    activeProjectId: 'proj_solo',
    activeConversationId: 'conv_solo',
  };
  const next = deleteProjectFromState({
    state,
    projectId: 'proj_solo',
    deletedAt: DELETE_NOW,
    generateId: deletionGenerateId,
  });

  assert.equal(next.projects.length, 1);
  const fallback = next.projects[0];
  // A fresh id keeps the deleted project's tombstone authoritative in sync.
  assert.equal(fallback.id, 'proj_fresh');
  assert.equal(fallback.name, 'General');
  assert.equal(fallback.updatedAt, DELETE_NOW);
  assert.equal(fallback.boardStages.length, 3);
  assert.deepEqual(fallback.tasks, []);
  assert.equal(next.activeProjectId, 'proj_fresh');
  assert.equal(next.activeConversationId, null);
  assert.equal(next.conversations.length, 0);
  assert.equal(
    next.tombstones.projects.some((marker) => marker.id === 'proj_solo'),
    true,
  );
});

test('a deleted project cannot resurrect through a cross-device merge', () => {
  const staleCloud = threeProjectState();
  const afterDelete = deleteProjectFromState({
    state: threeProjectState(),
    projectId: 'proj_alpha',
    deletedAt: DELETE_NOW,
    generateId: deletionGenerateId,
  });

  for (const merged of [
    mergeWorkspaceStates(staleCloud, afterDelete),
    mergeWorkspaceStates(afterDelete, staleCloud),
  ]) {
    assert.deepEqual(
      merged.projects.map((project) => project.id).sort(),
      ['proj_beta', 'proj_gamma'],
    );
    assert.equal(
      merged.conversations.some((conversation) => conversation.id === 'conv_alpha'),
      false,
    );
    assert.equal(
      merged.clusters.some((cluster) => cluster.id === 'cl_alpha'),
      false,
    );
    assert.equal(
      merged.sources.some((source) => source.id === 'src_alpha'),
      false,
    );
    assert.equal(
      merged.archivedCitations.some((entry) => entry.id === 'cite_alpha'),
      false,
    );
    // The tombstone itself survives the merge so a third device drops it too.
    assert.equal(
      merged.tombstones.projects.some(
        (marker) => marker.id === 'proj_alpha' && marker.deletedAt === DELETE_NOW,
      ),
      true,
    );
  }
});

// ---------------------------------------------------------------------------
// Undo delete: snapshot capture + fresh-id restore (shared with the phone via
// @workspace/venom-workspace-merge). The tombstones a delete writes stay dead
// forever; undo rebuilds the content as NEW entities, mirroring how deleting
// the last project seeds its fallback workspace under a fresh id.
// ---------------------------------------------------------------------------

const RESTORE_AT = DELETE_NOW + 6_000;

// Restores mint many ids per prefix, so the single-value deletionGenerateId
// would collide; this factory counts.
const restoreIdFactory = () => {
  let counter = 0;
  return (prefix) => `${prefix}_r${(counter += 1)}`;
};

function lastProjectState() {
  return {
    ...threeProjectState(),
    projects: [deletionProject('proj_solo', 'Solo', DELETE_NOW - 1_000)],
    conversations: [
      deletionConversation(
        'conv_solo',
        'proj_solo',
        DELETE_NOW - 1_000,
        'Solo notes.',
      ),
    ],
    clusters: [],
    sources: [],
    archivedCitations: [],
    activeProjectId: 'proj_solo',
    activeConversationId: 'conv_solo',
  };
}

test('capture mirrors exactly what the delete removes, nothing the delete keeps', () => {
  const snapshot = captureProjectRestoreSnapshot(
    threeProjectState(),
    'proj_alpha',
    DELETE_NOW,
  );

  assert.equal(snapshot.project.id, 'proj_alpha');
  assert.deepEqual(
    snapshot.conversations.map((conversation) => conversation.id),
    ['conv_alpha'],
  );
  assert.deepEqual(
    snapshot.clusters.map((cluster) => cluster.id),
    ['cl_alpha'],
  );
  assert.deepEqual(
    snapshot.sources.map((source) => source.id),
    ['src_alpha'],
  );
  // cite_beta stays cited by a surviving conversation, so the delete keeps it
  // in the archive and the capture leaves it alone.
  assert.deepEqual(
    snapshot.archivedCitations.map((entry) => entry.id),
    ['cite_alpha'],
  );
  assert.equal(snapshot.deletedAt, DELETE_NOW);
  assert.equal(snapshot.wasLastProject, false);

  // Unknown project — nothing to capture, nothing to offer undo for.
  assert.equal(
    captureProjectRestoreSnapshot(threeProjectState(), 'proj_missing', DELETE_NOW),
    null,
  );

  // The undo window is a short beat, not a persistence layer.
  assert.ok(PROJECT_RESTORE_WINDOW_MS >= 5_000);
  assert.ok(PROJECT_RESTORE_WINDOW_MS <= 60_000);
});

test('undo rebuilds the deleted project under fresh ids and remaps every cross-reference', () => {
  const before = threeProjectState();
  // Enrich alpha so every remap path is exercised: field values keyed by
  // definition id (plus a dangling key), linked clusters, and embedded
  // knowledge evidence pointing at alpha's conversation and message.
  before.projects[0].tasks[0].values = {
    field_owner_proj_alpha: 'Dana',
    field_ghost: 'points at an already-deleted definition',
  };
  before.clusters = [
    {
      ...deletionCluster('cl_alpha', 'proj_alpha', DELETE_NOW - 5_000),
      links: ['cl_alpha_two'],
      sources: [
        {
          conversationId: 'conv_alpha',
          projectId: 'proj_alpha',
          conversationTitle: 'conv_alpha title',
          messageIds: ['msg_conv_alpha'],
          excerpt: 'Only alpha cites [source:cite_alpha].',
          updatedAt: DELETE_NOW - 5_000,
        },
      ],
    },
    deletionCluster('cl_alpha_two', 'proj_alpha', DELETE_NOW - 4_500),
    ...threeProjectState().clusters.filter(
      (cluster) => cluster.projectId !== 'proj_alpha',
    ),
  ];

  const snapshot = captureProjectRestoreSnapshot(before, 'proj_alpha', DELETE_NOW);
  const afterDelete = deleteProjectFromState({
    state: before,
    projectId: 'proj_alpha',
    deletedAt: DELETE_NOW,
    generateId: deletionGenerateId,
  });

  const { state: restored, projectId } = restoreProjectFromSnapshot({
    state: afterDelete,
    snapshot,
    restoredAt: RESTORE_AT,
    generateId: restoreIdFactory(),
  });

  // The delete's tombstones are untouched — the old ids stay dead everywhere.
  assert.equal(restored.tombstones, afterDelete.tombstones);
  assert.notEqual(projectId, 'proj_alpha');

  const project = restored.projects.find((entry) => entry.id === projectId);
  assert.ok(project);
  assert.equal(project.name, 'Alpha');
  assert.equal(project.updatedAt, RESTORE_AT);

  const restoredConversation = restored.conversations.find(
    (conversation) => conversation.projectId === projectId,
  );
  const restoredClusters = restored.clusters.filter(
    (cluster) => cluster.projectId === projectId,
  );
  const restoredSource = restored.sources.find(
    (source) => source.projectId === projectId,
  );
  assert.ok(restoredConversation);
  assert.equal(restoredClusters.length, 2);
  assert.ok(restoredSource);

  // Every restored id is fresh: none of them appears in any tombstone.
  const deadIds = new Set(
    Object.values(restored.tombstones).flatMap((collection) =>
      collection.map((marker) => marker.id),
    ),
  );
  for (const id of [
    project.id,
    ...project.boardStages.map((stage) => stage.id),
    ...project.fieldDefinitions.map((field) => field.id),
    ...project.tasks.map((task) => task.id),
    restoredConversation.id,
    ...restoredConversation.messages.map((message) => message.id),
    ...restoredClusters.map((cluster) => cluster.id),
    restoredSource.id,
  ]) {
    assert.equal(deadIds.has(id), false, `${id} must not be tombstoned`);
  }

  // Cross-references land on the fresh ids.
  const todoStage = project.boardStages.find((stage) => stage.name === 'To Do');
  assert.equal(project.tasks[0].stageId, todoStage.id);
  const ownerField = project.fieldDefinitions.find(
    (field) => field.name === 'Owner',
  );
  // Values re-key onto the restored definition; dangling keys stay dead.
  assert.deepEqual(project.tasks[0].values, { [ownerField.id]: 'Dana' });

  const alphaCluster = restoredClusters.find(
    (cluster) => cluster.label === 'cl_alpha label',
  );
  const alphaTwoCluster = restoredClusters.find(
    (cluster) => cluster.label === 'cl_alpha_two label',
  );
  assert.deepEqual(alphaCluster.links, [alphaTwoCluster.id]);
  assert.deepEqual(alphaCluster.sources[0].conversationId, restoredConversation.id);
  assert.deepEqual(alphaCluster.sources[0].messageIds, [
    restoredConversation.messages[0].id,
  ]);
  assert.equal(alphaCluster.sources[0].projectId, projectId);

  // Message content is verbatim — inline citation markers included — and the
  // archived evidence the delete pruned is back under its original id, so the
  // marker resolves again (citation ids are never tombstoned).
  assert.equal(
    restoredConversation.messages[0].content,
    'Only alpha cites [source:cite_alpha].',
  );
  assert.equal(
    restored.archivedCitations.some((entry) => entry.id === 'cite_alpha'),
    true,
  );

  // The restored workspace becomes active, on its most recent conversation.
  assert.equal(restored.activeProjectId, projectId);
  assert.equal(restored.activeConversationId, restoredConversation.id);

  // And the result is a state the app could save as-is.
  assert.equal(prepareWorkspaceStateForSave(restored).success, true);
});

test('a restored project survives merging against a device that never saw the delete', () => {
  const staleDevice = threeProjectState();
  const before = threeProjectState();
  const snapshot = captureProjectRestoreSnapshot(before, 'proj_alpha', DELETE_NOW);
  const afterDelete = deleteProjectFromState({
    state: before,
    projectId: 'proj_alpha',
    deletedAt: DELETE_NOW,
    generateId: deletionGenerateId,
  });
  const { state: restored, projectId } = restoreProjectFromSnapshot({
    state: afterDelete,
    snapshot,
    restoredAt: RESTORE_AT,
    generateId: restoreIdFactory(),
  });

  for (const merged of [
    mergeWorkspaceStates(staleDevice, restored),
    mergeWorkspaceStates(restored, staleDevice),
  ]) {
    // The tombstoned ids stay dead in both merge orders…
    assert.equal(
      merged.projects.some((entry) => entry.id === 'proj_alpha'),
      false,
    );
    assert.equal(
      merged.conversations.some((entry) => entry.id === 'conv_alpha'),
      false,
    );
    assert.equal(
      merged.clusters.some((entry) => entry.id === 'cl_alpha'),
      false,
    );
    assert.equal(
      merged.sources.some((entry) => entry.id === 'src_alpha'),
      false,
    );
    // …while the restored copy rides through as ordinary new work.
    assert.equal(
      merged.projects.some((entry) => entry.id === projectId),
      true,
    );
    assert.equal(
      merged.conversations.some(
        (entry) => entry.projectId === projectId,
      ),
      true,
    );
    assert.equal(
      merged.archivedCitations.some((entry) => entry.id === 'cite_alpha'),
      true,
    );
    assert.equal(
      merged.tombstones.projects.some(
        (marker) => marker.id === 'proj_alpha' && marker.deletedAt === DELETE_NOW,
      ),
      true,
    );
  }
});

test('undoing a last-project delete removes the untouched fallback workspace with tombstones of its own', () => {
  const before = lastProjectState();
  const snapshot = captureProjectRestoreSnapshot(before, 'proj_solo', DELETE_NOW);
  assert.equal(snapshot.wasLastProject, true);

  const afterDelete = deleteProjectFromState({
    state: before,
    projectId: 'proj_solo',
    deletedAt: DELETE_NOW,
    generateId: deletionGenerateId,
  });
  const fallback = afterDelete.projects[0];

  const { state: restored, projectId } = restoreProjectFromSnapshot({
    state: afterDelete,
    snapshot,
    restoredAt: RESTORE_AT,
    generateId: restoreIdFactory(),
    fallbackProjectId: fallback.id,
  });

  // Only the restored copy remains, and the fallback's removal is tombstoned
  // so devices that already synced the delete drop the fallback too.
  assert.deepEqual(
    restored.projects.map((entry) => entry.id),
    [projectId],
  );
  assert.equal(
    restored.tombstones.projects.some(
      (marker) => marker.id === fallback.id && marker.deletedAt === RESTORE_AT,
    ),
    true,
  );
  for (const stage of fallback.boardStages) {
    assert.equal(
      restored.tombstones.stages.some((marker) => marker.id === stage.id),
      true,
    );
  }
  // The original delete's tombstone is untouched.
  assert.equal(
    restored.tombstones.projects.some(
      (marker) => marker.id === 'proj_solo' && marker.deletedAt === DELETE_NOW,
    ),
    true,
  );
  assert.equal(restored.activeProjectId, projectId);
});

test('a fallback workspace the user already touched survives the undo', () => {
  const before = lastProjectState();
  const snapshot = captureProjectRestoreSnapshot(before, 'proj_solo', DELETE_NOW);
  const afterDelete = deleteProjectFromState({
    state: before,
    projectId: 'proj_solo',
    deletedAt: DELETE_NOW,
    generateId: deletionGenerateId,
  });
  const fallback = afterDelete.projects[0];
  // Any edit after the delete marks the fallback as the user's workspace.
  const touched = {
    ...afterDelete,
    projects: afterDelete.projects.map((entry) =>
      entry.id === fallback.id
        ? { ...entry, updatedAt: DELETE_NOW + 1_000 }
        : entry,
    ),
  };

  const { state: restored, projectId } = restoreProjectFromSnapshot({
    state: touched,
    snapshot,
    restoredAt: RESTORE_AT,
    generateId: restoreIdFactory(),
    fallbackProjectId: fallback.id,
  });

  assert.deepEqual(
    restored.projects.map((entry) => entry.id).sort(),
    [fallback.id, projectId].sort(),
  );
  assert.equal(
    restored.tombstones.projects.some((marker) => marker.id === fallback.id),
    false,
  );
});

// ---------------------------------------------------------------------------
// Stacked chat dots: normalize and merge must separate buried positions
// ---------------------------------------------------------------------------

const stackGap = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

function stackedFixtureState(clusters) {
  return {
    projects: [
      {
        id: 'shared',
        name: 'Shared',
        description: '',
        accent: '#000000',
        sourceCount: 0,
        updatedAt: 10,
        boardStages: [],
        fieldDefinitions: [],
        tasks: [],
      },
    ],
    conversations: [
      { id: 'shared-chat', title: 'Chat', projectId: 'shared', updatedAt: 10, messages: [] },
    ],
    clusters,
    sources: [],
    activeProjectId: 'shared',
    activeConversationId: 'shared-chat',
  };
}

function stackedCluster(id, x, y, lastUpdatedAt) {
  return {
    id,
    projectId: 'shared',
    label: `${id} label`,
    category: 'topic',
    strength: 0.6,
    x,
    y,
    links: [],
    description: `${id} description`,
    summary: `${id} summary`,
    mentionCount: 1,
    lastUpdatedAt,
    sources: [],
  };
}

test('normalize separates chat clusters stored on top of each other', () => {
  const normalized = normalizeWorkspaceState(
    stackedFixtureState([
      stackedCluster('cluster-a', 100, 100, 20),
      stackedCluster('cluster-b', 100, 100, 30),
    ]),
  );
  const a = normalized.clusters.find((entry) => entry.id === 'cluster-a');
  const b = normalized.clusters.find((entry) => entry.id === 'cluster-b');
  // Ascending-id priority keeps the first dot exactly where it was stored;
  // the buried one lands on the same deterministic spot the phone computes
  // (the shared rule pins 82,118 for a 100,100 stack).
  assert.deepEqual({ x: a.x, y: a.y }, { x: 100, y: 100 });
  assert.deepEqual({ x: b.x, y: b.y }, { x: 82, y: 118 });
  // Repair never touches recency: coordinates converge on every device
  // instead of winning cross-device merges.
  assert.equal(a.lastUpdatedAt, 20);
  assert.equal(b.lastUpdatedAt, 30);
  assert.ok(stackGap(a, b) >= 12);
});

test('merging two devices separates dots that would bury each other', () => {
  const cloud = stackedFixtureState([stackedCluster('cluster-a', 30, 30, 20)]);
  const device = stackedFixtureState([stackedCluster('cluster-b', 31, 31, 30)]);

  const merged = mergeWorkspaceStates(cloud, device);
  assert.equal(merged.clusters.length, 2);
  const a = merged.clusters.find((entry) => entry.id === 'cluster-a');
  const b = merged.clusters.find((entry) => entry.id === 'cluster-b');
  assert.deepEqual({ x: a.x, y: a.y }, { x: 30, y: 30 });
  assert.ok(stackGap(a, b) >= 12);
  assert.equal(a.lastUpdatedAt, 20);
  assert.equal(b.lastUpdatedAt, 30);

  const replay = mergeWorkspaceStates(cloud, device);
  assert.deepEqual(
    replay.clusters.map((entry) => ({ id: entry.id, x: entry.x, y: entry.y })),
    merged.clusters.map((entry) => ({ id: entry.id, x: entry.x, y: entry.y })),
  );
});

function strandedFilingFixture(strandedAt) {
  const homeProject = {
    id: 'proj_home',
    name: 'Home',
    description: '',
    accent: '#000000',
    sourceCount: 0,
    updatedAt: 500,
    tasks: [],
  };
  const stranded = {
    id: 'conv_stranded',
    title: 'Scratch notes',
    projectId: null,
    updatedAt: strandedAt,
    messages: [
      {
        id: 'msg_stranded',
        role: 'user',
        content: 'Loose thought with no project',
        createdAt: 500,
        status: 'sent',
      },
    ],
  };
  const base = {
    projects: [homeProject],
    clusters: [],
    sources: [],
    activeProjectId: null,
    activeConversationId: 'conv_stranded',
    tombstones: createEmptyTombstones(),
  };
  return { stranded, base };
}

test('filing a stranded session survives the cross-device merge in both directions', () => {
  // Filing (the real mutation, not a hand-built copy) rewrites projectId and
  // stamps updatedAt through the normal synced write path; the
  // newest-copy-wins conversation merge must therefore carry the new home
  // instead of reviving the stranded project-less copy another device still
  // holds.
  const { stranded, base } = strandedFilingFixture(1_000);
  const filedState = fileConversationToProjectInState(
    { ...base, conversations: [stranded] },
    'conv_stranded',
    'proj_home',
    2_000,
  );
  const filed = filedState.conversations.find((c) => c.id === 'conv_stranded');
  assert.equal(filed?.projectId, 'proj_home');
  assert.equal(filed?.updatedAt, 2_000);
  // Filing lands the workspace on the session in its new home.
  assert.equal(filedState.activeProjectId, 'proj_home');
  assert.equal(filedState.activeConversationId, 'conv_stranded');

  // This device filed the session; the cloud still holds the stranded copy.
  const deviceFiled = mergeWorkspaceStates(
    { ...base, conversations: [stranded] },
    filedState,
  );
  assert.equal(
    deviceFiled.conversations.find((c) => c.id === 'conv_stranded')?.projectId,
    'proj_home',
  );

  // The filing arrives from the cloud; this device's copy is stale.
  const cloudFiled = mergeWorkspaceStates(filedState, {
    ...base,
    conversations: [stranded],
  });
  const carried = cloudFiled.conversations.find(
    (c) => c.id === 'conv_stranded',
  );
  assert.equal(carried?.projectId, 'proj_home');
  // The words the filing was rescuing ride along untouched.
  assert.deepEqual(
    carried?.messages.map((m) => m.id),
    ['msg_stranded'],
  );
});

test('filing outruns a stranded copy stamped by a fast clock', () => {
  // A stranded copy can arrive from a device whose clock ran ahead, so its
  // updatedAt exceeds this device's Date.now(). The filing stamp must be
  // strictly newer than the copy being filed — not merely the local time —
  // or the newest-copy-wins merge resurrects projectId: null and strands
  // the chat again.
  const { stranded, base } = strandedFilingFixture(5_000);
  const filedState = fileConversationToProjectInState(
    { ...base, conversations: [stranded] },
    'conv_stranded',
    'proj_home',
    1_000, // local clock is behind the stranded copy's stamp
  );
  const filed = filedState.conversations.find((c) => c.id === 'conv_stranded');
  assert.equal(filed?.projectId, 'proj_home');
  assert.equal(filed?.updatedAt, 5_001);

  for (const merged of [
    mergeWorkspaceStates({ ...base, conversations: [stranded] }, filedState),
    mergeWorkspaceStates(filedState, { ...base, conversations: [stranded] }),
  ]) {
    assert.equal(
      merged.conversations.find((c) => c.id === 'conv_stranded')?.projectId,
      'proj_home',
    );
  }
});

test('filing refuses sessions that already have a home and projects that do not exist', () => {
  // Filing is a recovery path for stranded sessions only; it must never
  // re-home an already-filed conversation or point one at a missing project.
  const { stranded, base } = strandedFilingFixture(1_000);
  const alreadyFiled = { ...stranded, projectId: 'proj_home' };

  const refusedRefile = fileConversationToProjectInState(
    { ...base, conversations: [alreadyFiled] },
    'conv_stranded',
    'proj_home',
    2_000,
  );
  assert.equal(
    refusedRefile.conversations.find((c) => c.id === 'conv_stranded')
      ?.updatedAt,
    1_000,
  );
  assert.equal(refusedRefile.activeProjectId, null);

  const refusedMissing = fileConversationToProjectInState(
    { ...base, conversations: [stranded] },
    'conv_stranded',
    'proj_gone',
    2_000,
  );
  assert.equal(
    refusedMissing.conversations.find((c) => c.id === 'conv_stranded')
      ?.projectId,
    null,
  );
  assert.equal(refusedMissing.activeProjectId, null);
});
