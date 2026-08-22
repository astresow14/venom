/**
 * Real-database integration tests for user-centric chat context assembly:
 * every turn draws on the caller's personal Brain plus every shared
 * workspace they belong to — membership-checked per call, Task #162
 * restriction-filtered, ranked with the active scope and the on-screen
 * project favored, and labeled with the scope each entry came from. The
 * on-screen selection no longer gates what chat knows; it only decides
 * where new knowledge files and which workspace's SOPs join the prompt.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import {
  db,
  pool,
  venomOntologyConceptsTable,
  venomOntologyEvidenceTable,
  venomOntologyLinksTable,
  venomOntologyOwnersTable,
  venomOntologyTombstonesTable,
  venomSharedWorkspaceMembersTable,
  venomSharedWorkspacesTable,
  venomSopRevisionsTable,
  venomSopsTable,
} from "@workspace/db";
import { and, eq, inArray, sql } from "drizzle-orm";
import express from "express";
import router, {
  overrideSharedWorkspaceUserDirectoryForTests,
  overrideSharedWorkspaceUserIdResolverForTests,
} from "./venom-shared-workspaces.js";
import {
  loadUserChatContext,
  PERSONAL_CITATION_PREFIX,
  WORKSPACE_CITATION_PREFIX,
} from "../lib/workspace-chat-context.js";
import {
  fileExtractedKnowledge,
  loadOntologyConcepts,
  userOwner,
  workspaceOwner,
} from "../lib/venom-ontology-store.js";
import {
  getSharedWorkspaceMembership,
  workspaceSopOwnerKey,
} from "../lib/workspace-membership.js";

type TestResponse = {
  status: number;
  body: any;
  text: string;
};

async function ensureChatContextTestSchema(): Promise<void> {
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
    ALTER TABLE venom_sops
      ADD COLUMN IF NOT EXISTS admin_only boolean NOT NULL DEFAULT false
  `);
}

function assertStatus(response: TestResponse, expected: number): void {
  assert.equal(
    response.status,
    expected,
    `Expected HTTP ${expected}; received ${response.status}: ${JSON.stringify(response.body ?? response.text.slice(0, 500))}`,
  );
}

const candidate = (label: string, confidence: number) => ({
  label,
  category: "topic",
  confidence,
  summary: `${label} summary`,
  sourceMessageIds: ["m1"],
  relatedLabels: [],
});

type KnowledgeEntry = {
  citationId: string;
  scope: "personal" | "workspace";
  workspace?: string;
  label: string;
};

function parseEntries(knowledgeBlock: string | null): KnowledgeEntry[] {
  assert.ok(knowledgeBlock, "expected a knowledge block");
  const match = knowledgeBlock.match(
    /<knowledge_reference_data>\n([\s\S]*)\n<\/knowledge_reference_data>/,
  );
  assert.ok(match, "knowledge block must carry the reference envelope");
  const parsed = JSON.parse(match![1]);
  assert.equal(parsed.documentType, "venom_untrusted_user_knowledge_v1");
  return parsed.entries;
}

const createdWorkspaceIds: string[] = [];
const createdOwnerIds: string[] = [];

async function cleanup() {
  const ownerIds = [...new Set([...createdWorkspaceIds, ...createdOwnerIds])];
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
  if (createdWorkspaceIds.length > 0) {
    const ownerKeys = createdWorkspaceIds.map((id) => workspaceSopOwnerKey(id));
    await db
      .delete(venomSopRevisionsTable)
      .where(inArray(venomSopRevisionsTable.clerkUserId, ownerKeys));
    await db
      .delete(venomSopsTable)
      .where(inArray(venomSopsTable.clerkUserId, ownerKeys));
    await db
      .delete(venomSharedWorkspacesTable)
      .where(inArray(venomSharedWorkspacesTable.id, createdWorkspaceIds));
  }
}

test.after(async () => {
  await cleanup();
  await pool.end();
});

test("chat context is user-centric: all memberships plus the personal Brain, boundaries enforced", async () => {
  await ensureChatContextTestSchema();
  const suffix = randomUUID();
  const ownerAId = `ucc-owner-a-${suffix}`;
  const ownerBId = `ucc-owner-b-${suffix}`;
  const callerId = `ucc-caller-${suffix}`;
  const strangerId = `ucc-stranger-${suffix}`;
  createdOwnerIds.push(callerId, ownerAId, ownerBId, strangerId);

  const knownAccounts = new Map<string, string | null>([
    [ownerAId, "Ada Owner"],
    [ownerBId, "Bo Owner"],
    [callerId, "Cal Caller"],
    [strangerId, "Sig Stranger"],
  ]);

  let activeUserId = ownerAId;
  const restoreAuth = overrideSharedWorkspaceUserIdResolverForTests(
    () => activeUserId,
  );
  const restoreDirectory = overrideSharedWorkspaceUserDirectoryForTests({
    async getUser(userId) {
      if (!knownAccounts.has(userId)) return null;
      return { id: userId, name: knownAccounts.get(userId) ?? null };
    },
    async getUsers(userIds) {
      const names = new Map<string, string | null>();
      for (const userId of userIds) {
        if (knownAccounts.has(userId)) {
          names.set(userId, knownAccounts.get(userId) ?? null);
        }
      }
      return names;
    },
  });

  const app = express();
  app.use(express.json());
  app.use((request, _response, next) => {
    request.log = {
      info: () => {},
      warn: () => {},
      error: () => {},
    } as unknown as typeof request.log;
    next();
  });
  app.use(router);
  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const baseUrl = `http://127.0.0.1:${address.port}`;

  async function request(
    path: string,
    options: RequestInit = {},
  ): Promise<TestResponse> {
    const response = await fetch(`${baseUrl}${path}`, {
      ...options,
      headers: {
        "content-type": "application/json",
        ...options.headers,
      },
    });
    const text = await response.text();
    let body: unknown = null;
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        body = null;
      }
    }
    return { status: response.status, body, text };
  }

  try {
    // --- Two workspaces the caller belongs to, one they do not -----------
    const wsAName = `Alpha Ops ${suffix}`;
    const wsBName = `Beta Ops ${suffix}`;
    const wsCName = `Gamma Vault ${suffix}`;

    activeUserId = ownerAId;
    const createdA = await request("/venom/workspaces", {
      method: "POST",
      body: JSON.stringify({ name: wsAName }),
    });
    assertStatus(createdA, 201);
    const wsAId: string = createdA.body.id;
    createdWorkspaceIds.push(wsAId);
    assertStatus(
      await request(`/venom/workspaces/${wsAId}/members`, {
        method: "POST",
        body: JSON.stringify({ userId: callerId }),
      }),
      201,
    );

    activeUserId = ownerBId;
    const createdB = await request("/venom/workspaces", {
      method: "POST",
      body: JSON.stringify({ name: wsBName }),
    });
    assertStatus(createdB, 201);
    const wsBId: string = createdB.body.id;
    createdWorkspaceIds.push(wsBId);
    assertStatus(
      await request(`/venom/workspaces/${wsBId}/members`, {
        method: "POST",
        body: JSON.stringify({ userId: callerId }),
      }),
      201,
    );

    activeUserId = strangerId;
    const createdC = await request("/venom/workspaces", {
      method: "POST",
      body: JSON.stringify({ name: wsCName }),
    });
    assertStatus(createdC, 201);
    const wsCId: string = createdC.body.id;
    createdWorkspaceIds.push(wsCId);

    // --- Seed knowledge in every scope ------------------------------------
    // Strengths derive from confidence (~0.34 + 0.42 * confidence), so the
    // on-screen-project bonus must do real work below: the favored concept
    // is seeded WEAKER than its competition.
    await fileExtractedKnowledge({
      owner: userOwner(callerId),
      capturedByUserId: callerId,
      conversation: {
        id: "conv_focus",
        title: "Pricing chat",
        projectId: "proj_focus",
      },
      candidates: [candidate("Personal pricing instinct", 0.5)],
    });
    await fileExtractedKnowledge({
      owner: userOwner(callerId),
      capturedByUserId: callerId,
      conversation: { id: "conv_travel", title: "Travel chat", projectId: null },
      candidates: [candidate("Personal travel preference", 0.7)],
    });
    await fileExtractedKnowledge({
      owner: workspaceOwner(wsAId),
      capturedByUserId: ownerAId,
      conversation: { id: "conv_a_open", title: "Ops sync", projectId: null },
      candidates: [candidate("Alpha vendor escalation", 0.5)],
    });
    await fileExtractedKnowledge({
      owner: workspaceOwner(wsAId),
      capturedByUserId: ownerAId,
      conversation: { id: "conv_a_comp", title: "Compensation", projectId: null },
      candidates: [candidate("Alpha compensation bands", 0.9)],
    });
    await fileExtractedKnowledge({
      owner: workspaceOwner(wsBId),
      capturedByUserId: ownerBId,
      conversation: { id: "conv_b", title: "Onboarding", projectId: null },
      candidates: [candidate("Beta onboarding checklist", 0.9)],
    });
    await fileExtractedKnowledge({
      owner: workspaceOwner(wsCId),
      capturedByUserId: strangerId,
      conversation: { id: "conv_c", title: "Roadmap", projectId: null },
      candidates: [candidate("Gamma secret roadmap", 0.9)],
    });

    const wsAConcepts = await loadOntologyConcepts(workspaceOwner(wsAId));
    const alphaOpen = wsAConcepts.find(
      (concept) => concept.label === "Alpha vendor escalation",
    );
    const alphaRestricted = wsAConcepts.find(
      (concept) => concept.label === "Alpha compensation bands",
    );
    assert.ok(alphaOpen && alphaRestricted);
    const wsBConcepts = await loadOntologyConcepts(workspaceOwner(wsBId));
    const betaConcept = wsBConcepts.find(
      (concept) => concept.label === "Beta onboarding checklist",
    );
    assert.ok(betaConcept);

    // Task #162 restriction on one Alpha concept (admin-set).
    activeUserId = ownerAId;
    assertStatus(
      await request(
        `/venom/workspaces/${wsAId}/knowledge/${alphaRestricted!.id}/restriction`,
        { method: "PATCH", body: JSON.stringify({ adminOnly: true }) },
      ),
      200,
    );

    // A published SOP in Alpha so the SOP-union contract shows.
    const sop = await request(`/venom/workspaces/${wsAId}/sops`, {
      method: "POST",
      body: JSON.stringify({
        title: "Vendor runbook",
        category: "operations",
        tags: ["ops"],
        provenance: "manual",
        content: {
          purpose: "How we handle vendors",
          prerequisites: ["Access"],
          inputs: ["Ticket id"],
          guidance: ["Check the queue"],
          requiredApprovals: [],
          acceptanceChecks: ["Queue drained"],
        },
      }),
    });
    assertStatus(sop, 201);
    assertStatus(
      await request(`/venom/workspaces/${wsAId}/sops/${sop.body.id}/publish`, {
        method: "POST",
      }),
      200,
    );

    // --- One user-centric context: both workspaces plus personal ----------
    const personalCtx = await loadUserChatContext({
      userId: callerId,
      activeProjectId: "proj_focus",
    });
    assert.deepEqual(personalCtx.droppedScopes, []);
    assert.ok(
      personalCtx.sopBlock && /Vendor runbook/.test(personalCtx.sopBlock),
      "every membership's published SOPs join the prompt without a picker",
    );
    assert.ok(
      personalCtx.sopBlock!.includes(`Workspace "${wsAName}"`),
      "SOP sections carry their workspace's name",
    );
    const personalEntries = parseEntries(personalCtx.knowledgeBlock);
    const scopesSeen = new Set(
      personalEntries.map((entry) =>
        entry.scope === "personal" ? "personal" : entry.workspace,
      ),
    );
    assert.ok(scopesSeen.has("personal"));
    assert.ok(scopesSeen.has(wsAName), "workspace A knowledge must appear");
    assert.ok(scopesSeen.has(wsBName), "workspace B knowledge must appear");
    assert.ok(
      !scopesSeen.has(wsCName),
      "a workspace the caller does not belong to must never appear",
    );
    assert.doesNotMatch(personalCtx.knowledgeBlock!, /Gamma secret roadmap/);
    assert.doesNotMatch(
      personalCtx.knowledgeBlock!,
      /Alpha compensation bands/,
      "restricted items stay out for members",
    );
    assert.equal(
      personalCtx.citationLabels.has(
        `${WORKSPACE_CITATION_PREFIX}${alphaRestricted!.id}`,
      ),
      false,
      "a restricted concept must never mint a member citation id",
    );
    // Scoped labels resolve for saved notes and citations.
    const personalEntry = personalEntries.find(
      (entry) => entry.label === "Personal pricing instinct",
    );
    assert.ok(personalEntry);
    assert.ok(
      personalEntry!.citationId.startsWith(PERSONAL_CITATION_PREFIX),
      "personal concepts mint pbk- citation ids",
    );
    assert.equal(
      personalCtx.citationLabels.get(personalEntry!.citationId),
      "Personal: Personal pricing instinct",
    );
    assert.equal(
      personalCtx.citationLabels.get(
        `${WORKSPACE_CITATION_PREFIX}${alphaOpen!.id}`,
      ),
      `${wsAName}: Alpha vendor escalation`,
    );
    // On-screen project bias: the weaker personal concept tied to the active
    // project outranks everything, including stronger foreign knowledge.
    assert.equal(
      personalEntries[0]?.label,
      "Personal pricing instinct",
      "the on-screen project's concept must rank first when its project is on screen",
    );

    // --- No active scope: every scope ranks as an equal --------------------
    const workspaceCtx = await loadUserChatContext({
      userId: callerId,
      activeProjectId: null,
    });
    assert.deepEqual(workspaceCtx.droppedScopes, []);
    const workspaceEntries = parseEntries(workspaceCtx.knowledgeBlock);
    assert.equal(
      workspaceEntries[0]?.label,
      "Beta onboarding checklist",
      "without a picker, plain strength decides the order across scopes",
    );
    const workspaceScopes = new Set(
      workspaceEntries.map((entry) =>
        entry.scope === "personal" ? "personal" : entry.workspace,
      ),
    );
    assert.ok(
      workspaceScopes.has("personal"),
      "chat still knows the personal Brain",
    );
    assert.ok(workspaceScopes.has(wsAName), "every membership appears");
    assert.ok(workspaceScopes.has(wsBName), "every membership appears");
    assert.ok(!workspaceScopes.has(wsCName));
    assert.doesNotMatch(workspaceCtx.knowledgeBlock!, /Alpha compensation bands/);
    assert.ok(
      workspaceCtx.sopBlock && /Vendor runbook/.test(workspaceCtx.sopBlock),
      "published SOPs from every membership join the prompt",
    );
    // Each concept appears exactly once — no duplicate scope entries.
    const alphaOpenMentions = workspaceEntries.filter(
      (entry) =>
        entry.citationId === `${WORKSPACE_CITATION_PREFIX}${alphaOpen!.id}`,
    );
    assert.equal(alphaOpenMentions.length, 1);

    // --- Admins see restricted items; members never do --------------------
    const membershipAdminA = await getSharedWorkspaceMembership(
      wsAId,
      ownerAId,
    );
    assert.ok(membershipAdminA && membershipAdminA.role === "admin");
    const adminCtx = await loadUserChatContext({
      userId: ownerAId,
      activeProjectId: null,
    });
    assert.match(adminCtx.knowledgeBlock!, /Alpha compensation bands/);
    assert.equal(
      adminCtx.citationLabels.get(
        `${WORKSPACE_CITATION_PREFIX}${alphaRestricted!.id}`,
      ),
      `${wsAName}: Alpha compensation bands`,
    );

    // --- Removal revokes on the very next turn ----------------------------
    await db
      .delete(venomSharedWorkspaceMembersTable)
      .where(
        and(
          eq(venomSharedWorkspaceMembersTable.workspaceId, wsBId),
          eq(venomSharedWorkspaceMembersTable.clerkUserId, callerId),
        ),
      );
    const afterRemoval = await loadUserChatContext({
      userId: callerId,
      activeProjectId: null,
    });
    const remainingScopes = new Set(
      parseEntries(afterRemoval.knowledgeBlock).map((entry) =>
        entry.scope === "personal" ? "personal" : entry.workspace,
      ),
    );
    assert.ok(remainingScopes.has(wsAName));
    assert.ok(
      !remainingScopes.has(wsBName),
      "a removed member loses that workspace's context immediately",
    );
    assert.doesNotMatch(
      afterRemoval.knowledgeBlock!,
      /Beta onboarding checklist/,
    );
    assert.equal(
      afterRemoval.citationLabels.has(
        `${WORKSPACE_CITATION_PREFIX}${betaConcept!.id}`,
      ),
      false,
    );
  } finally {
    server.close();
    restoreAuth();
    restoreDirectory();
  }
});
