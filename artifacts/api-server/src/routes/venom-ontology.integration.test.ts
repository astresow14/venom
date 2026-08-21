/**
 * Real-database integration tests for the Venom ontology store: lazy
 * blob-to-store migration, workspace-save reconciliation, server-side
 * filing, and the query API.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { and, eq } from "drizzle-orm";
import {
  db,
  pool,
  venomOntologyConceptsTable,
  venomOntologyEvidenceTable,
  venomOntologyLinksTable,
  venomOntologyOwnersTable,
  venomOntologyTombstonesTable,
  venomWorkspacesTable,
} from "@workspace/db";
import {
  absorbWorkspaceStateKnowledge,
  ensureOntologyOwner,
  fileExtractedKnowledge,
  getOntologyConceptDetail,
  hydrateWorkspaceStateWithKnowledge,
  searchOntologyConcepts,
  userOwner,
} from "../lib/venom-ontology-store";

const testUserIds: string[] = [];

function freshUserId(): string {
  const userId = `ontotest_${randomUUID()}`;
  testUserIds.push(userId);
  return userId;
}

async function cleanup() {
  for (const userId of testUserIds) {
    await db
      .delete(venomOntologyConceptsTable)
      .where(eq(venomOntologyConceptsTable.ownerId, userId));
    await db
      .delete(venomOntologyEvidenceTable)
      .where(eq(venomOntologyEvidenceTable.ownerId, userId));
    await db
      .delete(venomOntologyLinksTable)
      .where(eq(venomOntologyLinksTable.ownerId, userId));
    await db
      .delete(venomOntologyTombstonesTable)
      .where(eq(venomOntologyTombstonesTable.ownerId, userId));
    await db
      .delete(venomOntologyOwnersTable)
      .where(eq(venomOntologyOwnersTable.ownerId, userId));
    await db
      .delete(venomWorkspacesTable)
      .where(eq(venomWorkspacesTable.clerkUserId, userId));
  }
}

test.after(async () => {
  await cleanup();
  await pool.end();
});

const evidence = (conversationId: string, updatedAt: number) => ({
  conversationId,
  projectId: "p1",
  conversationTitle: "Chat",
  messageIds: ["m1", "m2"],
  excerpt: "Discussed in depth",
  updatedAt,
});

const cluster = (
  id: string,
  label: string,
  lastUpdatedAt: number,
  overrides: Record<string, unknown> = {},
) => ({
  id,
  projectId: "p1",
  label,
  category: "topic",
  strength: 0.6,
  x: 1,
  y: 2,
  links: [],
  summary: `${label} summary`,
  mentionCount: 1,
  lastUpdatedAt,
  sources: [evidence(`conv_${id}`, lastUpdatedAt)],
  ...overrides,
});

const workspaceState = (
  clusters: unknown[],
  overrides: Record<string, unknown> = {},
) => ({
  projects: [{ id: "p1", name: "Project One" }],
  conversations: [],
  clusters,
  tombstones: { clusters: [], conversations: [] },
  ...overrides,
});

test("lazy migration imports blob knowledge exactly once", async () => {
  const userId = freshUserId();
  const state = workspaceState([
    cluster("c1", "Alpha", 100, { links: ["c2"] }),
    cluster("c2", "Beta", 100, { links: ["c1"] }),
    cluster("c_dead", "Dead", 100),
  ]);
  (state.tombstones as { clusters: unknown[] }).clusters = [
    { id: "c_dead", deletedAt: 100 },
  ];

  await db.insert(venomWorkspacesTable).values({
    clerkUserId: userId,
    state,
    revision: 3,
  });

  const first = await ensureOntologyOwner(userOwner(userId));
  assert.equal(first.migrated, true);
  assert.equal(first.importedConceptCount, 2);

  // Idempotent: a second call never re-imports.
  const second = await ensureOntologyOwner(userOwner(userId));
  assert.equal(second.migrated, false);

  // Even after concepts are removed, the marker prevents re-import.
  await db
    .delete(venomOntologyConceptsTable)
    .where(eq(venomOntologyConceptsTable.ownerId, userId));
  const third = await ensureOntologyOwner(userOwner(userId));
  assert.equal(third.migrated, false);
  const remaining = await db
    .select()
    .from(venomOntologyConceptsTable)
    .where(eq(venomOntologyConceptsTable.ownerId, userId));
  assert.equal(remaining.length, 0);
});

test("hydrate injects stored concepts and tombstones into a stripped state", async () => {
  const userId = freshUserId();
  const state = workspaceState([cluster("c1", "Alpha", 100)]);
  await db.insert(venomWorkspacesTable).values({
    clerkUserId: userId,
    state,
    revision: 1,
  });
  await ensureOntologyOwner(userOwner(userId));

  const hydrated = (await hydrateWorkspaceStateWithKnowledge(
    userId,
    workspaceState([]),
  )) as {
    clusters: { id: string; label: string; sources: unknown[] }[];
  };
  assert.equal(hydrated.clusters.length, 1);
  assert.equal(hydrated.clusters[0]?.label, "Alpha");
  assert.equal(hydrated.clusters[0]?.sources.length, 1);
});

test("absorb reconciles renames, deletions, and never resurrects", async () => {
  const userId = freshUserId();
  await db.insert(venomWorkspacesTable).values({
    clerkUserId: userId,
    state: workspaceState([
      cluster("c1", "Alpha", 100),
      cluster("c2", "Beta", 100),
    ]),
    revision: 1,
  });
  await ensureOntologyOwner(userOwner(userId));

  // Device A renames c1 (newer) and deletes c2 (tombstone).
  const deviceState = workspaceState(
    [cluster("c1", "Alpha Prime", 200)],
    {
      tombstones: {
        clusters: [{ id: "c2", deletedAt: 300 }],
        conversations: [],
      },
    },
  );
  const absorbed = (await absorbWorkspaceStateKnowledge(
    userId,
    deviceState,
  )) as {
    clusters: { id: string; label: string }[];
    tombstones: { clusters: { id: string }[] };
  };

  assert.deepEqual(
    absorbed.clusters.map((entry) => `${entry.id}:${entry.label}`),
    ["c1:Alpha Prime"],
  );
  assert.ok(
    absorbed.tombstones.clusters.some((marker) => marker.id === "c2"),
  );

  // Device B, unaware, uploads the stale Beta again with the SAME timestamp:
  // the tombstone wins, no resurrection.
  const staleState = workspaceState([
    cluster("c1", "Alpha Prime", 200),
    cluster("c2", "Beta", 100),
  ]);
  const afterStale = (await absorbWorkspaceStateKnowledge(
    userId,
    staleState,
  )) as { clusters: { id: string }[] };
  assert.deepEqual(
    afterStale.clusters.map((entry) => entry.id),
    ["c1"],
  );

  // A genuinely newer c2 (post-deletion edit) may return.
  const revived = (await absorbWorkspaceStateKnowledge(
    userId,
    workspaceState([cluster("c2", "Beta Reborn", 400)]),
  )) as { clusters: { id: string; label: string }[] };
  assert.ok(
    revived.clusters.some((entry) => entry.label === "Beta Reborn"),
  );
});

test("absorb applies evidence hygiene to server-only concepts", async () => {
  const userId = freshUserId();
  await ensureOntologyOwner(userOwner(userId));

  // Server files a concept anchored to a conversation the device deleted
  // before it ever saw the concept.
  await fileExtractedKnowledge({
    owner: userOwner(userId),
    capturedByUserId: userId,
    conversation: { id: "conv_gone", title: "Doomed chat", projectId: null },
    candidates: [
      {
        label: "Zombie topic",
        category: "topic",
        confidence: 0.9,
        summary: "Filed from a conversation that is about to be deleted",
        sourceMessageIds: ["m1"],
        relatedLabels: [],
      },
    ],
    now: 1000,
  });

  const deviceState = workspaceState([], {
    projects: [],
    tombstones: {
      clusters: [],
      conversations: [{ id: "conv_gone", deletedAt: 2000 }],
    },
  });
  const absorbed = (await absorbWorkspaceStateKnowledge(
    userId,
    deviceState,
  )) as {
    clusters: unknown[];
    tombstones: { clusters: { id: string }[] };
  };
  assert.equal(absorbed.clusters.length, 0);
  assert.equal(absorbed.tombstones.clusters.length, 1);
});

test("server-side filing creates, merges, links, and decays", async () => {
  const userId = freshUserId();
  await ensureOntologyOwner(userOwner(userId));

  const first = await fileExtractedKnowledge({
    owner: userOwner(userId),
    capturedByUserId: userId,
    conversation: { id: "conv1", title: "Kickoff", projectId: "p1" },
    candidates: [
      {
        label: "GraphQL",
        category: "technology",
        confidence: 0.5,
        summary: "API layer decision",
        sourceMessageIds: ["m1"],
        relatedLabels: ["Caching"],
      },
      {
        label: "Caching",
        category: "technology",
        confidence: 0.5,
        summary: "Response caching",
        sourceMessageIds: ["m2"],
        relatedLabels: [],
      },
    ],
    now: 1000,
  });
  assert.equal(first.filed.length, 2);
  const graphql = first.filed.find((entry) => entry.label === "GraphQL");
  const caching = first.filed.find((entry) => entry.label === "Caching");
  assert.ok(graphql && caching);
  assert.deepEqual(graphql.links, [caching.id]);
  assert.deepEqual(caching.links, [graphql.id]);

  // Refiling the same label merges and strengthens instead of duplicating.
  const second = await fileExtractedKnowledge({
    owner: userOwner(userId),
    capturedByUserId: userId,
    conversation: { id: "conv2", title: "Deep dive", projectId: "p1" },
    candidates: [
      {
        label: "graphql",
        category: "technology",
        confidence: 1,
        summary: "Federation rollout",
        sourceMessageIds: ["m9"],
        relatedLabels: [],
      },
    ],
    now: 2000,
  });
  assert.equal(second.filed.length, 1);
  const merged = second.filed[0]!;
  assert.equal(merged.id, graphql.id);
  assert.equal(merged.mentionCount, 2);
  assert.equal(merged.sources.length, 2);
  assert.equal(merged.sources[0]?.conversationId, "conv2");

  const rows = await db
    .select()
    .from(venomOntologyConceptsTable)
    .where(eq(venomOntologyConceptsTable.ownerId, userId));
  assert.equal(rows.length, 2);
  const cachingRow = rows.find((row) => row.conceptId === caching.id);
  // Caching was created at 0.34 + 0.5 * 0.42 = 0.55, then decayed by the
  // second filing: 0.55 * 0.96.
  assert.ok(cachingRow && Math.abs(cachingRow.strength - 0.55 * 0.96) < 1e-9);
});

test("search and concept detail expose the stored ontology", async () => {
  const userId = freshUserId();
  await ensureOntologyOwner(userOwner(userId));
  await fileExtractedKnowledge({
    owner: userOwner(userId),
    capturedByUserId: userId,
    conversation: { id: "conv1", title: "Planning", projectId: "p1" },
    candidates: [
      {
        label: "Payment reconciliation",
        category: "process",
        confidence: 0.8,
        summary: "Nightly settlement matching",
        sourceMessageIds: ["m1"],
        relatedLabels: ["Ledger"],
      },
      {
        label: "Ledger",
        category: "system",
        confidence: 0.6,
        summary: "Double-entry source of truth",
        sourceMessageIds: ["m2"],
        relatedLabels: [],
      },
    ],
    now: 1000,
  });
  await fileExtractedKnowledge({
    owner: userOwner(userId),
    capturedByUserId: userId,
    conversation: { id: "conv2", title: "Other project", projectId: "p2" },
    candidates: [
      {
        label: "Payment gateway",
        category: "technology",
        confidence: 0.7,
        summary: "Stripe adapter",
        sourceMessageIds: ["m3"],
        relatedLabels: [],
      },
    ],
    now: 2000,
  });

  // Cross-project search finds both payment concepts.
  const results = await searchOntologyConcepts(userId, "payment", 10);
  assert.equal(results.length, 2);
  const projectIds = new Set(results.map((entry) => entry.projectId));
  assert.deepEqual([...projectIds].sort(), ["p1", "p2"]);
  assert.ok(results.every((entry) => entry.evidenceCount === 1));

  // Summary text matches too.
  const bySummary = await searchOntologyConcepts(userId, "settlement", 10);
  assert.equal(bySummary.length, 1);
  assert.equal(bySummary[0]?.label, "Payment reconciliation");

  // Detail returns evidence and neighbors.
  const detail = await getOntologyConceptDetail(userId, bySummary[0]!.id);
  assert.ok(detail);
  assert.equal(detail.concept.sources.length, 1);
  assert.equal(detail.concept.sources[0]?.conversationId, "conv1");
  assert.equal(detail.neighbors.length, 1);
  assert.equal(detail.neighbors[0]?.label, "Ledger");

  const missing = await getOntologyConceptDetail(userId, "nope");
  assert.equal(missing, null);

  // LIKE wildcards in queries are escaped, not interpreted.
  const wildcard = await searchOntologyConcepts(userId, "%", 10);
  assert.equal(wildcard.length, 0);
});

test("filing stamps evidence rows with the initiating identity", async () => {
  const userId = freshUserId();
  await ensureOntologyOwner(userOwner(userId));
  await fileExtractedKnowledge({
    owner: userOwner(userId),
    capturedByUserId: userId,
    conversation: { id: "conv_att", title: "Attributed chat", projectId: "p1" },
    candidates: [
      {
        label: "Attribution",
        category: "topic",
        confidence: 0.9,
        summary: "Who said it",
        sourceMessageIds: ["m1"],
        relatedLabels: [],
      },
    ],
    now: 4321,
  });

  const rows = await db
    .select()
    .from(venomOntologyEvidenceTable)
    .where(eq(venomOntologyEvidenceTable.ownerId, userId));
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.capturedByUserId, userId);
  assert.equal(rows[0]?.capturedAt, 4321);

  // The stored stamp round-trips through search + detail lookups.
  const results = await searchOntologyConcepts(userId, "Attribution", 5);
  assert.equal(results.length, 1);
  const detail = await getOntologyConceptDetail(userId, results[0]!.id);
  assert.equal(detail?.concept.sources[0]?.capturedByUserId, userId);
  assert.equal(detail?.concept.sources[0]?.capturedAt, 4321);
});

test("filing refuses a capture identity that is not the owner", async () => {
  const userId = freshUserId();
  const intruder = freshUserId();
  await ensureOntologyOwner(userOwner(userId));

  await assert.rejects(
    fileExtractedKnowledge({
      owner: userOwner(userId),
      capturedByUserId: intruder,
      conversation: { id: "conv_bad", title: "Bad", projectId: "p1" },
      candidates: [
        {
          label: "Hijack",
          category: "topic",
          confidence: 0.9,
          summary: "Should never land",
          sourceMessageIds: ["m1"],
          relatedLabels: [],
        },
      ],
      now: 1,
    }),
    /does not match the ontology owner/,
  );

  const rows = await db
    .select()
    .from(venomOntologyConceptsTable)
    .where(eq(venomOntologyConceptsTable.ownerId, userId));
  assert.equal(rows.length, 0);
});

test("absorb strips forged capture stamps but keeps the owner's", async () => {
  const userId = freshUserId();
  await ensureOntologyOwner(userOwner(userId));

  const state = workspaceState([
    cluster("cl_own", "Owned stamp", 1000, {
      sources: [
        {
          ...evidence("conv_own", 1000),
          capturedByUserId: userId,
          capturedAt: 900,
        },
      ],
    }),
    cluster("cl_forged", "Forged stamp", 1000, {
      sources: [
        {
          ...evidence("conv_forged", 1000),
          capturedByUserId: "user_somebody_else",
          capturedAt: 900,
        },
      ],
    }),
  ]);

  await absorbWorkspaceStateKnowledge(userId, state);

  const rows = await db
    .select()
    .from(venomOntologyEvidenceTable)
    .where(eq(venomOntologyEvidenceTable.ownerId, userId));
  const own = rows.find((row) => row.conversationId === "conv_own");
  const forged = rows.find((row) => row.conversationId === "conv_forged");
  assert.ok(own && forged);
  assert.equal(own.capturedByUserId, userId);
  assert.equal(own.capturedAt, 900);
  assert.equal(forged.capturedByUserId, null);
  assert.equal(forged.capturedAt, null);
});
