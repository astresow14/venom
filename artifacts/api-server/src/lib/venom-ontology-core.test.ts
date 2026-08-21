import assert from "node:assert/strict";
import test from "node:test";
import {
  applyEvidenceHygiene,
  applyInsightCandidates,
  boundTombstonesForInjection,
  injectKnowledgeIntoState,
  MAX_INJECTED_CLUSTERS,
  mergeConceptSets,
  mergeTombstoneRecords,
  ONTOLOGY_BOUNDS,
  positionForLabel,
  readWorkspaceKnowledge,
  reconcileConceptLinks,
  restrictEvidenceAttribution,
  sanitizeConcept,
  sanitizeEvidence,
  stripClustersFromState,
  type OntologyConcept,
  type OntologyTombstone,
} from "./venom-ontology-core";

function concept(overrides: Partial<OntologyConcept> = {}): OntologyConcept {
  return {
    id: "cluster_a",
    projectId: "project_1",
    label: "Alpha",
    category: "topic",
    strength: 0.5,
    x: 10,
    y: -4,
    links: [],
    summary: "Alpha summary",
    mentionCount: 1,
    lastUpdatedAt: 1000,
    sources: [],
    ...overrides,
  };
}

const liveProjects = new Set(["project_1", "project_2"]);

test("merge keeps the newer concept and lets incoming win ties", () => {
  const stored = [
    concept({ id: "c1", label: "Old", lastUpdatedAt: 100 }),
    concept({ id: "c2", label: "Stays", lastUpdatedAt: 300 }),
  ];
  const incoming = [
    concept({ id: "c1", label: "Renamed", lastUpdatedAt: 100 }),
    concept({ id: "c2", label: "Loses", lastUpdatedAt: 200 }),
    concept({ id: "c3", label: "New", lastUpdatedAt: 50 }),
  ];

  const merged = mergeConceptSets({
    stored,
    incoming,
    tombstones: new Map(),
    liveProjectIds: liveProjects,
  });
  const byId = new Map(merged.map((entry) => [entry.id, entry]));

  assert.equal(byId.get("c1")?.label, "Renamed");
  assert.equal(byId.get("c2")?.label, "Stays");
  assert.equal(byId.get("c3")?.label, "New");
});

test("merge treats absence as no-op, not deletion", () => {
  const stored = [concept({ id: "server_only", lastUpdatedAt: 10 })];
  const merged = mergeConceptSets({
    stored,
    incoming: [],
    tombstones: new Map(),
    liveProjectIds: liveProjects,
  });
  assert.equal(merged.length, 1);
});

test("tombstones drop concepts unless the concept is strictly newer", () => {
  const tombstones = new Map<string, OntologyTombstone>([
    ["dead", { id: "dead", deletedAt: 500 }],
    ["alive", { id: "alive", deletedAt: 500 }],
    ["replaced", { id: "replaced", deletedAt: 5, replaced: true }],
  ]);
  const merged = mergeConceptSets({
    stored: [
      concept({ id: "dead", lastUpdatedAt: 500 }),
      concept({ id: "alive", lastUpdatedAt: 501 }),
      concept({ id: "replaced", lastUpdatedAt: 9999 }),
    ],
    incoming: [],
    tombstones,
    liveProjectIds: liveProjects,
  });
  assert.deepEqual(
    merged.map((entry) => entry.id),
    ["alive"],
  );
});

test("merge drops concepts from dead projects but keeps unscoped ones", () => {
  const merged = mergeConceptSets({
    stored: [
      concept({ id: "in_dead", projectId: "gone" }),
      concept({ id: "unscoped", projectId: null }),
    ],
    incoming: [],
    tombstones: new Map(),
    liveProjectIds: liveProjects,
  });
  assert.deepEqual(
    merged.map((entry) => entry.id),
    ["unscoped"],
  );
});

