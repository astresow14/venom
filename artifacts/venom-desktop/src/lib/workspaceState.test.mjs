import assert from 'node:assert/strict';
import test from 'node:test';

import { SaveVenomWorkspaceBody } from '../../../../lib/api-zod/src/generated/api.ts';
import { validateVenomBoardState } from '../../../api-server/src/routes/venom-board-validation.ts';
import {
  availableTaskStatuses,
  mergeWorkspaceStates,
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