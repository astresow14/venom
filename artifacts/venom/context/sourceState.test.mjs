import assert from "node:assert/strict";
import test from "node:test";

import {
  mergeProjectSources,
  mergeSourceDeletionMarkers,
} from "./sourceState.ts";

test("a device deletion tombstone prevents stale cloud source resurrection", () => {
  const cloudSource = {
    id: "source-1",
    projectId: "project-1",
    provider: "website",
    externalId: "https://example.com/",
    title: "Example Domain",
    url: "https://example.com/",
    status: "connected",
    syncedAt: "2026-08-20T10:00:00.000Z",
    context: "[source:website-1] Example",
    citations: [],
    clusters: [],
  };
  const sourceTombstones = mergeSourceDeletionMarkers(
    2_000,
    [],
    [{ id: cloudSource.id, deletedAt: Date.parse(cloudSource.syncedAt) + 1 }],
  );

  assert.deepEqual(
    mergeProjectSources([cloudSource], [], sourceTombstones),
    [],
  );
  assert.deepEqual(sourceTombstones.map((marker) => marker.id), [
    cloudSource.id,
  ]);
});