test("links become bidirectional, same-project, never dangling", () => {
  const reconciled = reconcileConceptLinks([
    concept({ id: "a", links: ["b", "cross", "missing", "a"] }),
    concept({ id: "b", links: [] }),
    concept({ id: "cross", projectId: "project_2", links: ["a"] }),
  ]);
  const byId = new Map(reconciled.map((entry) => [entry.id, entry]));
  assert.deepEqual(byId.get("a")?.links, ["b"]);
  assert.deepEqual(byId.get("b")?.links, ["a"]);
  assert.deepEqual(byId.get("cross")?.links, []);
});

test("filing decays same-project strengths and merges by label", () => {
  const existing = concept({
    id: "c_existing",
    label: "GraphQL",
    strength: 0.5,
    mentionCount: 2,
    sources: [
      {
        conversationId: "conv_old",
        projectId: "project_1",
        conversationTitle: "Old chat",
        messageIds: ["m1"],
        excerpt: "old",
        updatedAt: 100,
        capturedByUserId: null,
        capturedAt: null,
      },
    ],
  });
  const bystander = concept({ id: "c_bystander", label: "REST", strength: 0.5 });

  const { concepts, touchedIds } = applyInsightCandidates({
    projectConcepts: [existing, bystander],
    totalConceptCount: 2,
    conversation: { id: "conv_new", title: "New chat", projectId: "project_1" },
    candidates: [
      {
        label: "  GraphQL  ",
        category: "technology",
        confidence: 0.5,
        summary: "GraphQL federation notes",
        sourceMessageIds: ["m9"],
        relatedLabels: ["REST"],
      },
    ],
    now: 5000,
    generateId: () => "cluster_generated",
    capturedByUserId: null,
  });

  const byId = new Map(concepts.map((entry) => [entry.id, entry]));
  const merged = byId.get("c_existing");
  assert.ok(merged);
  assert.equal(merged.mentionCount, 3);
  assert.equal(merged.lastUpdatedAt, 5000);
  assert.equal(merged.category, "technology");
  // 0.5 decays to 0.48, then +0.12 + 0.5 * 0.2 = 0.7
  assert.ok(Math.abs(merged.strength - 0.7) < 1e-9);
  assert.equal(merged.sources[0]?.conversationId, "conv_new");
  assert.equal(merged.sources[1]?.conversationId, "conv_old");

  const decayed = byId.get("c_bystander");
  assert.ok(decayed && Math.abs(decayed.strength - 0.48) < 1e-9);
  // Bystander got linked, so it counts as touched.
  assert.deepEqual(decayed?.links, ["c_existing"]);
  assert.ok(touchedIds.has("c_existing"));
  assert.ok(touchedIds.has("c_bystander"));
});

test("filing creates new concepts with deterministic placement", () => {
  const { concepts, touchedIds } = applyInsightCandidates({
    projectConcepts: [],
    totalConceptCount: 7,
    conversation: { id: "conv", title: "Chat", projectId: null },
    candidates: [
      {
        label: "Vector search",
        category: "",
        confidence: 1,
        summary: "Semantic retrieval",
        sourceMessageIds: ["m1", "m1", "m2"],
        relatedLabels: [],
      },
    ],
    now: 42,
    generateId: () => "cluster_new",
    capturedByUserId: null,
  });

  assert.equal(concepts.length, 1);
  const created = concepts[0]!;
  assert.equal(created.id, "cluster_new");
  assert.equal(created.category, "topic");
  assert.ok(Math.abs(created.strength - 0.76) < 1e-9);
  assert.equal(created.projectId, null);
  assert.deepEqual(created.sources[0]?.messageIds, ["m1", "m2"]);
  const position = positionForLabel("Vector search", 7);
  assert.equal(created.x, position.x);
  assert.equal(created.y, position.y);
  assert.ok(touchedIds.has("cluster_new"));
});

