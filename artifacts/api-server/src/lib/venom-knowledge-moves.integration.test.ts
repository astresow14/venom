/**
 * Real-database integration tests for the knowledge auto-sort machinery:
 * classified filing (with the post-model membership re-check), the
 * author-private Unsorted state, safe moves between stores, undo (with its
 * 24h window and changed-since drift guard), the re-filing pass's
 * deterministic signals, and suggestion lifecycle.
 *
 * Everything runs against the store seams directly — no model calls — so
 * the suite stays provider-hermetic like the rest of the api-server tests.
 */
import assert from "node:assert/strict";
import { workspaceTopicDigest } from "./venom-scope-classification";
import { randomUUID } from "node:crypto";
import test from "node:test";
import {
  db,
  pool,
  venomKnowledgeMovesTable,
  venomOntologyConceptsTable,
  venomOntologyEvidenceTable,
  venomOntologyLinksTable,
  venomOntologyOwnersTable,
  venomOntologyTombstonesTable,
  venomSharedWorkspaceMembersTable,
  venomSharedWorkspacesTable,
} from "@workspace/db";
import { inArray, sql } from "drizzle-orm";
import {
  fileExtractedKnowledge,
  loadOntologyConcepts,
  loadOntologyForOwner,
  moveOntologyConceptBetweenOwners,
  userOwner,
  workspaceOwner,
} from "./venom-ontology-store.js";
import { performClassifiedFiling } from "./venom-knowledge-filing.js";
import { runKnowledgeRefilingPass } from "./venom-knowledge-refiling.js";
import {
  acceptKnowledgeSuggestion,
  dismissKnowledgeSuggestion,
  dismissMovesForWorkspace,
  getKnowledgeMove,
  listKnowledgeMoves,
  recordRefileNotice,
  undoKnowledgeMove,
  UNDO_WINDOW_MS,
} from "./venom-knowledge-moves.js";

