import assert from "node:assert/strict";
import test from "node:test";

import {
  describeLastSync,
  mergeProjectSources,
  mergeSourceDeletionMarkers,
  replaceRefreshedSource,
  sourceRefreshRequest,
} from "./sourceState.ts";

const websiteSource = (overrides = {}) => ({
  id: "source-web",
  projectId: "project-1",
  provider: "website",
  name: "Example Domain",
  url: "https://example.com/",
  status: "connected",
  syncedAt: "2026-08-20T10:00:00.000Z",
  summary: "Example",
  context: "[source:cite_web_old] website: Example",
  citations: [
    {
      id: "cite_web_old",
      provider: "website",
      kind: "website",
      title: "Example Domain",
      url: "https://example.com/",
      excerpt: "Old copy",
      reference: null,
    },
  ],
  clusters: [],
  ...overrides,
});

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
test("a refreshed source replaces its previous snapshot in place", () => {
  const previous = websiteSource();
  const other = websiteSource({ id: "source-other", url: "https://other.test/" });
  const refreshed = websiteSource({
    syncedAt: "2026-08-20T12:00:00.000Z",
    summary: "Example refreshed",
    context: "[source:cite_web_new] website: Example",
    citations: [
      {
        id: "cite_web_new",
        provider: "website",
        kind: "website",
        title: "Example Domain",
        url: "https://example.com/",
        excerpt: "New copy",
        reference: null,
      },
    ],
  });

  const result = replaceRefreshedSource(
    [previous, other],
    previous.id,
    refreshed,
  );

  assert.ok(result);
  assert.equal(result.retiredSourceId, null);
  assert.deepEqual(
    result.sources.map((source) => source.id),
    [previous.id, other.id],
  );
  assert.deepEqual(
    result.sources[0].citations.map((citation) => citation.id),
    ["cite_web_new"],
  );
});

test("a refresh that resolves to a new source id retires the old one", () => {
  const previous = websiteSource();
  const refreshed = websiteSource({
    id: "source-web-renamed",
    url: "https://example.com/docs",
    syncedAt: "2026-08-20T12:00:00.000Z",
  });

  const result = replaceRefreshedSource([previous], previous.id, refreshed);

  assert.ok(result);
  assert.equal(result.retiredSourceId, previous.id);
  assert.deepEqual(
    result.sources.map((source) => source.id),
    [refreshed.id],
  );
});

test("a refresh is discarded when its source was removed or is stale", () => {
  const previous = websiteSource();
  const refreshed = websiteSource({ syncedAt: "2026-08-20T12:00:00.000Z" });

  assert.equal(replaceRefreshedSource([], previous.id, refreshed), null);
  assert.equal(
    replaceRefreshedSource(
      [websiteSource({ syncedAt: "2026-08-20T14:00:00.000Z" })],
      previous.id,
      refreshed,
    ),
    null,
  );
  assert.equal(
    replaceRefreshedSource(
      [previous],
      previous.id,
      websiteSource({ projectId: "project-2" }),
    ),
    null,
  );
});

test("refresh requests reuse the original connect input", () => {
  assert.deepEqual(sourceRefreshRequest(websiteSource()), {
    provider: "website",
    projectId: "project-1",
    url: "https://example.com/",
  });
  assert.deepEqual(
    sourceRefreshRequest(
      websiteSource({
        provider: "github",
        name: "acme/venom",
        url: "https://github.com/acme/venom",
      }),
    ),
    { provider: "github", projectId: "project-1", repository: "acme/venom" },
  );
  assert.deepEqual(
    sourceRefreshRequest(
      websiteSource({
        provider: "github",
        name: "Venom repository",
        url: "https://github.com/acme/venom",
      }),
    ),
    { provider: "github", projectId: "project-1", repository: "acme/venom" },
  );
  assert.equal(
    sourceRefreshRequest(websiteSource({ url: "javascript:alert(1)" })),
    null,
  );
});

test("last sync labels stay readable as a source ages", () => {
  const syncedAt = "2026-08-20T10:00:00.000Z";
  const syncedTime = Date.parse(syncedAt);

  assert.equal(describeLastSync(syncedAt, syncedTime + 5_000), "Last synced just now");
  assert.equal(describeLastSync(syncedAt, syncedTime + 5 * 60_000), "Last synced 5m ago");
  assert.equal(describeLastSync(syncedAt, syncedTime + 3 * 3_600_000), "Last synced 3h ago");
  assert.equal(
    describeLastSync(syncedAt, syncedTime + 2 * 86_400_000),
    "Last synced 2d ago",
  );
  assert.equal(
    describeLastSync(syncedAt, syncedTime + 90 * 86_400_000),
    "Last synced 2026-08-20",
  );
});
