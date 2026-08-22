/**
 * Real-database integration tests for sensitivity locks and safe export:
 * member-controlled locks on workspace knowledge and SOPs, the admin-only
 * export policy setting, and the markdown exports where that policy is
 * enforced server-side — locked items withheld with an explicit statement,
 * personal exports always available and always personal-only.
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
  venomSopsTable,
} from "@workspace/db";
import { inArray, sql } from "drizzle-orm";
import express from "express";
import router, {
  overrideSharedWorkspaceUserDirectoryForTests,
  overrideSharedWorkspaceUserIdResolverForTests,
} from "./venom-shared-workspaces.js";
import exportsRouter, {
  overrideVenomExportUserIdResolverForTests,
} from "./venom-exports.js";
import {
  fileExtractedKnowledge,
  loadOntologyConcepts,
  userOwner,
  workspaceOwner,
} from "../lib/venom-ontology-store.js";
import { workspaceSopOwnerKey } from "../lib/workspace-membership.js";

type TestResponse = {
  status: number;
  body: any;
  text: string;
  headers: Headers;
};

async function ensureSharedWorkspaceTestSchema(): Promise<void> {
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
    ALTER TABLE venom_shared_workspaces
      ADD COLUMN IF NOT EXISTS allow_sensitive_export boolean NOT NULL DEFAULT true
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
      ADD COLUMN IF NOT EXISTS sensitive boolean NOT NULL DEFAULT false
  `);
  await db.execute(sql`
    ALTER TABLE venom_ontology_evidence
      ADD COLUMN IF NOT EXISTS sensitive boolean NOT NULL DEFAULT false
  `);
  await db.execute(sql`
    ALTER TABLE venom_sops
      ADD COLUMN IF NOT EXISTS sensitive boolean NOT NULL DEFAULT false
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
  title: `Refund handling ${marker}`,
  category: "operations",
  tags: ["refunds"],
  provenance: "manual",
  content: {
    purpose: `How we approve refunds (${marker})`,
    prerequisites: ["Order lookup access"],
    inputs: ["Order id"],
    guidance: ["Verify the order exists", "Approve refunds under 100 USD"],
    requiredApprovals: ["Lead approval above 100 USD"],
    acceptanceChecks: ["Customer notified"],
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
  const ownerIds = [...createdWorkspaceIds, ...createdUserIds];
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
      .delete(venomSopsTable)
      .where(inArray(venomSopsTable.clerkUserId, createdUserIds));
  }
  if (createdWorkspaceIds.length > 0) {
    await db.delete(venomSopsTable).where(
      inArray(
        venomSopsTable.clerkUserId,
        createdWorkspaceIds.map((id) => workspaceSopOwnerKey(id)),
      ),
    );
    await db
      .delete(venomSharedWorkspacesTable)
      .where(inArray(venomSharedWorkspacesTable.id, createdWorkspaceIds));
  }
}

test.after(async () => {
  await cleanup();
  await pool.end();
});

test("sensitivity locks and policy-enforced markdown export", async () => {
  await ensureSharedWorkspaceTestSchema();
  const suffix = randomUUID();
  const adminId = `sx-admin-${suffix}`;
  const memberId = `sx-member-${suffix}`;
  const outsiderId = `sx-outsider-${suffix}`;
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
  const restoreExportAuth = overrideVenomExportUserIdResolverForTests(
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
  app.use(exportsRouter);
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
      body: JSON.stringify({ name: `Sensitive Ops ${suffix}` }),
    });
    assertStatus(created, 201);
    const workspaceId: string = created.body.id;
    createdWorkspaceIds.push(workspaceId);
    const addMember = await request(`/venom/workspaces/${workspaceId}/members`, {
      method: "POST",
      body: JSON.stringify({ userId: memberId }),
    });
    assertStatus(addMember, 201);

    // --- Seed workspace knowledge (two clusters) and SOPs (two) ---------
    await fileExtractedKnowledge({
      owner: workspaceOwner(workspaceId),
      capturedByUserId: adminId,
      conversation: { id: "conv_open", title: "Ops sync", projectId: null },
      candidates: [candidate("Vendor escalation path")],
    });
    await fileExtractedKnowledge({
      owner: workspaceOwner(workspaceId),
      capturedByUserId: memberId,
      conversation: { id: "conv_locked", title: "Payroll", projectId: null },
      candidates: [candidate("Payroll bank details")],
    });
    const concepts = await loadOntologyConcepts(workspaceOwner(workspaceId));
    const openConcept = concepts.find(
      (concept) => concept.label === "Vendor escalation path",
    );
    const lockedConcept = concepts.find(
      (concept) => concept.label === "Payroll bank details",
    );
    assert.ok(openConcept && lockedConcept);

    const openSop = await request(`/venom/workspaces/${workspaceId}/sops`, {
      method: "POST",
      body: JSON.stringify(sopInput("open")),
    });
    assertStatus(openSop, 201);
    assert.equal(openSop.body.sensitive, false);
    const lockedSop = await request(`/venom/workspaces/${workspaceId}/sops`, {
      method: "POST",
      body: JSON.stringify({
        ...sopInput("locked"),
        title: "Payout credentials rotation",
      }),
    });
    assertStatus(lockedSop, 201);

    // --- Any member can lock; outsiders cannot ---------------------------
    activeUserId = memberId;
    const lockConcept = await request(
      `/venom/workspaces/${workspaceId}/knowledge/${lockedConcept!.id}/sensitivity`,
      { method: "PATCH", body: JSON.stringify({ sensitive: true }) },
    );
    assertStatus(lockConcept, 200);
    assert.equal(lockConcept.body.sensitive, true);

    const lockEvidence = await request(
      `/venom/workspaces/${workspaceId}/knowledge/${openConcept!.id}/evidence/conv_open/sensitivity`,
      { method: "PATCH", body: JSON.stringify({ sensitive: true }) },
    );
    assertStatus(lockEvidence, 200);
    assert.equal(
      lockEvidence.body.sources.find(
        (source: { conversationId: string }) =>
          source.conversationId === "conv_open",
      )?.sensitive,
      true,
    );

    const lockSop = await request(
      `/venom/workspaces/${workspaceId}/sops/${lockedSop.body.id}/sensitivity`,
      { method: "PATCH", body: JSON.stringify({ sensitive: true }) },
    );
    assertStatus(lockSop, 200);
    assert.equal(lockSop.body.sensitive, true);

    // Locked state is visible on the ordinary member reads.
    const knowledge = await request(
      `/venom/workspaces/${workspaceId}/knowledge`,
    );
    assertStatus(knowledge, 200);
    const lockedInList = knowledge.body.clusters.find(
      (cluster: { id: string }) => cluster.id === lockedConcept!.id,
    );
    assert.equal(lockedInList.sensitive, true);
    const sopList = await request(`/venom/workspaces/${workspaceId}/sops`);
    assertStatus(sopList, 200);
    assert.equal(
      sopList.body.find(
        (sop: { id: string }) => sop.id === lockedSop.body.id,
      ).sensitive,
      true,
    );

    // Unknown targets 404; outsiders get the access-denied body.
    const missing = await request(
      `/venom/workspaces/${workspaceId}/knowledge/cluster_missing/sensitivity`,
      { method: "PATCH", body: JSON.stringify({ sensitive: true }) },
    );
    assertStatus(missing, 404);
    activeUserId = outsiderId;
    for (const [path, method] of [
      [
        `/venom/workspaces/${workspaceId}/knowledge/${lockedConcept!.id}/sensitivity`,
        "PATCH",
      ],
      [`/venom/workspaces/${workspaceId}/export/brain`, "GET"],
      [`/venom/workspaces/${workspaceId}/settings`, "GET"],
    ] as const) {
      const denied = await request(path, {
        method,
        ...(method === "PATCH"
          ? { body: JSON.stringify({ sensitive: true }) }
          : {}),
      });
      assertStatus(denied, 403);
      assert.equal(denied.body.code, "workspace_access_denied");
    }

    // --- Settings are admin-only; default allows sensitive export -------
    activeUserId = memberId;
    const memberSettings = await request(
      `/venom/workspaces/${workspaceId}/settings`,
    );
    assertStatus(memberSettings, 403);
    const memberWrite = await request(
      `/venom/workspaces/${workspaceId}/settings`,
      { method: "PUT", body: JSON.stringify({ allowSensitiveExport: false }) },
    );
    assertStatus(memberWrite, 403);

    activeUserId = adminId;
    const defaults = await request(`/venom/workspaces/${workspaceId}/settings`);
    assertStatus(defaults, 200);
    assert.equal(defaults.body.allowSensitiveExport, true);

    // --- Export with the default policy: locked items included, labeled --
    const openExport = await request(
      `/venom/workspaces/${workspaceId}/export/brain`,
    );
    assertStatus(openExport, 200);
    assert.match(
      openExport.headers.get("content-type") ?? "",
      /text\/markdown/,
    );
    assert.match(
      openExport.headers.get("content-disposition") ?? "",
      /attachment; filename="venom-sensitive-ops-.*-brain-.*\.md"/,
    );
    assert.match(openExport.text, /Payroll bank details/);
    assert.match(openExport.text, /Marked sensitive/);
    assert.doesNotMatch(openExport.text, /withheld by the workspace export policy/);

    // --- Admin turns the export lock on ---------------------------------
    const updated = await request(`/venom/workspaces/${workspaceId}/settings`, {
      method: "PUT",
      body: JSON.stringify({ allowSensitiveExport: false }),
    });
    assertStatus(updated, 200);
    assert.equal(updated.body.allowSensitiveExport, false);

    // --- Locked content stays inside; the file says what was withheld ----
    activeUserId = memberId;
    const guardedBrain = await request(
      `/venom/workspaces/${workspaceId}/export/brain`,
    );
    assertStatus(guardedBrain, 200);
    assert.doesNotMatch(guardedBrain.text, /Payroll bank details/);
    assert.doesNotMatch(guardedBrain.text, /conv_open/);
    assert.match(guardedBrain.text, /Vendor escalation path/);
    // One locked cluster + one locked evidence entry = two withheld items.
    assert.match(
      guardedBrain.text,
      /\*\*2 sensitive items were withheld by the workspace export policy\.\*\*/,
    );
    assert.match(
      guardedBrain.text,
      /1 sensitive evidence entry withheld by the workspace export policy/,
    );

    const guardedSops = await request(
      `/venom/workspaces/${workspaceId}/export/sops`,
    );
    assertStatus(guardedSops, 200);
    assert.doesNotMatch(guardedSops.text, /Payout credentials rotation/);
    assert.match(guardedSops.text, /Refund handling open/);
    assert.match(
      guardedSops.text,
      /\*\*1 sensitive item was withheld by the workspace export policy\.\*\*/,
    );

    // --- A lock survives the same conversation being refiled -------------
    await fileExtractedKnowledge({
      owner: workspaceOwner(workspaceId),
      capturedByUserId: adminId,
      conversation: { id: "conv_open", title: "Ops sync", projectId: null },
      candidates: [candidate("Vendor escalation path")],
    });
    const refiled = await loadOntologyConcepts(workspaceOwner(workspaceId));
    const refiledConcept = refiled.find(
      (concept) => concept.id === openConcept!.id,
    );
    assert.equal(
      refiledConcept?.sources.find(
        (source) => source.conversationId === "conv_open",
      )?.sensitive,
      true,
      "evidence lock must survive refiling of the same conversation",
    );
    const refiledLocked = refiled.find(
      (concept) => concept.id === lockedConcept!.id,
    );
    assert.equal(refiledLocked?.sensitive, true);

    // --- Unlock works and shows up everywhere ---------------------------
    const unlock = await request(
      `/venom/workspaces/${workspaceId}/sops/${lockedSop.body.id}/sensitivity`,
      { method: "PATCH", body: JSON.stringify({ sensitive: false }) },
    );
    assertStatus(unlock, 200);
    assert.equal(unlock.body.sensitive, false);
    const unlockedSops = await request(
      `/venom/workspaces/${workspaceId}/export/sops`,
    );
    assert.match(unlockedSops.text, /Payout credentials rotation/);

    // --- Personal export: own tier only, always available ---------------
    await fileExtractedKnowledge({
      owner: userOwner(memberId),
      capturedByUserId: memberId,
      conversation: { id: "conv_mine", title: "My notes", projectId: null },
      candidates: [candidate("Personal pet project")],
    });
    // Seed a personal SOP directly; the personal SOP router is a separate
    // surface and is not what this suite exercises.
    await db.insert(venomSopsTable).values({
      clerkUserId: memberId,
      title: "My own checklist",
      category: "operations",
      tags: ["mine"],
      provenance: "manual",
      content: sopInput("personal").content,
      lifecycle: "draft",
    });

    const personalBrain = await request("/venom/exports/brain");
    assertStatus(personalBrain, 200);
    assert.match(
      personalBrain.headers.get("content-disposition") ?? "",
      /attachment; filename="venom-personal-brain-.*\.md"/,
    );
    assert.match(personalBrain.text, /Personal pet project/);
    assert.doesNotMatch(personalBrain.text, /Vendor escalation path/);
    assert.doesNotMatch(personalBrain.text, /Payroll bank details/);

    const personalSops = await request("/venom/exports/sops");
    assertStatus(personalSops, 200);
    assert.match(personalSops.text, /My own checklist/);
    assert.doesNotMatch(personalSops.text, /Refund handling open/);

    const badKind = await request("/venom/exports/everything");
    assertStatus(badKind, 400);

    // --- Removal: workspace export gone, personal export intact ---------
    activeUserId = adminId;
    const removed = await request(
      `/venom/workspaces/${workspaceId}/members/${memberId}`,
      { method: "DELETE" },
    );
    assertStatus(removed, 200);

    activeUserId = memberId;
    const deniedExport = await request(
      `/venom/workspaces/${workspaceId}/export/brain`,
    );
    assertStatus(deniedExport, 403);
    assert.equal(deniedExport.body.code, "workspace_access_denied");
    const stillPersonal = await request("/venom/exports/brain");
    assertStatus(stillPersonal, 200);
    assert.match(stillPersonal.text, /Personal pet project/);
    assert.doesNotMatch(stillPersonal.text, /Vendor escalation path/);
  } finally {
    server.close();
    restoreAuth();
    restoreExportAuth();
    restoreDirectory();
  }
});
