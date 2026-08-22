import assert from 'node:assert/strict';
import test from 'node:test';

import * as shared from '@workspace/venom-workspace-merge';
import * as desktop from './workspaceState.ts';
import * as desktopBoard from './boardState.ts';
import * as phoneBoard from '../../../venom/context/boardState.ts';
import * as phoneSourceState from '../../../venom/context/sourceState.ts';
import * as phoneWorkspaceSync from '../../../venom/context/workspaceSync.ts';
import { validateVenomBoardState } from '../../../api-server/src/routes/venom-board-validation.ts';

// ---------------------------------------------------------------------------
// Reference-identity guards: both apps must export the shared implementations
// from @workspace/venom-workspace-merge, never local copies. `===` fails as
// soon as either side reintroduces a hand-written version.
// ---------------------------------------------------------------------------

test('desktop merge rules are the shared implementations, not local copies', () => {
  assert.equal(desktop.isReplacementMarker, shared.isReplacementMarker);
  assert.equal(desktop.mergeDeletionMarkers, shared.mergeDeletionMarkers);
  assert.equal(desktop.mergeProjectSources, shared.mergeProjectSources);
  assert.equal(desktop.scheduleSyncClaim, shared.scheduleSyncClaim);
  assert.equal(
    desktop.SCHEDULED_SYNC_CLAIM_LEASE_MS,
    shared.SCHEDULED_SYNC_CLAIM_LEASE_MS,
  );
  assert.equal(desktop.createDeletionMarkers, shared.createDeletionMarkers);
  assert.equal(desktop.createEmptyTombstones, shared.createEmptyTombstones);
  assert.equal(desktop.mergeTombstones, shared.mergeTombstones);
  assert.equal(desktop.normalizeTombstones, shared.normalizeTombstones);

  // The undo-delete pair rides the same seam: what a delete captures and how
  // a restore rebuilds it under fresh ids must be one implementation, or the
  // two apps would resurrect different content from the same deletion.
  assert.equal(
    desktop.captureProjectRestoreSnapshot,
    shared.captureProjectRestoreSnapshot,
  );
  assert.equal(
    desktop.restoreProjectFromSnapshot,
    shared.restoreProjectFromSnapshot,
  );
  assert.equal(
    desktop.PROJECT_RESTORE_WINDOW_MS,
    shared.PROJECT_RESTORE_WINDOW_MS,
  );
});

// Chat-cluster map placement (spacing floor, legacy hash seed, clearance
// placement, stacked-dot repair) must also be the shared implementations —
// positions are synced fields, so a drifted local copy would compute
// different coordinates than the phone and ping-pong through sync forever.
test('desktop map placement rules are the shared implementations', () => {
  assert.equal(desktop.separateStackedClusters, shared.separateStackedClusters);
  assert.equal(desktop.positionForNewCluster, shared.positionForNewCluster);
  assert.equal(desktop.placeClusterPosition, shared.placeClusterPosition);
  assert.equal(desktop.hashPositionForLabel, shared.hashPositionForLabel);
  assert.equal(desktop.CLUSTER_SPACING_FLOOR, shared.CLUSTER_SPACING_FLOOR);
  assert.equal(
    desktop.CLUSTER_PLACEMENT_CLEARANCE,
    shared.CLUSTER_PLACEMENT_CLEARANCE,
  );

  // And the phone runs the identical functions.
  assert.equal(
    desktop.separateStackedClusters,
    phoneWorkspaceSync.separateStackedClusters,
  );
  assert.equal(
    desktop.positionForNewCluster,
    phoneWorkspaceSync.positionForNewCluster,
  );
  assert.equal(
    desktop.CLUSTER_SPACING_FLOOR,
    phoneWorkspaceSync.CLUSTER_SPACING_FLOOR,
  );
});

test('phone and desktop run the identical rule functions', () => {
  assert.equal(desktop.mergeProjectSources, phoneSourceState.mergeProjectSources);
  assert.equal(
    desktop.mergeDeletionMarkers,
    phoneSourceState.mergeSourceDeletionMarkers,
  );
  assert.equal(desktop.isReplacementMarker, phoneSourceState.isReplacementMarker);
  assert.equal(desktop.scheduleSyncClaim, phoneSourceState.scheduleSyncClaim);
  assert.equal(
    desktop.SCHEDULED_SYNC_CLAIM_LEASE_MS,
    phoneSourceState.SCHEDULED_SYNC_CLAIM_LEASE_MS,
  );
  assert.equal(
    desktop.createDeletionMarkers,
    phoneWorkspaceSync.createDeletionMarkers,
  );
  assert.equal(
    desktop.createEmptyTombstones,
    phoneWorkspaceSync.createEmptyTombstones,
  );
  assert.equal(desktop.mergeTombstones, phoneWorkspaceSync.mergeTombstones);
  assert.equal(
    desktop.normalizeTombstones,
    phoneWorkspaceSync.normalizeTombstones,
  );
  assert.equal(
    desktop.captureProjectRestoreSnapshot,
    phoneWorkspaceSync.captureProjectRestoreSnapshot,
  );
  assert.equal(
    desktop.restoreProjectFromSnapshot,
    phoneWorkspaceSync.restoreProjectFromSnapshot,
  );
  assert.equal(
    desktop.PROJECT_RESTORE_WINDOW_MS,
    phoneWorkspaceSync.PROJECT_RESTORE_WINDOW_MS,
  );
});