test("filing with no candidates changes nothing", () => {
  const existing = concept({ strength: 0.5 });
  const { concepts, touchedIds } = applyInsightCandidates({
    projectConcepts: [existing],
    totalConceptCount: 1,
    conversation: { id: "conv", title: "Chat", projectId: "project_1" },
    candidates: [],
    now: 10,
    generateId: () => "unused",
    capturedByUserId: null,
  });
  assert.equal(concepts[0]?.strength, 0.5);
  assert.equal(touchedIds.size, 0);
});

test("evidence hygiene removes zombie concepts and tombstones them", () => {
  const zombie = concept({
    id: "zombie",
    lastUpdatedAt: 100,
    sources: [
      {
        conversationId: "conv_deleted",
        projectId: "project_1",
        conversationTitle: "Deleted",
        messageIds: ["m1"],
        excerpt: "gone",
        updatedAt: 100,
        capturedByUserId: null,
        capturedAt: null,
      },
    ],
  });
  const survivor = concept({
    id: "survivor",
    lastUpdatedAt: 900,
    sources: [
      {
        conversationId: "conv_deleted",
        projectId: "project_1",
        conversationTitle: "Deleted",
        messageIds: ["m1"],
        excerpt: "gone",
        updatedAt: 100,
        capturedByUserId: null,
        capturedAt: null,
      },
    ],
  });
  const clientOwned = concept({
    id: "client_owned",
    lastUpdatedAt: 100,
    sources: zombie.sources,
  });

  const result = applyEvidenceHygiene({
    concepts: [zombie, survivor, clientOwned],
    incomingConceptIds: new Set(["client_owned"]),
    conversationDeletionTimes: new Map([["conv_deleted", 500]]),
  });

  const ids = result.concepts.map((entry) => entry.id).sort();
  assert.deepEqual(ids, ["client_owned", "survivor"]);
  assert.deepEqual(result.droppedConcepts, [
    { id: "zombie", deletedAt: 500 },
  ]);
  const keptSurvivor = result.concepts.find((entry) => entry.id === "survivor");
  assert.deepEqual(keptSurvivor?.sources, []);
  const keptClient = result.concepts.find(
    (entry) => entry.id === "client_owned",
  );
  assert.equal(keptClient?.sources.length, 1);
});

test("injection caps clusters, sorts newest first, and unions tombstones", () => {
  const state = {
    projects: [],
    clusters: [{ ignored: true }],
    tombstones: {
      clusters: [{ id: "t1", deletedAt: 50 }],
      conversations: [],
    },
  };

  const many = Array.from({ length: MAX_INJECTED_CLUSTERS + 5 }, (_, index) =>
    concept({ id: `c${index}`, lastUpdatedAt: index }),
  );
  const injected = injectKnowledgeIntoState(state, many, [
    { id: "t1", deletedAt: 10, replaced: true },
    { id: "t2", deletedAt: 99 },
  ]) as {
    clusters: OntologyConcept[];
    tombstones: { clusters: OntologyTombstone[] };
  };

  assert.equal(injected.clusters.length, MAX_INJECTED_CLUSTERS);
  assert.equal(injected.clusters[0]?.id, `c${MAX_INJECTED_CLUSTERS + 4}`);
  const markers = new Map(
    injected.tombstones.clusters.map((marker) => [marker.id, marker]),
  );
  // Newest deletion time wins, replaced flag is sticky.
  assert.deepEqual(markers.get("t1"), { id: "t1", deletedAt: 50, replaced: true });
  assert.deepEqual(markers.get("t2"), { id: "t2", deletedAt: 99 });
});

test("tombstone bounding keeps replacement markers under pressure", () => {
  const markers: OntologyTombstone[] = [
    { id: "r1", deletedAt: 1, replaced: true },
    { id: "d1", deletedAt: 100 },
    { id: "d2", deletedAt: 99 },
  ];
  const bounded = boundTombstonesForInjection(markers, 2);
  assert.deepEqual(
    bounded.map((marker) => marker.id).sort(),
    ["d1", "r1"],
  );
});

