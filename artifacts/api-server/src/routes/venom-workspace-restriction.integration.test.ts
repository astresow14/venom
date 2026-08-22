/**
 * Real-database integration tests for admin-only restrictions on shared
 * workspace knowledge and SOPs: only admins may set or clear the flag, and
 * a restricted item never reaches a non-admin member through any server
 * path — knowledge reads, SOP reads, chat context assembly (and therefore
 * citations), sensitivity writes, publishing, or markdown exports.
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
  venomSharedWorkspacesTable,
  venomSopRevisionsTable,
  venomSopsTable,
} from "@workspace/db";
import { inArray, sql } from "drizzle-orm";
import express from "express";
import router, {
  overrideSharedWorkspaceUserDirectoryForTests,
  overrideSharedWorkspaceUserIdResolverForTests,
} from "./venom-shared-workspaces.js";
import {
  loadWorkspaceChatContext,
  WORKSPACE_CITATION_PREFIX,
} from "../lib/workspace-chat-context.js";
import {
  fileExtractedKnowledge,
  loadOntologyConcepts,
  workspaceOwner,
} from "../lib/venom-ontology-store.js";
import { workspaceSopOwnerKey } from "../lib/workspace-membership.js";

type TestResponse = {
  status: number;
  body: any;
  text: string;
  headers: Headers;
};

async function ensureRestrictionTestSchema(): Promise<void> {
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

const sopInput = (marker: string) => ({
  title: `Runbook ${marker}`,
  category: "operations",
  tags: ["ops"],
  provenance: "manual",
  content: {
    purpose: `How we operate (${marker})`,
    prerequisites: ["Access"],
    inputs: ["Ticket id"],
    guidance: ["Check the queue", "Escalate stale tickets"],
    requiredApprovals: [],
    acceptanceChecks: ["Queue drained"],
  },
});

const candidate = (label: string) => ({
  label,
  category: "topic",
  confidence: 0.9,
  summary: `${label} summary`,
  sourceMessageIds: ["m1"],
  relatedLabels: [],
});

const createdWorkspaceIds: string[] = [];
const createdUserIds: string[] = [];

async function cleanup() {
  if (createdWorkspaceIds.length > 0) {
    await db
      .delete(venomOntologyConceptsTable)
      .where(inArray(venomOntologyConceptsTable.ownerId, createdWorkspaceIds));
    await db
      .delete(venomOntologyEvidenceTable)
      .where(inArray(venomOntologyEvidenceTable.ownerId, createdWorkspaceIds));
    await db
      .delete(venomOntologyLinksTable)
      .where(inArray(venomOntologyLinksTable.ownerId, createdWorkspaceIds));
    await db
      .delete(venomOntologyTombstonesTable)
      .where(
        inArray(venomOntologyTombstonesTable.ownerId, createdWorkspaceIds),
      );
    await db
      .delete(venomOntologyOwnersTable)
      .where(inArray(venomOntologyOwnersTable.ownerId, createdWorkspaceIds));
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

test("admin-only restrictions are stored, admin-gated, and enforced on every member path", async () => {
  await ensureRestrictionTestSchema();
  const suffix = randomUUID();
  const adminId = `rx-admin-${suffix}`;
  const memberId = `rx-member-${suffix}`;
  const outsiderId = `rx-outsider-${suffix}`;
  createdUserIds.push(adminId, memberId, outsiderId);

  const knownAccounts = new Map<string, string | null>([
    [adminId, "Ada Admin"],
    [memberId, "Mo Member"],
    [outsiderId, "Olly Outsider"],
  ]);

  let activeUserId = adminId;
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
    return { status: response.status, body, text, headers: response.headers };
  }

  try {
    // --- Workspace with an admin and a member ---------------------------
    const created = await request("/venom/workspaces", {
      method: "POST",
      body: JSON.stringify({ name: `Restricted Ops ${suffix}` }),
    });
    assertStatus(created, 201);
    const workspaceId: string = created.body.id;
    createdWorkspaceIds.push(workspaceId);
    const addMember = await request(`/venom/workspaces/${workspaceId}/members`, {
      method: "POST",
      body: JSON.stringify({ userId: memberId }),
    });
    assertStatus(addMember, 201);

    // --- Seed two clusters and two SOPs (publish both) -------------------
    await fileExtractedKnowledge({
      owner: workspaceOwner(workspaceId),
      capturedByUserId: adminId,
      conversation: { id: "conv_open", title: "Ops sync", projectId: null },
      candidates: [candidate("Vendor escalation path")],
    });
    await fileExtractedKnowledge({
      owner: workspaceOwner(workspaceId),
      capturedByUserId: adminId,
      conversation: {
        id: "conv_restricted",
        title: "Compensation",
        projectId: null,
      },
      candidates: [candidate("Executive compensation bands")],
    });
    const concepts = await loadOntologyConcepts(workspaceOwner(workspaceId));
    const openConcept = concepts.find(
      (concept) => concept.label === "Vendor escalation path",
    );
    const restrictedConcept = concepts.find(
      (concept) => concept.label === "Executive compensation bands",
    );
    assert.ok(openConcept && restrictedConcept);

    const openSop = await request(`/venom/workspaces/${workspaceId}/sops`, {
      method: "POST",
      body: JSON.stringify(sopInput("open")),
    });
    assertStatus(openSop, 201);
    assert.equal(openSop.body.adminOnly, false);
    const restrictedSop = await request(
      `/venom/workspaces/${workspaceId}/sops`,
      {
        method: "POST",
        body: JSON.stringify({
          ...sopInput("restricted"),
          title: "Executive offboarding",
        }),
      },
    );
    assertStatus(restrictedSop, 201);
    for (const sopId of [openSop.body.id, restrictedSop.body.id]) {
      const published = await request(
        `/venom/workspaces/${workspaceId}/sops/${sopId}/publish`,
        { method: "POST" },
      );
      assertStatus(published, 200);
    }

    // --- Only admins may set the restriction ------------------------------
    activeUserId = memberId;
    const memberRestrict = await request(
      `/venom/workspaces/${workspaceId}/knowledge/${restrictedConcept!.id}/restriction`,
      { method: "PATCH", body: JSON.stringify({ adminOnly: true }) },
    );
    assertStatus(memberRestrict, 403);
    assert.equal(memberRestrict.body.code, "workspace_admin_required");
    const memberRestrictSop = await request(
      `/venom/workspaces/${workspaceId}/sops/${restrictedSop.body.id}/restriction`,
      { method: "PATCH", body: JSON.stringify({ adminOnly: true }) },
    );
    assertStatus(memberRestrictSop, 403);

    activeUserId = outsiderId;
    const outsiderRestrict = await request(
      `/venom/workspaces/${workspaceId}/knowledge/${restrictedConcept!.id}/restriction`,
      { method: "PATCH", body: JSON.stringify({ adminOnly: true }) },
    );
    assertStatus(outsiderRestrict, 403);
    assert.equal(outsiderRestrict.body.code, "workspace_access_denied");

    // --- Admin restricts one cluster and one SOP --------------------------
    activeUserId = adminId;
    const restrictConcept = await request(
      `/venom/workspaces/${workspaceId}/knowledge/${restrictedConcept!.id}/restriction`,
      { method: "PATCH", body: JSON.stringify({ adminOnly: true }) },
    );
    assertStatus(restrictConcept, 200);
    assert.equal(restrictConcept.body.adminOnly, true);
    const restrictSop = await request(
      `/venom/workspaces/${workspaceId}/sops/${restrictedSop.body.id}/restriction`,
      { method: "PATCH", body: JSON.stringify({ adminOnly: true }) },
    );
    assertStatus(restrictSop, 200);
    assert.equal(restrictSop.body.adminOnly, true);
    const missingConcept = await request(
      `/venom/workspaces/${workspaceId}/knowledge/cluster_missing/restriction`,
      { method: "PATCH", body: JSON.stringify({ adminOnly: true }) },
    );
    assertStatus(missingConcept, 404);

    // --- Admin reads still include the items, flagged ---------------------
    const adminKnowledge = await request(
      `/venom/workspaces/${workspaceId}/knowledge`,
    );
    assertStatus(adminKnowledge, 200);
    const adminRestrictedCluster = adminKnowledge.body.clusters.find(
      (cluster: { id: string }) => cluster.id === restrictedConcept!.id,
    );
    assert.equal(adminRestrictedCluster?.adminOnly, true);
    const adminSops = await request(`/venom/workspaces/${workspaceId}/sops`);
    assertStatus(adminSops, 200);
    assert.equal(
      adminSops.body.find(
        (sop: { id: string }) => sop.id === restrictedSop.body.id,
      )?.adminOnly,
      true,
    );

    // --- Member reads are filtered server-side ----------------------------
    activeUserId = memberId;
    const memberKnowledge = await request(
      `/venom/workspaces/${workspaceId}/knowledge`,
    );
    assertStatus(memberKnowledge, 200);
    const memberClusterIds = memberKnowledge.body.clusters.map(
      (cluster: { id: string }) => cluster.id,
    );
    assert.ok(memberClusterIds.includes(openConcept!.id));
    assert.ok(!memberClusterIds.includes(restrictedConcept!.id));
    assert.doesNotMatch(memberKnowledge.text, /Executive compensation bands/);

    const memberSops = await request(`/venom/workspaces/${workspaceId}/sops`);
    assertStatus(memberSops, 200);
    const memberSopIds = memberSops.body.map((sop: { id: string }) => sop.id);
    assert.ok(memberSopIds.includes(openSop.body.id));
    assert.ok(!memberSopIds.includes(restrictedSop.body.id));

    // --- Member writes treat restricted items as nonexistent --------------
    const memberLockConcept = await request(
      `/venom/workspaces/${workspaceId}/knowledge/${restrictedConcept!.id}/sensitivity`,
      { method: "PATCH", body: JSON.stringify({ sensitive: true }) },
    );
    assertStatus(memberLockConcept, 404);
    const memberLockEvidence = await request(
      `/venom/workspaces/${workspaceId}/knowledge/${restrictedConcept!.id}/evidence/conv_restricted/sensitivity`,
      { method: "PATCH", body: JSON.stringify({ sensitive: true }) },
    );
    assertStatus(memberLockEvidence, 404);
    const memberLockSop = await request(
      `/venom/workspaces/${workspaceId}/sops/${restrictedSop.body.id}/sensitivity`,
      { method: "PATCH", body: JSON.stringify({ sensitive: true }) },
    );
    assertStatus(memberLockSop, 404);
    const memberPublish = await request(
      `/venom/workspaces/${workspaceId}/sops/${restrictedSop.body.id}/publish`,
      { method: "POST" },
    );
    assertStatus(memberPublish, 404);
    // The open items still accept member writes.
    const memberLockOpen = await request(
      `/venom/workspaces/${workspaceId}/knowledge/${openConcept!.id}/sensitivity`,
      { method: "PATCH", body: JSON.stringify({ sensitive: true }) },
    );
    assertStatus(memberLockOpen, 200);
    const memberUnlockOpen = await request(
      `/venom/workspaces/${workspaceId}/knowledge/${openConcept!.id}/sensitivity`,
      { method: "PATCH", body: JSON.stringify({ sensitive: false }) },
    );
    assertStatus(memberUnlockOpen, 200);

    // --- Chat context: restricted items never reach a member's chat -------
    const workspaceName = `Restricted Ops ${suffix}`;
    const memberContext = await loadWorkspaceChatContext(
      workspaceId,
      workspaceName,
      "member",
    );
    assert.ok(memberContext.knowledgeBlock);
    assert.doesNotMatch(
      memberContext.knowledgeBlock!,
      /Executive compensation bands/,
    );
    assert.equal(
      memberContext.citationLabels.has(
        `${WORKSPACE_CITATION_PREFIX}${restrictedConcept!.id}`,
      ),
      false,
      "a restricted concept must never mint a member citation id",
    );
    assert.ok(
      memberContext.citationLabels.has(
        `${WORKSPACE_CITATION_PREFIX}${openConcept!.id}`,
      ),
    );
    assert.ok(memberContext.sopBlock);
    assert.doesNotMatch(memberContext.sopBlock!, /Executive offboarding/);

    const adminContext = await loadWorkspaceChatContext(
      workspaceId,
      workspaceName,
      "admin",
    );
    assert.match(adminContext.knowledgeBlock!, /Executive compensation bands/);
    assert.equal(
      adminContext.citationLabels.has(
        `${WORKSPACE_CITATION_PREFIX}${restrictedConcept!.id}`,
      ),
      true,
    );
    assert.match(adminContext.sopBlock!, /Executive offboarding/);

    // --- Exports: member files state the withholding; admin files label ---
    const memberBrainExport = await request(
      `/venom/workspaces/${workspaceId}/export/brain`,
    );
    assertStatus(memberBrainExport, 200);
    assert.doesNotMatch(memberBrainExport.text, /Executive compensation bands/);
    assert.match(
      memberBrainExport.text,
      /\*\*1 admin-only item was withheld from this export\.\*\*/,
    );
    const memberSopsExport = await request(
      `/venom/workspaces/${workspaceId}/export/sops`,
    );
    assertStatus(memberSopsExport, 200);
    assert.doesNotMatch(memberSopsExport.text, /Executive offboarding/);
    assert.match(
      memberSopsExport.text,
      /\*\*1 admin-only item was withheld from this export\.\*\*/,
    );

    activeUserId = adminId;
    const adminBrainExport = await request(
      `/venom/workspaces/${workspaceId}/export/brain`,
    );
    assertStatus(adminBrainExport, 200);
    assert.match(adminBrainExport.text, /Executive compensation bands/);
    assert.match(adminBrainExport.text, /- Admin-only/);
    assert.doesNotMatch(adminBrainExport.text, /withheld from this export/);
    const adminSopsExport = await request(
      `/venom/workspaces/${workspaceId}/export/sops`,
    );
    assertStatus(adminSopsExport, 200);
    assert.match(adminSopsExport.text, /Executive offboarding/);

    // --- The restriction survives the conversation being refiled ----------
    await fileExtractedKnowledge({
      owner: workspaceOwner(workspaceId),
      capturedByUserId: adminId,
      conversation: {
        id: "conv_restricted",
        title: "Compensation",
        projectId: null,
      },
      candidates: [candidate("Executive compensation bands")],
    });
    const refiled = await loadOntologyConcepts(workspaceOwner(workspaceId));
    assert.equal(
      refiled.find((concept) => concept.id === restrictedConcept!.id)
        ?.adminOnly,
      true,
      "refiling the same conversation must not shake off the restriction",
    );

    // --- A member filing a colliding label cannot touch the hidden cluster
    // The extract route files member captures with excludeAdminOnlyConcepts,
    // so the restricted cluster is invisible to the merge working set: no
    // label match, no link target, not even passive strength decay. The
    // colliding label lands in a fresh, unrestricted concept instead of
    // mutating the hidden one.
    const beforeMemberFiling = await loadOntologyConcepts(
      workspaceOwner(workspaceId),
    );
    const hiddenBefore = beforeMemberFiling.find(
      (concept) => concept.id === restrictedConcept!.id,
    );
    assert.ok(hiddenBefore, "the restricted cluster must exist before filing");
    await fileExtractedKnowledge({
      owner: workspaceOwner(workspaceId),
      capturedByUserId: memberId,
      conversation: {
        id: "conv_member_collision",
        title: "Comp chatter",
        projectId: null,
      },
      candidates: [candidate("Executive compensation bands")],
      excludeAdminOnlyConcepts: true,
    });
    const afterMemberFiling = await loadOntologyConcepts(
      workspaceOwner(workspaceId),
    );
    const hiddenAfter = afterMemberFiling.find(
      (concept) => concept.id === restrictedConcept!.id,
    );
    assert.deepEqual(
      hiddenAfter,
      hiddenBefore,
      "a member filing must leave the admin-only cluster untouched — no merge, no decay, no links",
    );
    const memberCopy = afterMemberFiling.find(
      (concept) =>
        concept.label === "Executive compensation bands" &&
        concept.id !== restrictedConcept!.id,
    );
    assert.ok(
      memberCopy,
      "the colliding label must file into a fresh concept, not merge into the hidden one",
    );
    assert.notEqual(
      memberCopy!.adminOnly,
      true,
      "the member's copy must not inherit the restriction",
    );
    assert.equal(
      memberCopy!.links.includes(restrictedConcept!.id),
      false,
      "the member's copy must not link against the hidden cluster",
    );

    // --- Admin clears the restriction; the member sees the items again ----
    const clearConcept = await request(
      `/venom/workspaces/${workspaceId}/knowledge/${restrictedConcept!.id}/restriction`,
      { method: "PATCH", body: JSON.stringify({ adminOnly: false }) },
    );
    assertStatus(clearConcept, 200);
    // Cluster payloads carry the flag only when set (same contract as
    // `sensitive`), so a cleared restriction reads as absent — never true.
    assert.notEqual(clearConcept.body.adminOnly, true);
    const clearSop = await request(
      `/venom/workspaces/${workspaceId}/sops/${restrictedSop.body.id}/restriction`,
      { method: "PATCH", body: JSON.stringify({ adminOnly: false }) },
    );
    assertStatus(clearSop, 200);
    assert.equal(clearSop.body.adminOnly, false);

    activeUserId = memberId;
    const memberKnowledgeAfter = await request(
      `/venom/workspaces/${workspaceId}/knowledge`,
    );
    assertStatus(memberKnowledgeAfter, 200);
    assert.ok(
      memberKnowledgeAfter.body.clusters.some(
        (cluster: { id: string }) => cluster.id === restrictedConcept!.id,
      ),
    );
    const memberSopsAfter = await request(
      `/venom/workspaces/${workspaceId}/sops`,
    );
    assertStatus(memberSopsAfter, 200);
    assert.ok(
      memberSopsAfter.body.some(
        (sop: { id: string }) => sop.id === restrictedSop.body.id,
      ),
    );
  } finally {
    server.close();
    restoreAuth();
    restoreDirectory();
  }
});
