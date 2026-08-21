/**
 * Real-database integration tests for shared workspaces: creation,
 * membership with admin/member roles, membership-checked knowledge and SOP
 * reads, and — the heart of the feature — revocation that takes effect on
 * the removed member's next request while everyone else's view and the
 * removed member's personal tier stay intact.
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
import { eq, inArray, sql } from "drizzle-orm";
import express from "express";
import router, {
  overrideSharedWorkspaceUserDirectoryForTests,
  overrideSharedWorkspaceUserIdResolverForTests,
} from "./venom-shared-workspaces.js";
import venomRouter from "./venom.js";
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
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    )
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
    const memberRemoves = await request(
      `/venom/workspaces/${workspaceId}/members/${adminId}`,
      { method: "DELETE" },
    );
    assertStatus(memberRemoves, 403);

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

    // A non-member's workspace chat request is refused before any
    // streaming or provider work starts.
    actingUserId = outsiderId;
    const chatBody = {
      projectId: `proj-${suffix}`,
      workspaceId: workspace.id,
      messages: [{ id: "m1", role: "user", content: "What do we know?" }],
    };
    const deniedChat = await fetch(`${baseUrl}/venom/respond`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(chatBody),
    });
    assert.equal(deniedChat.status, 403);
    const deniedChatBody = (await deniedChat.json()) as { code?: string };
    assert.equal(deniedChatBody.code, "workspace_access_denied");

    // Extraction refuses a non-member's workspace request before any model
    // call, so nothing can be read from or filed into the shared tier.
    const deniedExtract = await fetch(`${baseUrl}/venom/knowledge/extract`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        workspaceId: workspace.id,
        file: true,
        conversation: { id: `conv-${suffix}`, title: "Gate check" },
        messages: [{ id: "m1", role: "user", content: "Capture this decision." }],
      }),
    });
    assert.equal(deniedExtract.status, 403);
    const deniedExtractBody = (await deniedExtract.json()) as {
      code?: string;
    };
    assert.equal(deniedExtractBody.code, "workspace_access_denied");
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
});