test("merge of tombstone records keeps newest time and sticky replaced", () => {
  const merged = mergeTombstoneRecords(
    { id: "x", deletedAt: 10, replaced: true },
    { id: "x", deletedAt: 20 },
  );
  assert.deepEqual(merged, { id: "x", deletedAt: 20, replaced: true });
});

test("sanitizeConcept bounds oversized fields and drops garbage", () => {
  assert.equal(sanitizeConcept(null), null);
  assert.equal(sanitizeConcept({ label: "no id" }), null);

  const raw = {
    id: "c1",
    projectId: null,
    label: "L".repeat(500),
    category: 7,
    strength: 42,
    x: Number.NaN,
    y: 3,
    links: ["a", "a", "", 5, "b"],
    summary: "S".repeat(5000),
    mentionCount: 2.7,
    lastUpdatedAt: -5,
    sources: [
      {
        conversationId: "conv",
        projectId: null,
        conversationTitle: "",
        messageIds: ["m1", "m1", 3],
        excerpt: "E".repeat(9000),
        updatedAt: 12,
      },
      { missing: "conversationId" },
    ],
  };
  const sanitized = sanitizeConcept(raw);
  assert.ok(sanitized);
  assert.equal(sanitized.label.length, 200);
  assert.equal(sanitized.category, "topic");
  assert.equal(sanitized.strength, 1);
  assert.equal(sanitized.x, 0);
  assert.deepEqual(sanitized.links, ["a", "b"]);
  assert.equal(sanitized.summary.length, 2000);
  assert.equal(sanitized.mentionCount, 3);
  assert.equal(sanitized.lastUpdatedAt, 0);
  assert.equal(sanitized.sources.length, 1);
  assert.equal(sanitized.sources[0]?.conversationTitle, "Conversation");
  assert.deepEqual(sanitized.sources[0]?.messageIds, ["m1"]);
  assert.equal(sanitized.sources[0]?.excerpt.length, 2000);
});

test("readWorkspaceKnowledge extracts concepts, tombstones, and projects", () => {
  const view = readWorkspaceKnowledge({
    projects: [{ id: "p1" }, { nope: true }, { id: "p2" }],
    clusters: [concept({ id: "c1" }), null, { junk: true }],
    tombstones: {
      clusters: [{ id: "c9", deletedAt: 5 }, { bad: true }],
      conversations: [
        { id: "conv1", deletedAt: 10 },
        { id: "conv1", deletedAt: 30 },
      ],
    },
  });
  assert.equal(view.concepts.length, 1);
  assert.deepEqual(view.conceptTombstones, [{ id: "c9", deletedAt: 5 }]);
  assert.equal(view.conversationDeletionTimes.get("conv1"), 30);
  assert.deepEqual([...view.liveProjectIds].sort(), ["p1", "p2"]);
});

test("stripClustersFromState empties clusters and keeps everything else", () => {
  const stripped = stripClustersFromState({
    clusters: [1, 2, 3],
    projects: ["p"],
  }) as { clusters: unknown[]; projects: string[] };
  assert.deepEqual(stripped.clusters, []);
  assert.deepEqual(stripped.projects, ["p"]);
});

