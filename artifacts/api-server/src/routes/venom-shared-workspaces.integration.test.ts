/**
 * Real-database integration tests for shared workspaces: creation,
 * membership with admin/member roles, in-place role changes (promote and
 * demote without removal), membership-checked knowledge and SOP reads, and
 * — the heart of the feature — revocation that takes effect on the removed
 * member's next request while everyone else's view and the removed
 * member's personal tier stay intact.
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
  venomSopsTable,
} from "@workspace/db";
import { and, eq, inArray, sql } from "drizzle-orm";
import express from "express";
import router, {
  overrideSharedWorkspaceUserDirectoryForTests,
  overrideSharedWorkspaceUserIdResolverForTests,
} from "./venom-shared-workspaces.js";
import venomRouter from "./venom.js";
import venomKnowledgeMovesRouter from "./venom-knowledge-moves-router.js";
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
    CREATE INDEX IF NOT EXISTS venom_shared_workspaces_creator_idx
      ON venom_shared_workspaces (created_by_clerk_user_id)
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
    CREATE INDEX IF NOT EXISTS venom_shared_workspace_members_user_idx
      ON venom_shared_workspace_members (clerk_user_id)
  `);
}

function assertStatus(response: TestResponse, expected: number): void {
  assert.equal(
    response.status,
    expected,
    `Expected HTTP ${expected}; received ${response.status}: ${JSON.stringify(response.body)}`,
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
  if (createdWorkspaceIds.length > 0) {
    // Revisions cascade from SOPs; members cascade from workspaces.
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

test("shared workspaces enforce membership, roles, and next-request revocation", async () => {
  await ensureSharedWorkspaceTestSchema();
  const suffix = randomUUID();
  const adminId = `ws-admin-${suffix}`;
  const memberId = `ws-member-${suffix}`;
  const secondAdminId = `ws-admin2-${suffix}`;
  const outsiderId = `ws-outsider-${suffix}`;
  createdUserIds.push(adminId, memberId, secondAdminId, outsiderId);

  const knownAccounts = new Map<string, string | null>([
    [adminId, "Ada Admin"],
    [memberId, "Mo Member"],
    [secondAdminId, "Sam Second"],
    [outsiderId, "Olly Outsider"],
  ]);
  let directoryDown = false;

  let activeUserId = adminId;
  const restoreAuth = overrideSharedWorkspaceUserIdResolverForTests(
    () => activeUserId,
  );
  const restoreDirectory = overrideSharedWorkspaceUserDirectoryForTests({
    async getUser(userId) {
      if (directoryDown) throw new Error("directory offline");
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
    const rawBody = await response.text();
    let body: unknown = null;
    if (rawBody) {
      try {
        body = JSON.parse(rawBody);
      } catch {
        body = { rawBody: rawBody.slice(0, 2_000) };
      }
    }
    return { status: response.status, body };
  }

  try {
    // --- Create: caller becomes the first admin -------------------------
    const created = await request("/venom/workspaces", {
      method: "POST",
      body: JSON.stringify({ name: `Acme Ops ${suffix}` }),
    });
    assertStatus(created, 201);
    const workspaceId: string = created.body.id;
    createdWorkspaceIds.push(workspaceId);
    assert.equal(created.body.role, "admin");
    assert.equal(created.body.memberCount, 1);

    const blankName = await request("/venom/workspaces", {
      method: "POST",
      body: JSON.stringify({ name: "   " }),
    });
    assertStatus(blankName, 400);

    // --- Non-members are denied with the eviction code ------------------
    activeUserId = memberId;
    const preJoinList = await request("/venom/workspaces");
    assertStatus(preJoinList, 200);
    assert.equal(preJoinList.body.length, 0);
    for (const path of [
      `/venom/workspaces/${workspaceId}/members`,
      `/venom/workspaces/${workspaceId}/knowledge`,
      `/venom/workspaces/${workspaceId}/sops`,
    ]) {
      const denied = await request(path);
      assertStatus(denied, 403);
      assert.equal(denied.body.code, "workspace_access_denied");
    }

    // Unknown and malformed workspace ids: identical denial (no probing).
    const unknownWs = await request(
      `/venom/workspaces/${randomUUID()}/knowledge`,
    );
    assertStatus(unknownWs, 403);
    assert.equal(unknownWs.body.code, "workspace_access_denied");
    const malformedWs = await request(
      "/venom/workspaces/not-a-uuid/knowledge",
    );
    assertStatus(malformedWs, 403);

    // --- Members cannot manage membership; admins can -------------------
    activeUserId = adminId;
    const directoryFail = (() => {
      directoryDown = true;
      return request(`/venom/workspaces/${workspaceId}/members`, {
        method: "POST",
        body: JSON.stringify({ userId: memberId }),
      });
    })();
    assertStatus(await directoryFail, 502);
    directoryDown = false;

    const unknownAccount = await request(
      `/venom/workspaces/${workspaceId}/members`,
      {
        method: "POST",
        body: JSON.stringify({ userId: `ghost-${suffix}` }),
      },
    );
    assertStatus(unknownAccount, 404);

    const added = await request(`/venom/workspaces/${workspaceId}/members`, {
      method: "POST",
      body: JSON.stringify({ userId: memberId }),
    });
    assertStatus(added, 201);
    assert.equal(added.body.role, "member");
    assert.equal(added.body.name, "Mo Member");

    const duplicate = await request(
      `/venom/workspaces/${workspaceId}/members`,
      {
        method: "POST",
        body: JSON.stringify({ userId: memberId }),
      },
    );
    assertStatus(duplicate, 409);

    activeUserId = memberId;
    const memberAdds = await request(
      `/venom/workspaces/${workspaceId}/members`,
      {
        method: "POST",
        body: JSON.stringify({ userId: outsiderId }),
      },
    );
    assertStatus(memberAdds, 403);
    // A member is refused with the admin-required code — never the
    // access-denied code, which clients treat as membership loss.
    assert.equal(memberAdds.body.code, "workspace_admin_required");
    const memberRemoves = await request(
      `/venom/workspaces/${workspaceId}/members/${adminId}`,
      { method: "DELETE" },
    );
    assertStatus(memberRemoves, 403);
    assert.equal(memberRemoves.body.code, "workspace_admin_required");

    // Both accounts see the same member list with roles.
    const memberList = await request(
      `/venom/workspaces/${workspaceId}/members`,
    );
    assertStatus(memberList, 200);
    assert.equal(memberList.body.length, 2);
    const roles = new Map(
      memberList.body.map((entry: { userId: string; role: string }) => [
        entry.userId,
        entry.role,
      ]),
    );
    assert.equal(roles.get(adminId), "admin");
    assert.equal(roles.get(memberId), "member");

    // --- Role changes happen in place, never via remove/re-add -----------
    // Non-admins cannot change roles (activeUserId is still the member).
    const memberPromotes = await request(
      `/venom/workspaces/${workspaceId}/members/${memberId}`,
      { method: "PATCH", body: JSON.stringify({ role: "admin" }) },
    );
    assertStatus(memberPromotes, 403);
    assert.equal(memberPromotes.body.code, "workspace_admin_required");

    activeUserId = adminId;
    // The last admin cannot be demoted — same 409 rule as removal.
    const lastAdminDemoted = await request(
      `/venom/workspaces/${workspaceId}/members/${adminId}`,
      { method: "PATCH", body: JSON.stringify({ role: "member" }) },
    );
    assertStatus(lastAdminDemoted, 409);

    const ghostRoleChange = await request(
      `/venom/workspaces/${workspaceId}/members/ghost-${suffix}`,
      { method: "PATCH", body: JSON.stringify({ role: "admin" }) },
    );
    assertStatus(ghostRoleChange, 404);

    const bogusRole = await request(
      `/venom/workspaces/${workspaceId}/members/${memberId}`,
      { method: "PATCH", body: JSON.stringify({ role: "owner" }) },
    );
    assertStatus(bogusRole, 400);

    // Promote: effective from the member's next request, nothing revoked.
    const promoted = await request(
      `/venom/workspaces/${workspaceId}/members/${memberId}`,
      { method: "PATCH", body: JSON.stringify({ role: "admin" }) },
    );
    assertStatus(promoted, 200);
    assert.equal(promoted.body.userId, memberId);
    assert.equal(promoted.body.role, "admin");
    assert.equal(promoted.body.name, "Mo Member");

    // The promotion is real: the promoted member may now demote the other
    // admin (allowed while two admins exist) — proof they hold admin power
    // without ever having been removed and re-added.
    activeUserId = memberId;
    const demotedByPromoted = await request(
      `/venom/workspaces/${workspaceId}/members/${adminId}`,
      { method: "PATCH", body: JSON.stringify({ role: "member" }) },
    );
    assertStatus(demotedByPromoted, 200);
    assert.equal(demotedByPromoted.body.userId, adminId);
    assert.equal(demotedByPromoted.body.role, "member");

    const swappedList = await request(
      `/venom/workspaces/${workspaceId}/members`,
    );
    assertStatus(swappedList, 200);
    const swappedRoles = new Map(
      swappedList.body.map((entry: { userId: string; role: string }) => [
        entry.userId,
        entry.role,
      ]),
    );
    assert.equal(swappedRoles.get(adminId), "member");
    assert.equal(swappedRoles.get(memberId), "admin");

    // The demoted account keeps plain membership: reads still work.
    activeUserId = adminId;
    const demotedStillReads = await request(
      `/venom/workspaces/${workspaceId}/members`,
    );
    assertStatus(demotedStillReads, 200);

    // Admin-gated endpoints refuse the demoted admin with the
    // admin-required code, NOT the access-denied code — their device must
    // not evict the workspace as if they had been removed.
    const demotedSettings = await request(
      `/venom/workspaces/${workspaceId}/settings`,
    );
    assertStatus(demotedSettings, 403);
    assert.equal(demotedSettings.body.code, "workspace_admin_required");

    // Now the promoted member is the last admin: stepping down is refused.
    activeUserId = memberId;
    const selfDemotion = await request(
      `/venom/workspaces/${workspaceId}/members/${memberId}`,
      { method: "PATCH", body: JSON.stringify({ role: "member" }) },
    );
    assertStatus(selfDemotion, 409);

    // Restore the original roles for the rest of the flow.
    const restoredAdmin = await request(
      `/venom/workspaces/${workspaceId}/members/${adminId}`,
      { method: "PATCH", body: JSON.stringify({ role: "admin" }) },
    );
    assertStatus(restoredAdmin, 200);
    activeUserId = adminId;
    const restoredMember = await request(
      `/venom/workspaces/${workspaceId}/members/${memberId}`,
      { method: "PATCH", body: JSON.stringify({ role: "member" }) },
    );
    assertStatus(restoredMember, 200);
    assert.equal(restoredMember.body.role, "member");

    // --- Shared knowledge: filed once, visible to every member ----------
    await fileExtractedKnowledge({
      owner: workspaceOwner(workspaceId),
      capturedByUserId: adminId,
      conversation: { id: "conv_ws", title: "Ops sync", projectId: null },
      candidates: [candidate("Vendor escalation path")],
    });
    await fileExtractedKnowledge({
      owner: userOwner(memberId),
      capturedByUserId: memberId,
      conversation: { id: "conv_personal", title: "My notes", projectId: null },
      candidates: [candidate("Personal pet project")],
    });

    for (const userId of [memberId, adminId]) {
      activeUserId = userId;
      const knowledge = await request(
        `/venom/workspaces/${workspaceId}/knowledge`,
      );
      assertStatus(knowledge, 200);
      assert.equal(knowledge.body.clusters.length, 1);
      assert.equal(knowledge.body.clusters[0].label, "Vendor escalation path");
    }

    // Workspace store never leaks personal concepts (and vice versa).
    const workspaceConcepts = await loadOntologyConcepts(
      workspaceOwner(workspaceId),
    );
    assert.deepEqual(
      workspaceConcepts.map((concept) => concept.label),
      ["Vendor escalation path"],
    );

    // --- Workspace SOPs: any member can draft and publish ---------------
    activeUserId = memberId;
    const sopCreated = await request(
      `/venom/workspaces/${workspaceId}/sops`,
      {
        method: "POST",
        body: JSON.stringify(sopInput(suffix.slice(0, 8))),
      },
    );
    assertStatus(sopCreated, 201);
    assert.equal(sopCreated.body.lifecycle, "draft");
    const sopId: string = sopCreated.body.id;

    const published = await request(
      `/venom/workspaces/${workspaceId}/sops/${sopId}/publish`,
      { method: "POST" },
    );
    assertStatus(published, 200);
    assert.equal(published.body.versionNumber, 1);

    activeUserId = adminId;
    const sopList = await request(`/venom/workspaces/${workspaceId}/sops`);
    assertStatus(sopList, 200);
    assert.equal(sopList.body.length, 1);
    assert.equal(sopList.body[0].lifecycle, "active");

    // --- Revocation: denial starts at the removed member's next request -
    const removed = await request(
      `/venom/workspaces/${workspaceId}/members/${memberId}`,
      { method: "DELETE" },
    );
    assertStatus(removed, 200);
    assert.equal(removed.body.removedUserId, memberId);

    activeUserId = memberId;
    for (const path of [
      `/venom/workspaces/${workspaceId}/knowledge`,
      `/venom/workspaces/${workspaceId}/sops`,
      `/venom/workspaces/${workspaceId}/members`,
    ]) {
      const revoked = await request(path);
      assertStatus(revoked, 403);
      assert.equal(revoked.body.code, "workspace_access_denied");
    }
    const revokedList = await request("/venom/workspaces");
    assertStatus(revokedList, 200);
    assert.equal(revokedList.body.length, 0);

    // Removing again: gone means gone.
    activeUserId = adminId;
    const removedTwice = await request(
      `/venom/workspaces/${workspaceId}/members/${memberId}`,
      { method: "DELETE" },
    );
    assertStatus(removedTwice, 404);

    // --- The workspace is untouched for remaining members ---------------
    const adminKnowledge = await request(
      `/venom/workspaces/${workspaceId}/knowledge`,
    );
    assertStatus(adminKnowledge, 200);
    assert.equal(adminKnowledge.body.clusters.length, 1);
    const adminSops = await request(`/venom/workspaces/${workspaceId}/sops`);
    assertStatus(adminSops, 200);
    assert.equal(adminSops.body.length, 1);

    // --- The removed member's personal tier is untouched -----------------
    const personalConcepts = await loadOntologyConcepts(userOwner(memberId));
    assert.deepEqual(
      personalConcepts.map((concept) => concept.label),
      ["Personal pet project"],
    );

    // --- Last-admin protection ------------------------------------------
    const selfRemove = await request(
      `/venom/workspaces/${workspaceId}/members/${adminId}`,
      { method: "DELETE" },
    );
    assertStatus(selfRemove, 409);

    const secondAdmin = await request(
      `/venom/workspaces/${workspaceId}/members`,
      {
        method: "POST",
        body: JSON.stringify({ userId: secondAdminId, role: "admin" }),
      },
    );
    assertStatus(secondAdmin, 201);
    assert.equal(secondAdmin.body.role, "admin");

    const firstAdminLeaves = await request(
      `/venom/workspaces/${workspaceId}/members/${adminId}`,
      { method: "DELETE" },
    );
    assertStatus(firstAdminLeaves, 200);

    activeUserId = secondAdminId;
    const lastAdminBlocked = await request(
      `/venom/workspaces/${workspaceId}/members/${secondAdminId}`,
      { method: "DELETE" },
    );
    assertStatus(lastAdminBlocked, 409);
    const finalMembers = await request(
      `/venom/workspaces/${workspaceId}/members`,
    );
    assertStatus(finalMembers, 200);
    assert.equal(finalMembers.body.length, 1);
    assert.equal(finalMembers.body[0].role, "admin");
  } finally {
    restoreAuth();
    restoreDirectory();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await db
      .delete(venomSharedWorkspaceMembersTable)
      .where(
        inArray(venomSharedWorkspaceMembersTable.clerkUserId, [
          adminId,
          memberId,
          secondAdminId,
          outsiderId,
        ]),
      );
  }
});

test("venom chat and extraction routes gate workspace requests by current membership", async () => {
  await ensureSharedWorkspaceTestSchema();
  const suffix = randomUUID();
  const memberId = `ws-chatgate-member-${suffix}`;
  const outsiderId = `ws-chatgate-outsider-${suffix}`;
  createdUserIds.push(memberId, outsiderId);

  const [workspace] = await db
    .insert(venomSharedWorkspacesTable)
    .values({ name: "Chat Gate Co", createdByClerkUserId: memberId })
    .returning({ id: venomSharedWorkspacesTable.id });
  assert.ok(workspace);
  createdWorkspaceIds.push(workspace.id);
  await db.insert(venomSharedWorkspaceMembersTable).values({
    workspaceId: workspace.id,
    clerkUserId: memberId,
    role: "admin",
    addedByClerkUserId: memberId,
  });

  // The venom chat router authenticates through Clerk's getAuth, which
  // requires the branded req.auth function clerkMiddleware would attach.
  let actingUserId = memberId;
  const clerkAuthBrand = Symbol.for("@clerk/express.auth");
  const app = express();
  app.use(express.json());
  app.use((request, _response, next) => {
    request.log = {
      info: () => {},
      warn: () => {},
      error: () => {},
    } as unknown as typeof request.log;
    (request as { auth?: unknown }).auth = Object.assign(
      () => ({ userId: actingUserId, tokenType: "session_token" }),
      { [clerkAuthBrand]: true },
    );
    next();
  });
  app.use(venomRouter);
  app.use(venomKnowledgeMovesRouter);
  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    // The model catalog endpoint returns the catalog, not deliberation
    // availability, and the availability contract lives on its own route.
    const models = await fetch(`${baseUrl}/venom/models`);
    assert.equal(models.status, 200);
    const catalog = (await models.json()) as Array<{ id?: unknown }>;
    assert.ok(
      Array.isArray(catalog) && catalog.length > 0,
      "GET /venom/models must return the model catalog array",
    );
    assert.equal(typeof catalog[0]?.id, "string");
    const availability = await fetch(`${baseUrl}/venom/deliberation`);
    assert.equal(availability.status, 200);
    const availabilityBody = (await availability.json()) as {
      available?: unknown;
    };
    assert.notEqual(
      availabilityBody.available,
      undefined,
      "GET /venom/deliberation must report deliberation availability",
    );

    // Chat validates the chat contract: a note-improvement payload must be
    // rejected instead of parsed by the wrong schema.
    const noteShaped = await fetch(`${baseUrl}/venom/respond`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ note: "polish this" }),
    });
    assert.equal(noteShaped.status, 400);

    // A caller-selected workspace controls chat/extraction billing, so an
    // outsider (including a removed former member) must be rejected before a
    // request can spend that workspace's Organization allowance.
    actingUserId = outsiderId;
    const deniedExtraction = await fetch(`${baseUrl}/venom/knowledge/extract`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        workspaceId: workspace.id,
        conversation: { id: "former-member-chat", title: "No access" },
        messages: [{ id: "m1", role: "user", content: "Do not bill this room." }],
      }),
    });
    assert.equal(deniedExtraction.status, 403);
    const deniedExtractionBody = (await deniedExtraction.json()) as {
      code?: string;
    };
    assert.equal(deniedExtractionBody.code, "workspace_access_denied");

    const deniedMove = await fetch(
      `${baseUrl}/venom/knowledge/unsorted/concept-x/move`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ workspaceId: workspace.id }),
      },
    );
    assert.equal(deniedMove.status, 403);
    const deniedMoveBody = (await deniedMove.json()) as { code?: string };
    assert.equal(deniedMoveBody.code, "workspace_access_denied");
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
});

test("concurrent admin-removing mutations never strand a workspace without admins", async () => {
  await ensureSharedWorkspaceTestSchema();
  const suffix = randomUUID();
  const adminA = `race-admin-a-${suffix}`;
  const adminB = `race-admin-b-${suffix}`;
  createdUserIds.push(adminA, adminB);

  // Two actors must act at the same moment, so the resolver reads the
  // acting account from a per-request header instead of shared state.
  const restoreAuth = overrideSharedWorkspaceUserIdResolverForTests(
    (request) => {
      const actor = request.headers["x-test-actor"];
      return typeof actor === "string" ? actor : null;
    },
  );
  const restoreDirectory = overrideSharedWorkspaceUserDirectoryForTests({
    async getUser(userId) {
      return { id: userId, name: null };
    },
    async getUsers(userIds) {
      return new Map(userIds.map((userId) => [userId, null]));
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

  async function requestAs(
    actorId: string,
    path: string,
    options: RequestInit = {},
  ): Promise<TestResponse> {
    const response = await fetch(`${baseUrl}${path}`, {
      ...options,
      headers: {
        "content-type": "application/json",
        "x-test-actor": actorId,
        ...options.headers,
      },
    });
    const rawBody = await response.text();
    let body: unknown = null;
    if (rawBody) {
      try {
        body = JSON.parse(rawBody);
      } catch {
        body = { rawBody: rawBody.slice(0, 2_000) };
      }
    }
    return { status: response.status, body };
  }

  try {
    const created = await requestAs(adminA, "/venom/workspaces", {
      method: "POST",
      body: JSON.stringify({ name: `Race Ops ${suffix}` }),
    });
    assertStatus(created, 201);
    const workspaceId: string = created.body.id;
    createdWorkspaceIds.push(workspaceId);

    const addSecondAdmin = await requestAs(
      adminA,
      `/venom/workspaces/${workspaceId}/members`,
      {
        method: "POST",
        body: JSON.stringify({ userId: adminB, role: "admin" }),
      },
    );
    assertStatus(addSecondAdmin, 201);

    // --- Race 1: both admins step down at the same moment ---------------
    // Whatever the interleaving, only one demotion may win; the loser must
    // hit the last-admin refusal. Zero admins is never acceptable.
    const [aStepsDown, bStepsDown] = await Promise.all([
      requestAs(adminA, `/venom/workspaces/${workspaceId}/members/${adminA}`, {
        method: "PATCH",
        body: JSON.stringify({ role: "member" }),
      }),
      requestAs(adminB, `/venom/workspaces/${workspaceId}/members/${adminB}`, {
        method: "PATCH",
        body: JSON.stringify({ role: "member" }),
      }),
    ]);
    assert.deepEqual(
      [aStepsDown.status, bStepsDown.status].sort(),
      [200, 409],
      `Expected one demotion to win and one last-admin refusal; got ${aStepsDown.status} and ${bStepsDown.status}`,
    );

    const afterDemotions = await requestAs(
      adminA,
      `/venom/workspaces/${workspaceId}/members`,
    );
    assertStatus(afterDemotions, 200);
    const remainingAdmins = (
      afterDemotions.body as Array<{ userId: string; role: string }>
    ).filter((entry) => entry.role === "admin");
    assert.equal(remainingAdmins.length, 1);

    // Restore two admins: the surviving admin promotes the other back.
    const survivor = remainingAdmins[0].userId;
    const demoted = survivor === adminA ? adminB : adminA;
    const repromoted = await requestAs(
      survivor,
      `/venom/workspaces/${workspaceId}/members/${demoted}`,
      { method: "PATCH", body: JSON.stringify({ role: "admin" }) },
    );
    assertStatus(repromoted, 200);

    // --- Race 2: both admins leave at the same moment -------------------
    // The remove route participates in the same per-workspace
    // serialization as the role-change route.
    const [aLeaves, bLeaves] = await Promise.all([
      requestAs(adminA, `/venom/workspaces/${workspaceId}/members/${adminA}`, {
        method: "DELETE",
      }),
      requestAs(adminB, `/venom/workspaces/${workspaceId}/members/${adminB}`, {
        method: "DELETE",
      }),
    ]);
    assert.deepEqual(
      [aLeaves.status, bLeaves.status].sort(),
      [200, 409],
      `Expected one leave to win and one last-admin refusal; got ${aLeaves.status} and ${bLeaves.status}`,
    );

    const stayer = aLeaves.status === 200 ? adminB : adminA;
    const finalMembers = await requestAs(
      stayer,
      `/venom/workspaces/${workspaceId}/members`,
    );
    assertStatus(finalMembers, 200);
    assert.equal(finalMembers.body.length, 1);
    assert.equal(finalMembers.body[0].userId, stayer);
    assert.equal(finalMembers.body[0].role, "admin");

    // --- Race 3: authorization is re-checked under the lock -------------
    // An admin fires a mutation, then loses the admin role while their
    // request is parked at the per-workspace lock. The gate already passed,
    // so only the in-transaction re-check can refuse the mutation.
    const leaver = stayer === adminA ? adminB : adminA;
    const memberC = `race-member-c-${suffix}`;
    createdUserIds.push(memberC);
    const readdLeaver = await requestAs(
      stayer,
      `/venom/workspaces/${workspaceId}/members`,
      {
        method: "POST",
        body: JSON.stringify({ userId: leaver, role: "admin" }),
      },
    );
    assertStatus(readdLeaver, 201);
    const addTarget = await requestAs(
      stayer,
      `/venom/workspaces/${workspaceId}/members`,
      { method: "POST", body: JSON.stringify({ userId: memberC }) },
    );
    assertStatus(addTarget, 201);

    let parkedPromotion: Promise<TestResponse> | null = null;
    await db.transaction(async (lockTx) => {
      // Hold the workspace's advisory lock so the actor's request passes
      // the route's admin gate and then parks at the lock.
      await lockTx.execute(
        sql`select pg_advisory_xact_lock(hashtext(${workspaceId}))`,
      );
      parkedPromotion = requestAs(
        leaver,
        `/venom/workspaces/${workspaceId}/members/${memberC}`,
        { method: "PATCH", body: JSON.stringify({ role: "admin" }) },
      );
      await new Promise((resolve) => setTimeout(resolve, 400));
      // Demote the actor while their mutation is parked. A plain row
      // update: advisory locks only serialize other lock holders.
      await db
        .update(venomSharedWorkspaceMembersTable)
        .set({ role: "member" })
        .where(
          and(
            eq(venomSharedWorkspaceMembersTable.workspaceId, workspaceId),
            eq(venomSharedWorkspaceMembersTable.clerkUserId, leaver),
          ),
        );
      // Returning commits and releases the lock; the parked request runs.
    });
    const refusedPromotion = await parkedPromotion!;
    assertStatus(refusedPromotion, 403);
    assert.equal(refusedPromotion.body.code, "workspace_admin_required");

    // Same race against the remove route, this time with the actor removed
    // outright while parked. Re-promote them first so the pre-lock gate
    // passes and only the in-transaction re-check can refuse.
    const repromoteLeaver = await requestAs(
      stayer,
      `/venom/workspaces/${workspaceId}/members/${leaver}`,
      { method: "PATCH", body: JSON.stringify({ role: "admin" }) },
    );
    assertStatus(repromoteLeaver, 200);

    let parkedRemoval: Promise<TestResponse> | null = null;
    await db.transaction(async (lockTx) => {
      await lockTx.execute(
        sql`select pg_advisory_xact_lock(hashtext(${workspaceId}))`,
      );
      parkedRemoval = requestAs(
        leaver,
        `/venom/workspaces/${workspaceId}/members/${memberC}`,
        { method: "DELETE" },
      );
      await new Promise((resolve) => setTimeout(resolve, 400));
      // Remove the actor entirely this time: the re-check must answer a
      // gone member with the eviction code, not the admin-required one.
      await db
        .delete(venomSharedWorkspaceMembersTable)
        .where(
          and(
            eq(venomSharedWorkspaceMembersTable.workspaceId, workspaceId),
            eq(venomSharedWorkspaceMembersTable.clerkUserId, leaver),
          ),
        );
    });
    const refusedRemoval = await parkedRemoval!;
    assertStatus(refusedRemoval, 403);
    assert.equal(refusedRemoval.body.code, "workspace_access_denied");

    // The target was never touched by either refused mutation.
    const targetAfterRaces = await requestAs(
      stayer,
      `/venom/workspaces/${workspaceId}/members`,
    );
    assertStatus(targetAfterRaces, 200);
    const targetRow = (
      targetAfterRaces.body as Array<{ userId: string; role: string }>
    ).find((entry) => entry.userId === memberC);
    assert.ok(targetRow);
    assert.equal(targetRow.role, "member");
  } finally {
    restoreAuth();
    restoreDirectory();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
});
