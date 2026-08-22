import assert from "node:assert/strict";
import test from "node:test";

import * as shared from "@workspace/venom-workspace-merge";
import * as boardState from "./boardState.ts";
import * as knowledgeState from "./knowledgeState.ts";
import * as sourceState from "./sourceState.ts";
import * as workspaceSync from "./workspaceSync.ts";

// The cross-device merge rules must be the shared implementations from
// @workspace/venom-workspace-merge — not local copies that could drift from
// the desktop app. Reference identity (===) fails if anyone reintroduces a
// hand-written version behind the same export name.
test("phone merge rules are the shared implementations, not local copies", () => {
  assert.equal(sourceState.isReplacementMarker, shared.isReplacementMarker);
  assert.equal(
    sourceState.mergeSourceDeletionMarkers,
    shared.mergeDeletionMarkers,
  );
  assert.equal(sourceState.mergeProjectSources, shared.mergeProjectSources);
  assert.equal(sourceState.scheduleSyncClaim, shared.scheduleSyncClaim);
  assert.equal(
    sourceState.SCHEDULED_SYNC_CLAIM_LEASE_MS,
    shared.SCHEDULED_SYNC_CLAIM_LEASE_MS,
  );

  assert.equal(
    workspaceSync.createDeletionMarkers,
    shared.createDeletionMarkers,
  );
  assert.equal(
    workspaceSync.createEmptyTombstones,
    shared.createEmptyTombstones,
  );
  assert.equal(workspaceSync.mergeTombstones, shared.mergeTombstones);
  assert.equal(workspaceSync.normalizeTombstones, shared.normalizeTombstones);

  // The undo-delete pair rides the same seam: what a delete captures and how
  // a restore rebuilds it under fresh ids must be one implementation, or the
  // two apps would resurrect different content from the same deletion.
  assert.equal(
    workspaceSync.captureProjectRestoreSnapshot,
    shared.captureProjectRestoreSnapshot,
  );
  assert.equal(
    workspaceSync.restoreProjectFromSnapshot,
    shared.restoreProjectFromSnapshot,
  );
  assert.equal(
    workspaceSync.PROJECT_RESTORE_WINDOW_MS,
    shared.PROJECT_RESTORE_WINDOW_MS,
  );
});

// Board-stage normalization (the duplicate-name keep+rename rule) must be the
// shared implementation too: desktop's drifted local copy used to silently
// drop duplicate-named columns this app still showed, and the board
// flip-flopped through sync forever.
test("phone board stage rules are the shared implementations", () => {
  assert.equal(boardState.normalizeBoardStages, shared.normalizeBoardStages);
  assert.equal(
    boardState.createDefaultBoardStages,
    shared.createDefaultBoardStages,
  );
});

// Chat-cluster map placement (spacing floor, legacy hash seed, clearance
// placement, stacked-dot repair) must also be the shared implementations —
// positions are synced fields, so a drifted local copy would compute
// different coordinates than desktop and ping-pong through sync forever.
test("phone map placement rules are the shared implementations", () => {
  for (const module_ of [workspaceSync, knowledgeState]) {
    assert.equal(module_.separateStackedClusters, shared.separateStackedClusters);
    assert.equal(module_.positionForNewCluster, shared.positionForNewCluster);
    assert.equal(module_.placeClusterPosition, shared.placeClusterPosition);
    assert.equal(module_.hashPositionForLabel, shared.hashPositionForLabel);
    assert.equal(module_.CLUSTER_SPACING_FLOOR, shared.CLUSTER_SPACING_FLOOR);
    assert.equal(
      module_.CLUSTER_PLACEMENT_CLEARANCE,
      shared.CLUSTER_PLACEMENT_CLEARANCE,
    );
  }
});