test("filing stamps evidence with the capturing identity", () => {
  const existing = concept({
    id: "c_existing",
    label: "GraphQL",
    sources: [
      {
        conversationId: "conv_old",
        projectId: "project_1",
        conversationTitle: "Old chat",
        messageIds: ["m1"],
        excerpt: "old",
        updatedAt: 100,
        capturedByUserId: null,
        capturedAt: null,
      },
    ],
  });

  const { concepts } = applyInsightCandidates({
    projectConcepts: [existing],
    totalConceptCount: 1,
    conversation: { id: "conv_new", title: "New chat", projectId: "project_1" },
    candidates: [
      {
        label: "GraphQL",
        category: "technology",
        confidence: 1,
        summary: "Federation",
        sourceMessageIds: ["m9"],
        relatedLabels: [],
      },
      {
        label: "Brand new",
        category: "idea",
        confidence: 0.9,
        summary: "Fresh concept",
        sourceMessageIds: ["m10"],
        relatedLabels: [],
      },
    ],
    now: 5000,
    generateId: () => "cluster_stamped",
    capturedByUserId: "user_speaker",
  });

  const merged = concepts.find((entry) => entry.id === "c_existing");
  const created = concepts.find((entry) => entry.id === "cluster_stamped");
  assert.ok(merged && created);
  // The new conversation's evidence carries the stamp; the old
  // conversation's pre-attribution evidence is untouched.
  const fresh = merged.sources.find((s) => s.conversationId === "conv_new");
  const old = merged.sources.find((s) => s.conversationId === "conv_old");
  assert.equal(fresh?.capturedByUserId, "user_speaker");
  assert.equal(fresh?.capturedAt, 5000);
  assert.equal(old?.capturedByUserId, null);
  assert.equal(old?.capturedAt, null);
  assert.equal(created.sources[0]?.capturedByUserId, "user_speaker");
  assert.equal(created.sources[0]?.capturedAt, 5000);
});

test("sanitizeEvidence bounds capture stamps and drops orphan timestamps", () => {
  const base = {
    conversationId: "conv",
    projectId: "p1",
    conversationTitle: "Chat",
    messageIds: ["m1"],
    excerpt: "text",
    updatedAt: 100,
  };

  const stamped = sanitizeEvidence({
    ...base,
    capturedByUserId: "user_a",
    capturedAt: 123.7,
  });
  assert.equal(stamped?.capturedByUserId, "user_a");
  assert.equal(stamped?.capturedAt, 124);

  // Oversized ids are bounded like every other evidence field.
  const oversized = sanitizeEvidence({
    ...base,
    capturedByUserId: "u".repeat(500),
    capturedAt: 50,
  });
  assert.equal(
    oversized?.capturedByUserId?.length,
    ONTOLOGY_BOUNDS.capturedByUserId,
  );

  // A capture time without a capturing identity means nothing.
  const orphanTime = sanitizeEvidence({ ...base, capturedAt: 50 });
  assert.equal(orphanTime?.capturedByUserId, null);
  assert.equal(orphanTime?.capturedAt, null);

  // Garbage timestamps collapse to pre-attribution time.
  const garbage = sanitizeEvidence({
    ...base,
    capturedByUserId: "user_a",
    capturedAt: Number.NaN,
  });
  assert.equal(garbage?.capturedByUserId, "user_a");
  assert.equal(garbage?.capturedAt, null);

  // Legacy evidence stays recognizable as pre-attribution.
  const legacy = sanitizeEvidence(base);
  assert.equal(legacy?.capturedByUserId, null);
  assert.equal(legacy?.capturedAt, null);
});

test("restrictEvidenceAttribution strips stamps that name anyone else", () => {
  const stamped = (capturedByUserId: string | null) => ({
    conversationId: "conv",
    projectId: "project_1" as string | null,
    conversationTitle: "Chat",
    messageIds: ["m1"],
    excerpt: "text",
    updatedAt: 100,
    capturedByUserId,
    capturedAt: capturedByUserId === null ? null : 100,
  });
  const concepts = [
    concept({ id: "clean", sources: [stamped("user_owner"), stamped(null)] }),
    concept({ id: "forged", sources: [stamped("user_intruder")] }),
  ];

  const restricted = restrictEvidenceAttribution(
    concepts,
    new Set(["user_owner"]),
  );

  const clean = restricted.find((entry) => entry.id === "clean");
  const forged = restricted.find((entry) => entry.id === "forged");
  // Concepts with only allowed stamps keep their identity (same reference);
  // the owner's stamp and pre-attribution evidence pass through.
  assert.equal(clean, concepts[0]);
  assert.equal(forged?.sources[0]?.capturedByUserId, null);
  assert.equal(forged?.sources[0]?.capturedAt, null);
});