// ---------------------------------------------------------------------------
// Behavioural parity: run both apps' full mergeWorkspaceStates over the same
// snapshots and require identical sources + tombstones. This catches drift in
// how each app WIRES the shared rules (argument order, normalization around
// the call), which identity checks alone cannot see.
// ---------------------------------------------------------------------------

function project(id, updatedAt) {
  return {
    id,
    name: id,
    description: `${id} description`,
    accent: '#000000',
    sourceCount: 0,
    updatedAt,
    boardStages: [
      { id: `${id}-stage`, name: 'To Do', position: 0, isDone: false, updatedAt },
    ],
    fieldDefinitions: [],
    tasks: [],
  };
}

function source(id, syncedAtMs, overrides = {}) {
  return {
    id,
    projectId: 'shared',
    provider: 'website',
    name: id,
    url: `https://example.com/${id}`,
    status: 'connected',
    syncedAt: new Date(syncedAtMs).toISOString(),
    summary: `${id} summary`,
    context: `[source:${id}] ${id} summary`,
    citations: [],
    clusters: [],
    ...overrides,
  };
}

function emptyTombstones() {
  return {
    projects: [],
    tasks: [],
    conversations: [],
    messages: [],
    clusters: [],
    stages: [],
    fields: [],
    sources: [],
  };
}

// Fresh objects per app: neither merge may see the other's (potentially
// mutated) fixtures.
function makeCloudState() {
  return {
    projects: [project('shared', 10)],
    conversations: [],
    clusters: [],
    sources: [
      // Cloud holds the newer snapshot but the older schedule edit.
      source('kept-newer-cloud', 8_000, {
        schedule: { cadence: 'daily', updatedAt: 1_000 },
      }),
      // A refresh retired this id; the device's newer snapshot must lose.
      source('replaced-dead', 9_000),
      // Plain deletion older than the device's re-sync; the device revives it.
      source('plain-revived', 9_000),
      // Plain deletion newer than this stale snapshot; it stays dead.
      source('plain-dead', 1_000),
    ],
    activeProjectId: 'shared',
    activeConversationId: null,
    tombstones: {
      ...emptyTombstones(),
      messages: [{ id: 'msg', deletedAt: 1_000 }],
      sources: [
        { id: 'replaced-dead', deletedAt: 2_000, replaced: true },
        { id: 'plain-revived', deletedAt: 2_000 },
        { id: 'dup', deletedAt: 3_000 },
      ],
    },
  };
}

function makeDeviceState() {
  return {
    projects: [project('shared', 10)],
    conversations: [],
    clusters: [],
    sources: [
      // Older snapshot, newer schedule edit, plus a live sync claim.
      source('kept-newer-cloud', 5_000, {
        schedule: {
          cadence: 'weekly',
          updatedAt: 2_000,
          lastAttemptAt: 1_500,
          claimedAt: 3_000,
          claimedBy: 'phone',
        },
      }),
    ],
    activeProjectId: 'shared',
    activeConversationId: null,
    tombstones: {
      ...emptyTombstones(),
      messages: [{ id: 'msg', deletedAt: 4_000 }],
      sources: [
        { id: 'plain-dead', deletedAt: 2_000 },
        // Same id as the cloud marker: older, but flagged replaced. The merged
        // marker must keep the newer time AND the sticky replaced flag.
        { id: 'dup', deletedAt: 1_000, replaced: true },
      ],
    },
  };
}

// ---------------------------------------------------------------------------
// Board stages: duplicate-named columns. Desktop used to dedupe stages by
// name while the phone kept exact duplicates, so a workspace syncing through
// both devices flip-flopped — desktop silently dropped a column the phone
// still showed, and each side re-saved its own board. The agreed rule (keep
// every stage, rename collisions deterministically; exact duplicates are not
// an option because the server rejects them on save) lives in
// @workspace/venom-workspace-merge, and both apps must run that exact
// implementation.
// ---------------------------------------------------------------------------

test('board stage normalization is the shared implementation in both apps', () => {
  assert.equal(desktopBoard.normalizeBoardStages, shared.normalizeBoardStages);
  assert.equal(phoneBoard.normalizeBoardStages, shared.normalizeBoardStages);
  assert.equal(
    desktopBoard.createDefaultBoardStages,
    shared.createDefaultBoardStages,
  );
  assert.equal(
    phoneBoard.createDefaultBoardStages,
    shared.createDefaultBoardStages,
  );
});