async function ensureMovesTestSchema(): Promise<void> {
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS venom_shared_workspaces (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      name text NOT NULL,
      created_by_clerk_user_id text NOT NULL,
      allow_sensitive_export boolean NOT NULL DEFAULT true,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    )
  `);
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS venom_shared_workspace_members (
      workspace_id uuid NOT NULL
        REFERENCES venom_shared_workspaces(id) ON DELETE CASCADE,
      clerk_user_id text NOT NULL,
      role text NOT NULL DEFAULT 'member',
      added_by_clerk_user_id text NOT NULL,
      added_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT venom_shared_workspace_members_pk
        PRIMARY KEY (workspace_id, clerk_user_id)
    )
  `);
  await db.execute(sql`
    ALTER TABLE venom_ontology_concepts
      ADD COLUMN IF NOT EXISTS admin_only boolean NOT NULL DEFAULT false
  `);
  await db.execute(sql`
    ALTER TABLE venom_ontology_concepts
      ADD COLUMN IF NOT EXISTS unsorted boolean NOT NULL DEFAULT false
  `);
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS venom_knowledge_moves (
      id text PRIMARY KEY,
      user_id text NOT NULL,
      kind text NOT NULL,
      status text NOT NULL,
      from_owner_type text NOT NULL,
      from_owner_id text NOT NULL,
      to_owner_type text NOT NULL,
      to_owner_id text NOT NULL,
      workspace_id text,
      workspace_name text,
      labels jsonb NOT NULL,
      payload jsonb NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      resolved_at timestamptz
    )
  `);
}

const candidate = (label: string, confidence = 0.8) => ({
  label,
  category: "topic",
  confidence,
  summary: `${label} summary`,
  sourceMessageIds: ["m1"],
  relatedLabels: [],
});

const conversation = (suffix: string, projectId: string | null = null) => ({
  id: `conv-${suffix}`,
  title: `Conversation ${suffix}`,
  projectId,
});

const createdUserIds: string[] = [];
const createdWorkspaceIds: string[] = [];

async function createWorkspace(
  name: string,
  adminUserId: string,
  memberUserId?: string,
): Promise<string> {
  const [row] = await db
    .insert(venomSharedWorkspacesTable)
    .values({ name, createdByClerkUserId: adminUserId })
    .returning({ id: venomSharedWorkspacesTable.id });
  assert.ok(row);
  createdWorkspaceIds.push(row.id);
  await db.insert(venomSharedWorkspaceMembersTable).values({
    workspaceId: row.id,
    clerkUserId: adminUserId,
    role: "admin",
    addedByClerkUserId: adminUserId,
  });
  if (memberUserId) {
    await db.insert(venomSharedWorkspaceMembersTable).values({
      workspaceId: row.id,
      clerkUserId: memberUserId,
      role: "member",
      addedByClerkUserId: adminUserId,
    });
  }
  return row.id;
}

test.after(async () => {
  const ownerIds = [...new Set([...createdUserIds, ...createdWorkspaceIds])];
  if (ownerIds.length > 0) {
    await db
      .delete(venomOntologyConceptsTable)
      .where(inArray(venomOntologyConceptsTable.ownerId, ownerIds));
    await db
      .delete(venomOntologyEvidenceTable)
      .where(inArray(venomOntologyEvidenceTable.ownerId, ownerIds));
    await db
      .delete(venomOntologyLinksTable)
      .where(inArray(venomOntologyLinksTable.ownerId, ownerIds));
    await db
      .delete(venomOntologyTombstonesTable)
      .where(inArray(venomOntologyTombstonesTable.ownerId, ownerIds));
    await db
      .delete(venomOntologyOwnersTable)
      .where(inArray(venomOntologyOwnersTable.ownerId, ownerIds));
  }
  if (createdUserIds.length > 0) {
    await db
      .delete(venomKnowledgeMovesTable)
      .where(inArray(venomKnowledgeMovesTable.userId, createdUserIds));
  }
  if (createdWorkspaceIds.length > 0) {
    await db
      .delete(venomSharedWorkspacesTable)
      .where(inArray(venomSharedWorkspacesTable.id, createdWorkspaceIds));
  }
  await pool.end();
});

test("unsorted is a personal-store state: workspace writes strip it", async () => {
  await ensureMovesTestSchema();
  const suffix = randomUUID();
  const userId = `km-privacy-${suffix}`;
  createdUserIds.push(userId);
  const wsId = await createWorkspace(`Privacy Co ${suffix}`, userId);

  await fileExtractedKnowledge({
    owner: userOwner(userId),
    capturedByUserId: userId,
    conversation: conversation(suffix),
    candidates: [{ ...candidate("Held back idea"), unsorted: true }],
  });
  const personal = await loadOntologyConcepts(userOwner(userId));
  const held = personal.find((c) => c.label === "Held back idea");
  assert.ok(held);
  assert.equal(held!.unsorted, true, "personal store keeps the unsorted flag");

  await fileExtractedKnowledge({
    owner: workspaceOwner(wsId),
    capturedByUserId: userId,
    conversation: { ...conversation(suffix), projectId: null },
    candidates: [{ ...candidate("Shared process"), unsorted: true }],
  });
  const shared = await loadOntologyConcepts(workspaceOwner(wsId));
  const process = shared.find((c) => c.label === "Shared process");
  assert.ok(process);
  assert.notEqual(
    process!.unsorted,
    true,
    "a workspace row can never carry the author-private unsorted state",
  );
});

test("classified filing routes by validated scope and re-checks membership", async () => {
  await ensureMovesTestSchema();
  const suffix = randomUUID();
  const userId = `km-filing-${suffix}`;
  createdUserIds.push(userId);
  const wsLive = await createWorkspace(`Live Co ${suffix}`, userId);
  // A workspace that was in the membership list when the model ran, but
  // whose membership vanished before filing: the re-check must demote.
  const wsGhostId = randomUUID();

  const memberships = [
    { workspaceId: wsLive, workspaceName: `Live Co ${suffix}`, role: "admin" as const },
    { workspaceId: wsGhostId, workspaceName: "Ghost Co", role: "member" as const },
  ];

  const result = await performClassifiedFiling({
    userId,
    conversation: conversation(suffix, "proj-1"),
    clusters: [
      { ...candidate("Personal habit"), scope: "personal", scopeConfidence: 0.9 },
      { ...candidate("Live client playbook"), scope: wsLive, scopeConfidence: 0.95 },
      { ...candidate("Maybe live topic"), scope: wsLive, scopeConfidence: 0.6 },
      { ...candidate("Invented target"), scope: randomUUID(), scopeConfidence: 1 },
      { ...candidate("No verdict at all") },
      { ...candidate("Ghost material"), scope: wsGhostId, scopeConfidence: 0.99 },
    ],
    memberships,
  });

  assert.deepEqual(result.personalLabels, ["Personal habit"]);
  assert.deepEqual(
    [...result.unsortedLabels].sort(),
    ["Ghost material", "Invented target", "Maybe live topic", "No verdict at all"],
    "low confidence, unknown ids, missing verdicts, and failed re-checks all hold",
  );
  assert.equal(result.workspaceFilings.length, 1);
  const filing = result.workspaceFilings[0]!;
  assert.equal(filing.workspaceId, wsLive);
  assert.deepEqual(filing.labels, ["Live client playbook"]);

  const personal = await loadOntologyConcepts(userOwner(userId));
  const byLabel = new Map(personal.map((c) => [c.label, c]));
  assert.equal(byLabel.get("Personal habit")?.unsorted ?? false, false);
  for (const label of result.unsortedLabels) {
    assert.equal(byLabel.get(label)?.unsorted, true, `${label} must hold in Unsorted`);
  }
  assert.ok(!byLabel.has("Live client playbook"), "workspace material stays out of the personal store");

  const shared = await loadOntologyConcepts(workspaceOwner(wsLive));
  assert.ok(shared.some((c) => c.label === "Live client playbook"));
  const ghost = await loadOntologyConcepts(workspaceOwner(wsGhostId));
  assert.equal(ghost.length, 0, "nothing may reach a store the author is not a member of");

  // The workspace filing is visible to its author as an undoable notice.
  const moves = await listKnowledgeMoves(userId);
  assert.equal(moves.notices.length, 1);
  assert.equal(moves.notices[0]!.kind, "auto_file");
  assert.equal(moves.notices[0]!.status, "active");
  assert.equal(moves.notices[0]!.id, filing.noticeId);

  // Undo: the workspace store returns to its prior state and the clusters
  // land in the author's Unsorted area.
  const undo = await undoKnowledgeMove(userId, filing.noticeId);
  assert.equal(undo.outcome, "undone");
  assert.ok(undo.outcome === "undone");
  assert.ok(undo.restored.length > 0);
  assert.ok(undo.restored.every((c) => c.unsorted === true));
  const sharedAfterUndo = await loadOntologyConcepts(workspaceOwner(wsLive));
  assert.ok(
    !sharedAfterUndo.some((c) => c.label === "Live client playbook"),
    "undo removes what the filing created",
  );
  const wsOntology = await loadOntologyForOwner(workspaceOwner(wsLive));
  assert.ok(
    wsOntology.tombstones.some(
      (marker) => marker.id === filing.filed[0]?.id && marker.replaced === true,
    ),
    "undo leaves a replaced tombstone so a later sync cannot resurrect the record",
  );
  const personalAfterUndo = await loadOntologyConcepts(userOwner(userId));
  const returned = personalAfterUndo.find((c) => c.label === "Live client playbook");
  assert.ok(returned);
  assert.equal(returned!.unsorted, true);

  const second = await undoKnowledgeMove(userId, filing.noticeId);
  assert.equal(second.outcome, "conflict", "an undo can only happen once");
});

test("moves between owners merge with twins, tombstone the source, and refuse same-owner", async () => {
  await ensureMovesTestSchema();
  const suffix = randomUUID();
  const userId = `km-move-${suffix}`;
  createdUserIds.push(userId);
  const wsId = await createWorkspace(`Move Co ${suffix}`, userId);

  await fileExtractedKnowledge({
    owner: userOwner(userId),
    capturedByUserId: userId,
    conversation: conversation(`${suffix}-a`, "proj-move"),
    candidates: [candidate("Quarterly budget"), candidate("Vendor escalation")],
  });
  await fileExtractedKnowledge({
    owner: workspaceOwner(wsId),
    capturedByUserId: userId,
    conversation: conversation(`${suffix}-b`),
    candidates: [candidate("Vendor escalation")],
  });

  const personal = await loadOntologyConcepts(userOwner(userId));
  const budget = personal.find((c) => c.label === "Quarterly budget")!;
  const vendor = personal.find((c) => c.label === "Vendor escalation")!;
  const twin = (await loadOntologyConcepts(workspaceOwner(wsId))).find(
    (c) => c.label === "Vendor escalation",
  )!;

  // Fresh label in the target: the move creates a new workspace record.
  const created = await moveOntologyConceptBetweenOwners({
    fromOwner: userOwner(userId),
    toOwner: workspaceOwner(wsId),
    conceptId: budget.id,
    movedByUserId: userId,
  });
  assert.ok(created);
  assert.equal(created!.merged, false);
  assert.equal(created!.moved.projectId, null, "workspace knowledge is cross-project");
  assert.ok(
    created!.moved.sources.every((s) => s.capturedByUserId === userId),
    "moved evidence keeps the mover's attribution",
  );

  // Twin label in the target: the move merges instead of duplicating.
  const merged = await moveOntologyConceptBetweenOwners({
    fromOwner: userOwner(userId),
    toOwner: workspaceOwner(wsId),
    conceptId: vendor.id,
    movedByUserId: userId,
  });
  assert.ok(merged);
  assert.equal(merged!.merged, true);
  assert.equal(merged!.moved.id, twin.id, "the twin keeps its identity");
  assert.ok(
    merged!.moved.mentionCount >= vendor.mentionCount + twin.mentionCount,
    "merge accumulates mentions",
  );

  // The source records are gone for good: replaced tombstones win any merge.
  const personalAfter = await loadOntologyForOwner(userOwner(userId));
  assert.ok(!personalAfter.concepts.some((c) => c.id === budget.id));
  for (const id of [budget.id, vendor.id]) {
    assert.ok(
      personalAfter.tombstones.some(
        (marker) => marker.id === id && marker.replaced === true,
      ),
      "a moved-away concept leaves a replaced tombstone",
    );
  }

  assert.equal(
    await moveOntologyConceptBetweenOwners({
      fromOwner: userOwner(userId),
      toOwner: workspaceOwner(wsId),
      conceptId: budget.id,
      movedByUserId: userId,
    }),
    null,
    "moving a gone concept reports null",
  );
  await assert.rejects(
    moveOntologyConceptBetweenOwners({
      fromOwner: userOwner(userId),
      toOwner: userOwner(userId),
      conceptId: vendor.id,
      movedByUserId: userId,
    }),
    /onto itself/i,
  );
});

test("re-filing pass: cheap signals move, suggest, and never ping-pong", async () => {
  await ensureMovesTestSchema();
  const suffix = randomUUID();
  const userId = `km-refile-${suffix}`;
  const otherId = `km-refile-other-${suffix}`;
  createdUserIds.push(userId, otherId);
  const wsId = await createWorkspace(`Refile Co ${suffix}`, userId, otherId);

  // Personal store: one unsorted item, one established sorted item, one
  // ordinary sorted item, plus one sorted item that will conflict.
  await fileExtractedKnowledge({
    owner: userOwner(userId),
    capturedByUserId: userId,
    conversation: conversation(`${suffix}-p1`, "proj-r"),
    candidates: [
      { ...candidate("Acme pricing model"), unsorted: true },
      candidate("Supply chain risks"),
      candidate("Morning routine"),
      candidate("Mixed signals topic"),
    ],
  });
  // Second filing establishes "Supply chain risks" (mentionCount >= 2).
  await fileExtractedKnowledge({
    owner: userOwner(userId),
    capturedByUserId: userId,
    conversation: conversation(`${suffix}-p2`, "proj-r"),
    candidates: [candidate("Supply chain risks")],
  });
  // Workspace store: one concept solely authored by the user (may move
  // out), one carrying a teammate's evidence (must never move).
  await fileExtractedKnowledge({
    owner: workspaceOwner(wsId),
    capturedByUserId: userId,
    conversation: conversation(`${suffix}-w1`),
    candidates: [candidate("Legacy process")],
  });
  await fileExtractedKnowledge({
    owner: workspaceOwner(wsId),
    capturedByUserId: otherId,
    conversation: conversation(`${suffix}-w2`),
    candidates: [candidate("Shared metric")],
  });

  const trigger = {
    userId,
    conversation: conversation(`${suffix}-t`, "proj-r"),
    personalLabels: ["Legacy process", "Shared metric", "Mixed signals topic"],
    workspaceFilings: [
      {
        workspaceId: wsId,
        workspaceName: `Refile Co ${suffix}`,
        labels: [
          "Acme pricing model",
          "Supply chain risks",
          "Mixed signals topic",
        ],
      },
    ],
  };
  const outcome = await runKnowledgeRefilingPass(trigger);
  assert.equal(outcome.moved, 1, "only workspace→personal moves automatically");
  assert.equal(
    outcome.suggested,
    2,
    "every personal-store exit — unsorted included — is suggestion-only",
  );

  const personal = await loadOntologyConcepts(userOwner(userId));
  const personalLabels = new Set(personal.map((c) => c.label));
  assert.ok(
    personalLabels.has("Acme pricing model"),
    "a clarified unsorted item stays private until the author accepts",
  );
  const acme = personal.find((c) => c.label === "Acme pricing model")!;
  assert.equal(acme.unsorted, true, "and it stays in the unsorted holding area");
  assert.ok(personalLabels.has("Legacy process"), "solely-authored misfile moved out");
  const legacy = personal.find((c) => c.label === "Legacy process")!;
  assert.notEqual(legacy.unsorted, true, "a rescued misfile returns as sorted knowledge");
  assert.ok(personalLabels.has("Supply chain risks"), "suggestions never move anything");
  assert.ok(personalLabels.has("Mixed signals topic"), "conflicting signals stay put");

  const shared = await loadOntologyConcepts(workspaceOwner(wsId));
  const sharedLabels = new Set(shared.map((c) => c.label));
  assert.ok(
    !sharedLabels.has("Acme pricing model"),
    "nothing reaches teammates without explicit acceptance",
  );
  assert.ok(!sharedLabels.has("Legacy process"));
  assert.ok(sharedLabels.has("Shared metric"), "a teammate's evidence pins the record");

  const moves = await listKnowledgeMoves(userId);
  const directions = moves.notices
    .filter((n) => n.kind === "refile")
    .map((n) => (n.payload as { direction: string }).direction);
  assert.deepEqual(directions, ["workspace_to_personal"]);
  assert.equal(moves.suggestions.length, 2);
  const unsortedSuggestion = moves.suggestions.find(
    (s) => s.labels[0] === "Acme pricing model",
  );
  const suggestion = moves.suggestions.find(
    (s) => s.labels[0] === "Supply chain risks",
  );
  assert.ok(unsortedSuggestion, "the clarified unsorted item surfaces as a suggestion");
  assert.ok(suggestion, "the established personal item surfaces as a suggestion");

  // Same trigger again: the recent-move window and pending suggestion
  // dedup make the pass a no-op.
  const rerun = await runKnowledgeRefilingPass(trigger);
  assert.deepEqual(rerun, { moved: 0, suggested: 0 });

  // Accepting the unsorted suggestion is the explicit consent step: only
  // then does the item join the workspace store (merging with its filed
  // twin) and shed the unsorted state.
  const unsortedRecord = await getKnowledgeMove(userId, unsortedSuggestion!.id);
  assert.ok(unsortedRecord);
  const acceptedUnsorted = await acceptKnowledgeSuggestion(userId, unsortedRecord!);
  assert.equal(acceptedUnsorted.outcome, "accepted");
  const sharedAfterUnsorted = await loadOntologyConcepts(workspaceOwner(wsId));
  const arrived = sharedAfterUnsorted.find((c) => c.label === "Acme pricing model");
  assert.ok(arrived, "accepting moves the clarified item in");
  assert.notEqual(arrived!.unsorted, true, "workspace copies are never unsorted");
  assert.ok(
    !(await loadOntologyConcepts(userOwner(userId))).some(
      (c) => c.label === "Acme pricing model",
    ),
  );

  // Accepting the established-personal suggestion widens visibility the
  // same way: the concept then lives in the workspace store.
  const record = await getKnowledgeMove(userId, suggestion!.id);
  assert.ok(record);
  const accepted = await acceptKnowledgeSuggestion(userId, record!);
  assert.equal(accepted.outcome, "accepted");
  const sharedAfterAccept = await loadOntologyConcepts(workspaceOwner(wsId));
  assert.ok(sharedAfterAccept.some((c) => c.label === "Supply chain risks"));
  assert.ok(
    !(await loadOntologyConcepts(userOwner(userId))).some(
      (c) => c.label === "Supply chain risks",
    ),
  );
  assert.equal((await getKnowledgeMove(userId, suggestion!.id))!.status, "accepted");

  // Dismissal cooldown: a fresh matching filing must not resurface the
  // dismissed pair immediately.
  await fileExtractedKnowledge({
    owner: userOwner(userId),
    capturedByUserId: userId,
    conversation: conversation(`${suffix}-p3`, "proj-r"),
    candidates: [candidate("Vendor onboarding"), candidate("Vendor onboarding")],
  });
  const secondTrigger = {
    userId,
    conversation: conversation(`${suffix}-t2`, "proj-r"),
    personalLabels: [],
    workspaceFilings: [
      {
        workspaceId: wsId,
        workspaceName: `Refile Co ${suffix}`,
        labels: ["Vendor onboarding"],
      },
    ],
  };
  const secondPass = await runKnowledgeRefilingPass(secondTrigger);
  assert.equal(secondPass.suggested, 1);
  const pending = (await listKnowledgeMoves(userId)).suggestions.find(
    (s) => s.labels[0] === "Vendor onboarding",
  )!;
  const dismissed = await dismissKnowledgeSuggestion(userId, pending.id);
  assert.equal(dismissed.outcome, "dismissed");
  const thirdPass = await runKnowledgeRefilingPass(secondTrigger);
  assert.equal(thirdPass.suggested, 0, "a dismissed suggestion must not pop right back");

  // Workspace deletion retires every open row that points at it.
  await dismissMovesForWorkspace(wsId);
  const afterDeletion = await listKnowledgeMoves(userId);
  assert.equal(afterDeletion.suggestions.length, 0);
  assert.ok(afterDeletion.notices.every((n) => n.status !== "active"));
});

test("undo closes after the 24h window and stale notices leave the list", async () => {
  await ensureMovesTestSchema();
  const suffix = randomUUID();
  const userId = `km-expiry-${suffix}`;
  createdUserIds.push(userId);
  const wsId = await createWorkspace(`Expiry Co ${suffix}`, userId);
  const memberships = [
    {
      workspaceId: wsId,
      workspaceName: `Expiry Co ${suffix}`,
      role: "admin" as const,
    },
  ];
  const filedAt = Date.now();
  const first = await performClassifiedFiling({
    userId,
    conversation: conversation(`${suffix}-1`),
    clusters: [
      { ...candidate("Retention playbook"), scope: wsId, scopeConfidence: 0.95 },
    ],
    memberships,
    now: filedAt,
  });
  const second = await performClassifiedFiling({
    userId,
    conversation: conversation(`${suffix}-2`),
    clusters: [
      { ...candidate("Churn dashboard"), scope: wsId, scopeConfidence: 0.95 },
    ],
    memberships,
    now: filedAt,
  });
  const firstNotice = first.workspaceFilings[0]!.noticeId;
  const secondNotice = second.workspaceFilings[0]!.noticeId;

  // Inside the window both notices list as active and undoable.
  const fresh = await listKnowledgeMoves(userId, filedAt + 60_000);
  assert.equal(
    fresh.notices.filter((n) => n.status === "active").length,
    2,
    "fresh notices stay actionable",
  );

  const late = filedAt + UNDO_WINDOW_MS + 60_000;
  // Clicking undo after the window refuses and retires the row...
  const refused = await undoKnowledgeMove(userId, firstNotice, late);
  assert.equal(refused.outcome, "expired");
  assert.equal((await getKnowledgeMove(userId, firstNotice))!.status, "expired");
  // ...and the workspace store keeps what the filing wrote.
  const shared = await loadOntologyConcepts(workspaceOwner(wsId));
  assert.ok(shared.some((c) => c.label === "Retention playbook"));

  // A stale notice that was never clicked is retired lazily by the list
  // itself, so clients are never offered an undo the server would refuse.
  const listed = await listKnowledgeMoves(userId, late);
  assert.ok(listed.notices.every((n) => n.id !== firstNotice));
  assert.ok(listed.notices.every((n) => n.id !== secondNotice));
  assert.equal((await getKnowledgeMove(userId, secondNotice))!.status, "expired");
});

test("undo refuses once a later edit touched the filed workspace record", async () => {
  await ensureMovesTestSchema();
  const suffix = randomUUID();
  const userId = `km-drift-${suffix}`;
  const mateId = `km-drift-mate-${suffix}`;
  createdUserIds.push(userId, mateId);
  const wsId = await createWorkspace(`Drift Co ${suffix}`, userId, mateId);
  const result = await performClassifiedFiling({
    userId,
    conversation: conversation(suffix),
    clusters: [
      { ...candidate("Pricing ladder"), scope: wsId, scopeConfidence: 0.95 },
    ],
    memberships: [
      {
        workspaceId: wsId,
        workspaceName: `Drift Co ${suffix}`,
        role: "admin" as const,
      },
    ],
  });
  const noticeId = result.workspaceFilings[0]!.noticeId;

  // A teammate's evidence merges into the same record after the filing.
  await fileExtractedKnowledge({
    owner: workspaceOwner(wsId),
    capturedByUserId: mateId,
    conversation: conversation(`${suffix}-mate`),
    candidates: [candidate("Pricing ladder")],
    now: Date.now() + 5_000,
  });

  const refused = await undoKnowledgeMove(userId, noticeId);
  assert.equal(
    refused.outcome,
    "changed",
    "undo must not restore the pre-filing snapshot over a teammate's merge",
  );
  // The teammate's contribution survives in full.
  const shared = await loadOntologyConcepts(workspaceOwner(wsId));
  const kept = shared.find((c) => c.label === "Pricing ladder");
  assert.ok(kept);
  assert.ok(kept!.sources.some((s) => s.capturedByUserId === mateId));
  // The notice is terminally retired rather than dangling as retryable.
  assert.equal((await getKnowledgeMove(userId, noticeId))!.status, "expired");
  const listed = await listKnowledgeMoves(userId);
  assert.ok(listed.notices.every((n) => n.id !== noticeId));
});

test("a re-file undo also refuses after the moved record changed", async () => {
  await ensureMovesTestSchema();
  const suffix = randomUUID();
  const userId = `km-rdrift-${suffix}`;
  const mateId = `km-rdrift-mate-${suffix}`;
  createdUserIds.push(userId, mateId);
  const wsId = await createWorkspace(`RD Co ${suffix}`, userId, mateId);

  await fileExtractedKnowledge({
    owner: userOwner(userId),
    capturedByUserId: userId,
    conversation: conversation(suffix, "proj-rd"),
    candidates: [{ ...candidate("Rollout checklist"), unsorted: true }],
  });
  const concept = (await loadOntologyConcepts(userOwner(userId))).find(
    (c) => c.label === "Rollout checklist",
  )!;
  const moved = await moveOntologyConceptBetweenOwners({
    fromOwner: userOwner(userId),
    toOwner: workspaceOwner(wsId),
    conceptId: concept.id,
    movedByUserId: userId,
    targetProjectId: null,
  });
  assert.ok(moved);
  const noticeId = await recordRefileNotice({
    userId,
    fromOwner: userOwner(userId),
    toOwner: workspaceOwner(wsId),
    workspaceId: wsId,
    workspaceName: `RD Co ${suffix}`,
    label: concept.label,
    payload: {
      direction: "unsorted_to_workspace",
      movedConceptId: moved!.moved.id,
      merged: moved!.merged,
      sourceBefore: moved!.sourceBefore,
      targetBefore: moved!.targetBefore,
      targetProjectId: null,
      afterUpdatedAt: moved!.moved.lastUpdatedAt,
    },
  });

  await fileExtractedKnowledge({
    owner: workspaceOwner(wsId),
    capturedByUserId: mateId,
    conversation: conversation(`${suffix}-mate`),
    candidates: [candidate("Rollout checklist")],
    now: Date.now() + 5_000,
  });

  const refused = await undoKnowledgeMove(userId, noticeId);
  assert.equal(refused.outcome, "changed");
  assert.ok(
    (await loadOntologyConcepts(workspaceOwner(wsId))).some(
      (c) =>
        c.label === "Rollout checklist" &&
        c.sources.some((s) => s.capturedByUserId === mateId),
    ),
    "the teammate's later evidence survives the refused undo",
  );
  assert.equal((await getKnowledgeMove(userId, noticeId))!.status, "expired");
});

test("undo queued behind a concurrent edit's row lock still refuses cleanly", async () => {
  await ensureMovesTestSchema();
  const suffix = randomUUID();
  const userId = `km-race-${suffix}`;
  const mateId = `km-race-mate-${suffix}`;
  createdUserIds.push(userId, mateId);
  const wsId = await createWorkspace(`Race Co ${suffix}`, userId, mateId);
  const result = await performClassifiedFiling({
    userId,
    conversation: conversation(suffix),
    clusters: [
      { ...candidate("Quota policy"), scope: wsId, scopeConfidence: 0.95 },
    ],
    memberships: [
      {
        workspaceId: wsId,
        workspaceName: `Race Co ${suffix}`,
        role: "admin" as const,
      },
    ],
  });
  const noticeId = result.workspaceFilings[0]!.noticeId;
  const owner = workspaceOwner(wsId);
  const filed = (await loadOntologyConcepts(owner)).find(
    (c) => c.label === "Quota policy",
  );
  assert.ok(filed);

  // A teammate's edit is mid-transaction (row lock held, not yet committed)
  // when the undo starts. The undo's guarded restore must queue behind the
  // lock, re-read the fingerprint after the edit commits, and refuse without
  // writing anything — the exact window the pre-check-then-restore shape
  // used to lose.
  const client = await pool.connect();
  let undoInFlight: ReturnType<typeof undoKnowledgeMove> | undefined;
  try {
    await client.query("BEGIN");
    await client.query(
      `UPDATE venom_ontology_concepts
          SET last_updated_at = last_updated_at + 5000
        WHERE owner_type = $1 AND owner_id = $2 AND concept_id = $3`,
      [owner.ownerType, owner.ownerId, filed!.id],
    );
    undoInFlight = undoKnowledgeMove(userId, noticeId);
    // Give the undo time to claim the notice and block on the locked row.
    await new Promise((resolve) => setTimeout(resolve, 300));
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }

  const refused = await undoInFlight!;
  assert.equal(
    refused.outcome,
    "changed",
    "the in-transaction recheck must refuse once the concurrent commit wins",
  );
  // The concurrent edit survives untouched: the record was neither deleted
  // nor rolled back to its pre-filing snapshot.
  const kept = (await loadOntologyConcepts(owner)).find(
    (c) => c.id === filed!.id,
  );
  assert.ok(kept, "a refused undo must not delete the filed record");
  assert.equal(kept!.lastUpdatedAt, filed!.lastUpdatedAt + 5000);
  assert.equal((await getKnowledgeMove(userId, noticeId))!.status, "expired");
});

test("a member's classification digest excludes admin-only labels; an admin's includes them", async () => {
  await ensureMovesTestSchema();
  const suffix = randomUUID();
  const userId = `km-restrict-${suffix}`;
  const mateId = `km-restrict-mate-${suffix}`;
  createdUserIds.push(userId, mateId);
  const wsId = await createWorkspace(`Restrict Co ${suffix}`, userId, mateId);
  const owner = workspaceOwner(wsId);
  await fileExtractedKnowledge({
    owner,
    capturedByUserId: userId,
    conversation: conversation(suffix),
    candidates: [candidate("Public roadmap"), candidate("Board dispute")],
    now: Date.now(),
  });
  const restricted = (await loadOntologyConcepts(owner)).find(
    (c) => c.label === "Board dispute",
  );
  assert.ok(restricted);
  await pool.query(
    `UPDATE venom_ontology_concepts SET admin_only = TRUE
      WHERE owner_type = $1 AND owner_id = $2 AND concept_id = $3`,
    [owner.ownerType, owner.ownerId, restricted!.id],
  );

  // The digest is the exact surface serialized into the classifier prompt:
  // a member's must drop the restricted label before it can reach the model
  // provider, while an admin's keeps it.
  const concepts = await loadOntologyConcepts(owner);
  const memberDigest = workspaceTopicDigest(concepts, "member");
  assert.ok(
    !memberDigest.includes("Board dispute"),
    "restricted label must never reach a member's classifier prompt",
  );
  assert.ok(memberDigest.includes("Public roadmap"));
  const adminDigest = workspaceTopicDigest(concepts, "admin");
  assert.ok(adminDigest.includes("Board dispute"));
});

test("a failure between destination restore and personal re-filing rolls the whole undo back", async () => {
  await ensureMovesTestSchema();
  const suffix = randomUUID();
  const userId = `km-atomic-${suffix}`;
  createdUserIds.push(userId);
  const wsId = await createWorkspace(`Atomic Co ${suffix}`, userId);
  const memberships = [
    {
      workspaceId: wsId,
      workspaceName: `Atomic Co ${suffix}`,
      role: "admin" as const,
    },
  ];
  const filed = await performClassifiedFiling({
    userId,
    conversation: conversation(`${suffix}-1`),
    clusters: [
      { ...candidate("Quarterly targets"), scope: wsId, scopeConfidence: 0.95 },
    ],
    memberships,
    now: Date.now(),
  });
  const noticeId = filed.workspaceFilings[0]!.noticeId;

  await assert.rejects(
    undoKnowledgeMove(userId, noticeId, undefined, {
      afterDestinationRestore: () => {
        throw new Error("injected failure after destination restore");
      },
    }),
    /injected failure/,
  );

  // Atomicity: the workspace record survived, nothing landed in the
  // personal store, and the notice is still active — a plain retry works.
  assert.ok(
    (await loadOntologyConcepts(workspaceOwner(wsId))).some(
      (c) => c.label === "Quarterly targets",
    ),
    "a failed undo must not remove the workspace record",
  );
  assert.ok(
    !(await loadOntologyConcepts(userOwner(userId))).some(
      (c) => c.label === "Quarterly targets",
    ),
    "a failed undo must not leave a partial personal copy",
  );
  assert.equal((await getKnowledgeMove(userId, noticeId))!.status, "active");

  const retried = await undoKnowledgeMove(userId, noticeId);
  assert.equal(retried.outcome, "undone");
  assert.ok(
    !(await loadOntologyConcepts(workspaceOwner(wsId))).some(
      (c) => c.label === "Quarterly targets",
    ),
  );
  const personal = (await loadOntologyConcepts(userOwner(userId))).find(
    (c) => c.label === "Quarterly targets",
  );
  assert.ok(personal, "the retry lands the item in the personal store");
  assert.equal(personal!.unsorted, true);
  assert.equal((await getKnowledgeMove(userId, noticeId))!.status, "undone");
});

test("a failed refile undo also rolls back atomically and stays retryable", async () => {
  await ensureMovesTestSchema();
  const suffix = randomUUID();
  const userId = `km-atomic-refile-${suffix}`;
  createdUserIds.push(userId);
  const wsId = await createWorkspace(`Atomic Refile Co ${suffix}`, userId);
  await fileExtractedKnowledge({
    owner: workspaceOwner(wsId),
    capturedByUserId: userId,
    conversation: conversation(`${suffix}-w`),
    candidates: [candidate("Side project notes")],
  });
  const outcome = await runKnowledgeRefilingPass({
    userId,
    conversation: conversation(`${suffix}-t`),
    personalLabels: ["Side project notes"],
    workspaceFilings: [],
  });
  assert.equal(outcome.moved, 1, "the solely-authored misfile moves out");
  const notice = (await listKnowledgeMoves(userId)).notices.find(
    (n) => n.kind === "refile",
  );
  assert.ok(notice);

  await assert.rejects(
    undoKnowledgeMove(userId, notice!.id, undefined, {
      afterDestinationRestore: () => {
        throw new Error("injected failure after destination restore");
      },
    }),
    /injected failure/,
  );
  assert.ok(
    (await loadOntologyConcepts(userOwner(userId))).some(
      (c) => c.label === "Side project notes",
    ),
    "a failed undo must leave the moved-in personal record in place",
  );
  assert.ok(
    !(await loadOntologyConcepts(workspaceOwner(wsId))).some(
      (c) => c.label === "Side project notes",
    ),
    "a failed undo must not resurrect the workspace copy early",
  );
  assert.equal((await getKnowledgeMove(userId, notice!.id))!.status, "active");

  const retried = await undoKnowledgeMove(userId, notice!.id);
  assert.equal(retried.outcome, "undone");
  assert.ok(
    !(await loadOntologyConcepts(userOwner(userId))).some(
      (c) => c.label === "Side project notes",
    ),
  );
  assert.ok(
    (await loadOntologyConcepts(workspaceOwner(wsId))).some(
      (c) => c.label === "Side project notes",
    ),
    "the retry restores the workspace copy",
  );
});