// Fresh objects per app: normalization sorts in place, so neither app may see
// the other's (potentially mutated) fixture.
function duplicateStageProject() {
  return {
    id: 'dup-stages',
    name: 'Dup stages',
    description: '',
    accent: '#000000',
    sourceCount: 0,
    updatedAt: 50,
    boardStages: [
      {
        id: 'b-active',
        name: 'Active',
        position: 1,
        isDone: false,
        updatedAt: 20,
      },
      {
        id: 'a-active',
        name: 'active',
        position: 1,
        isDone: false,
        updatedAt: 10,
      },
      {
        id: 'stage-done',
        name: 'Done',
        position: 2,
        isDone: true,
        updatedAt: 30,
      },
      { id: 'todo', name: 'To Do', position: 0, isDone: false, updatedAt: 5 },
    ],
    fieldDefinitions: [],
    tasks: [],
  };
}

test('duplicate-named stages are kept and renamed identically by both apps', () => {
  const desktopStages = desktopBoard.normalizeProjectBoard(
    duplicateStageProject(),
  ).boardStages;
  const phoneStages = phoneBoard.normalizeProjectBoard(
    duplicateStageProject(),
  ).boardStages;

  assert.deepEqual(desktopStages, phoneStages);
  // No column is ever dropped. The later stage in canonical (position, id)
  // order takes the suffix, and the name comparison is case-insensitive.
  assert.deepEqual(
    desktopStages.map((stage) => [stage.id, stage.name]),
    [
      ['todo', 'To Do'],
      ['a-active', 'active'],
      ['b-active', 'Active (2)'],
      ['stage-done', 'Done'],
    ],
  );
  // The rename is a repair, not an edit: updatedAt stays untouched so a
  // repaired copy can never beat a genuine user rename in a newest-wins merge.
  assert.deepEqual(
    desktopStages.map((stage) => stage.updatedAt),
    [5, 10, 20, 30],
  );
  // And the renamed board passes the server's save-time gate, which rejects
  // duplicate stage names outright — the reason "keep exact duplicates"
  // could not be the shared rule.
  assert.deepEqual(
    validateVenomBoardState({
      projects: [desktopBoard.normalizeProjectBoard(duplicateStageProject())],
    }),
    [],
  );
});

function boardWithUrgentColumn(stageId, updatedAt) {
  return {
    id: 'shared-board',
    name: 'Shared board',
    description: '',
    accent: '#000000',
    sourceCount: 0,
    updatedAt: 60,
    boardStages: [
      { id: 'todo', name: 'To Do', position: 0, isDone: false, updatedAt: 5 },
      { id: stageId, name: 'Urgent', position: 1, isDone: false, updatedAt },
      {
        id: 'stage-done',
        name: 'Done',
        position: 2,
        isDone: true,
        updatedAt: 30,
      },
    ],
    fieldDefinitions: [],
    tasks: [],
  };
}

test('same-named columns created on two devices both survive the merge in both apps', () => {
  const noDeletions = () => ({
    tasks: new Map(),
    stages: new Map(),
    fields: new Map(),
  });
  const desktopMerged = desktopBoard.mergeProjectBoardSnapshots(
    boardWithUrgentColumn('cloud-urgent', 40),
    boardWithUrgentColumn('device-urgent', 41),
    noDeletions(),
  );
  const phoneMerged = phoneBoard.mergeProjectBoardSnapshots(
    boardWithUrgentColumn('cloud-urgent', 40),
    boardWithUrgentColumn('device-urgent', 41),
    noDeletions(),
  );

  assert.deepEqual(desktopMerged.boardStages, phoneMerged.boardStages);
  assert.deepEqual(
    desktopMerged.boardStages.map((stage) => [stage.id, stage.name]),
    [
      ['todo', 'To Do'],
      ['cloud-urgent', 'Urgent'],
      ['device-urgent', 'Urgent (2)'],
      ['stage-done', 'Done'],
    ],
  );
});

test('phone and desktop merge identical snapshots to identical sources and tombstones', () => {
  const phoneMerged = phoneWorkspaceSync.mergeWorkspaceStates(
    makeCloudState(),
    makeDeviceState(),
  );
  const desktopMerged = desktop.mergeWorkspaceStates(
    makeCloudState(),
    makeDeviceState(),
  );

  assert.deepEqual(desktopMerged.sources, phoneMerged.sources);
  assert.deepEqual(desktopMerged.tombstones, phoneMerged.tombstones);

  // Pin the outcome itself so the rules cannot drift in lockstep unnoticed.
  assert.deepEqual(
    phoneMerged.sources.map((item) => item.id).sort(),
    ['kept-newer-cloud', 'plain-revived'],
  );
  const kept = phoneMerged.sources.find(
    (item) => item.id === 'kept-newer-cloud',
  );
  assert.equal(kept.syncedAt, new Date(8_000).toISOString());
  assert.deepEqual(kept.schedule, {
    cadence: 'weekly',
    updatedAt: 2_000,
    lastAttemptAt: 1_500,
    claimedAt: 3_000,
    claimedBy: 'phone',
  });
  assert.deepEqual(
    phoneMerged.tombstones.sources.find((marker) => marker.id === 'dup'),
    { id: 'dup', deletedAt: 3_000, replaced: true },
  );
  assert.deepEqual(phoneMerged.tombstones.messages, [
    { id: 'msg', deletedAt: 4_000 },
  ]);
});
