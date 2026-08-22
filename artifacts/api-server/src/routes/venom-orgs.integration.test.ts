/**
 * Real-database integration tests for Venom company workspaces: membership
 * authorization, the invite lifecycle, the last-admin guard, org-scoped
 * knowledge filing, promotion semantics, company source concepts, and the
 * purge that runs when a company is deleted.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { eq, inArray } from "drizzle-orm";
import {
  db,
  pool,
  venomOntologyConceptsTable,
  venomOntologyEvidenceTable,
  venomOntologyLinksTable,
  venomOntologyOwnersTable,
  venomOntologyTombstonesTable,
  venomOrgAuditTable,
  venomOrgInvitesTable,
  venomOrgMembersTable,
  venomOrgSharedProjectsTable,
  venomOrgSourcesTable,
  venomOrgsTable,
} from "@workspace/db";
import {
  acceptInvite,
  createOrg,
  deleteOrg,
  getSharedProjectForProject,
  insertAuditEntry,
  inviteMember,
  listAuditEntries,
  listInvitesForEmails,
  listMemberDirectory,
  listOrgSummariesForUser,
  removeMember,
  requireAdmin,
  requireMembership,
  revokeInvite,
  upsertSharedProject,
  VenomOrgError,
} from "../lib/venom-org-store";
import {
  fileExtractedKnowledge,
  loadOntologyForOwner,
  orgOwner,
  promoteConceptToOrg,
  purgeOntologyOwner,
  replaceOrgSourceConcepts,
  userOwner,
} from "../lib/venom-ontology-store";
import {
  identityFromClerkUser,
  type VenomOrgIdentity,
} from "../lib/venom-org-directory";

const testOrgIds: string[] = [];
const testUserIds: string[] = [];

function makeIdentity(tag: string): VenomOrgIdentity {
  const suffix = randomUUID().replace(/-/g, "").slice(0, 8);
  const userId = `orgtest_${tag}_${suffix}`;
  testUserIds.push(userId);
  const email = `${tag}_${suffix}@example.com`;
  return { userId, name: `User ${tag}`, primaryEmail: email, emails: [email] };
}

async function makeOrg(name: string, creator: VenomOrgIdentity) {
  const org = await createOrg({ name, creator });
  testOrgIds.push(org.id);
  return org;
}

async function cleanup() {
  for (const orgId of testOrgIds) {
    await purgeOntologyOwner(orgOwner(orgId));
    await deleteOrg(orgId);
  }
  if (testUserIds.length > 0) {
    await db
      .delete(venomOrgMembersTable)
      .where(inArray(venomOrgMembersTable.userId, testUserIds));
    for (const table of [
      venomOntologyConceptsTable,
      venomOntologyEvidenceTable,
      venomOntologyLinksTable,
      venomOntologyTombstonesTable,
      venomOntologyOwnersTable,
    ] as const) {
      await db.delete(table).where(inArray(table.ownerId, testUserIds));
    }
  }
}

test.after(async () => {
  await cleanup();
  await pool.end();
});

const candidate = (label: string, overrides: Record<string, unknown> = {}) => ({
  label,
  category: "topic",
  confidence: 0.8,
  summary: `${label} summary`,
  sourceMessageIds: ["m1"],
  relatedLabels: [],
  ...overrides,
});

const personalConcept = (
  id: string,
  label: string,
  overrides: Record<string, unknown> = {},
) => ({
  id,
  projectId: "personal_project",
  label,
  category: "topic",
  strength: 0.7,
  x: 10,
  y: -20,
  links: [],
  summary: `${label} personal summary`,
  mentionCount: 3,
  lastUpdatedAt: 5_000,
  sources: [
    {
      conversationId: "conv_personal",
      projectId: "personal_project",
      conversationTitle: "Personal chat",
      messageIds: ["m1", "m2"],
      excerpt: "Discussed privately",
      updatedAt: 5_000,
    },
  ],
  ...overrides,
});

test("creator becomes admin and sees the company in their directory", async () => {
  const creator = makeIdentity("creator");
  const org = await makeOrg("Acme Research", creator);

  assert.equal(org.role, "admin");
  assert.equal(org.memberCount, 1);

  const summaries = await listOrgSummariesForUser(creator.userId);
  assert.ok(summaries.some((entry) => entry.id === org.id));

  const access = await requireAdmin(org.id, creator.userId);
  assert.equal(access.role, "admin");
});

test("membership checks gate non-members and non-admins", async () => {
  const creator = makeIdentity("owner");
  const outsider = makeIdentity("outsider");
  const member = makeIdentity("member");
  const org = await makeOrg("Gatekeeping Inc", creator);

  await assert.rejects(
    requireMembership(org.id, outsider.userId),
    (error: unknown) =>
      error instanceof VenomOrgError && error.status === 403,
  );
  await assert.rejects(
    requireMembership("org_missing_row", creator.userId),
    (error: unknown) =>
      error instanceof VenomOrgError && error.status === 404,
  );

  await inviteMember({
    orgId: org.id,
    email: member.emails[0],
    role: "member",
    inviter: creator,
    matches: [member],
  });
  await assert.rejects(
    requireAdmin(org.id, member.userId),
    (error: unknown) =>
      error instanceof VenomOrgError && error.status === 403,
  );
});

test("invite lifecycle: pending invite binds to the invited email only", async () => {
  const creator = makeIdentity("founder");
  const org = await makeOrg("Invite Labs", creator);
  const email = `pending_${randomUUID().slice(0, 8)}@example.com`;

  const outcome = await inviteMember({
    orgId: org.id,
    email,
    role: "member",
    inviter: creator,
    matches: [],
  });
  assert.equal(outcome.status, "invited");

  // Duplicate pending invite is rejected.
  await assert.rejects(
    inviteMember({
      orgId: org.id,
      email,
      role: "member",
      inviter: creator,
      matches: [],
    }),
    (error: unknown) =>
      error instanceof VenomOrgError && error.status === 409,
  );

  const waiting = await listInvitesForEmails([email]);
  assert.equal(waiting.length, 1);
  assert.equal(waiting[0].orgId, org.id);

  // The wrong account cannot accept someone else's invite.
  const impostor = makeIdentity("impostor");
  await assert.rejects(
    acceptInvite({ inviteId: waiting[0].id, identity: impostor }),
    (error: unknown) =>
      error instanceof VenomOrgError && error.status === 403,
  );

  const invitee = makeIdentity("invitee");
  invitee.emails = [email];
  invitee.primaryEmail = email;
  const joined = await acceptInvite({ inviteId: waiting[0].id, identity: invitee });
  assert.equal(joined.id, org.id);
  assert.equal(joined.role, "member");

  const directory = await listMemberDirectory(org.id);
  assert.ok(directory.members.some((m) => m.userId === invitee.userId));
  assert.equal(directory.invites.length, 0);
});

test("inviting an existing account adds directly; revoke removes pending invites", async () => {
  const creator = makeIdentity("boss");
  const teammate = makeIdentity("teammate");
  const org = await makeOrg("Direct Add Co", creator);

  const outcome = await inviteMember({
    orgId: org.id,
    email: teammate.emails[0],
    role: "member",
    inviter: creator,
    matches: [teammate],
  });
  assert.equal(outcome.status, "added");

  await assert.rejects(
    inviteMember({
      orgId: org.id,
      email: teammate.emails[0],
      role: "member",
      inviter: creator,
      matches: [teammate],
    }),
    (error: unknown) =>
      error instanceof VenomOrgError && error.status === 409,
  );

  const pending = await inviteMember({
    orgId: org.id,
    email: `revocable_${randomUUID().slice(0, 8)}@example.com`,
    role: "member",
    inviter: creator,
    matches: [],
  });
  assert.equal(pending.status, "invited");
  if (pending.status === "invited") {
    await revokeInvite({ orgId: org.id, inviteId: pending.invite.id });
    const directory = await listMemberDirectory(org.id);
    assert.equal(directory.invites.length, 0);
  }
});

test("the last admin cannot be removed until another admin exists", async () => {
  const creator = makeIdentity("lastadmin");
  const org = await makeOrg("Admin Guard", creator);

  await assert.rejects(
    removeMember({ orgId: org.id, targetUserId: creator.userId }),
    (error: unknown) =>
      error instanceof VenomOrgError && error.status === 409,
  );

  const second = makeIdentity("secondadmin");
  await inviteMember({
    orgId: org.id,
    email: second.emails[0],
    role: "admin",
    inviter: creator,
    matches: [second],
  });

  await removeMember({ orgId: org.id, targetUserId: creator.userId });
  await assert.rejects(
    requireMembership(org.id, creator.userId),
    (error: unknown) =>
      error instanceof VenomOrgError && error.status === 403,
  );
});

test("a project can be shared with exactly one company", async () => {
  const alice = makeIdentity("alice");
  const bob = makeIdentity("bob");
  const orgA = await makeOrg("Org A", alice);
  const orgB = await makeOrg("Org B", bob);
  const projectId = `proj_${randomUUID().replace(/-/g, "").slice(0, 10)}`;

  const shared = await upsertSharedProject({
    orgId: orgA.id,
    projectId,
    name: "Launch Plan",
    description: "Shared work",
    accent: "#FFFFFF",
    sharer: alice,
    now: 1_000,
  });
  assert.equal(shared.sharedAt, 1_000);

  await assert.rejects(
    upsertSharedProject({
      orgId: orgB.id,
      projectId,
      name: "Stolen Plan",
      description: "",
      accent: "",
      sharer: bob,
    }),
    (error: unknown) =>
      error instanceof VenomOrgError && error.status === 409,
  );

  const updated = await upsertSharedProject({
    orgId: orgA.id,
    projectId,
    name: "Launch Plan v2",
    description: "Renamed",
    accent: "#000000",
    sharer: alice,
    now: 2_000,
  });
  assert.equal(updated.sharedAt, 1_000, "sharedAt survives updates");
  assert.equal(updated.updatedAt, 2_000);

  const registered = await getSharedProjectForProject(projectId);
  assert.equal(registered?.orgId, orgA.id);
});

test("org-scoped filing lands in the company Brain, not the personal one", async () => {
  const creator = makeIdentity("filer");
  const org = await makeOrg("Filing Corp", creator);

  const filed = await fileExtractedKnowledge({
    owner: orgOwner(org.id),
    capturedByUserId: creator.userId,
    conversation: { id: "conv_org", title: "Team sync", projectId: "proj_shared" },
    candidates: [candidate("Quarterly Roadmap")],
    now: 10_000,
  });
  assert.equal(filed.filed.length, 1);
  assert.equal(filed.filed[0].label, "Quarterly Roadmap");

  const orgBrain = await loadOntologyForOwner(orgOwner(org.id));
  assert.ok(
    orgBrain.concepts.some((concept) => concept.label === "Quarterly Roadmap"),
  );

  const personal = await loadOntologyForOwner(userOwner(creator.userId));
  assert.equal(
    personal.concepts.length,
    0,
    "company filing must never touch the personal Brain",
  );

  // Two members' extractions of the same concept merge instead of duplicating.
  await fileExtractedKnowledge({
    owner: orgOwner(org.id),
    capturedByUserId: creator.userId,
    conversation: { id: "conv_org2", title: "Follow-up", projectId: "proj_shared" },
    candidates: [candidate("quarterly roadmap")],
    now: 11_000,
  });
  const merged = await loadOntologyForOwner(orgOwner(org.id));
  const matches = merged.concepts.filter(
    (concept) => concept.label.toLowerCase() === "quarterly roadmap",
  );
  assert.equal(matches.length, 1);
  assert.equal(matches[0].sources.length, 2, "evidence from both chats");
});

test("promotion merges by label, keeps evidence, and respects org tombstones", async () => {
  const creator = makeIdentity("promoter");
  const org = await makeOrg("Promo Inc", creator);

  const first = await promoteConceptToOrg({
    orgId: org.id,
    concept: personalConcept("cluster_personal_1", "GraphQL Gateway"),
    promotedByUserId: creator.userId,
    keepProjectIds: new Set(),
    now: 20_000,
  });
  assert.equal(first.merged, false);
  assert.equal(
    first.concept.projectId,
    null,
    "personal project links are stripped on promotion",
  );
  assert.equal(first.concept.sources.length, 1, "evidence travels with it");

  const second = await promoteConceptToOrg({
    orgId: org.id,
    promotedByUserId: creator.userId,
    concept: personalConcept("cluster_personal_2", "graphql gateway", {
      sources: [
        {
          conversationId: "conv_other",
          projectId: null,
          conversationTitle: "Another chat",
          messageIds: ["m9"],
          excerpt: "More evidence",
          updatedAt: 21_000,
        },
      ],
      lastUpdatedAt: 21_000,
    }),
    now: 21_500,
  });
  assert.equal(second.merged, true);
  assert.equal(second.concept.id, first.concept.id, "merged into the same concept");
  assert.equal(second.concept.sources.length, 2, "evidence union by conversation");

  // A concept the company retired cannot come back under the same id.
  await replaceOrgSourceConcepts({
    orgId: org.id,
    sourceId: "source_retired",
    sourceName: "Old source",
    seeds: [
      {
        id: "source_retired_hub",
        label: "Legacy Process",
        category: "process",
        strength: 0.9,
        summary: "Old",
        excerpt: "Old",
        citationIds: ["cite_1"],
      },
    ],
    now: 22_000,
  });
  await replaceOrgSourceConcepts({
    orgId: org.id,
    sourceId: "source_retired",
    sourceName: "Old source",
    seeds: [],
    now: 23_000,
  });

  const resurrection = await promoteConceptToOrg({
    orgId: org.id,
    concept: personalConcept("source_retired_hub", "Fresh Idea"),
    promotedByUserId: creator.userId,
    now: 24_000,
  });
  assert.notEqual(
    resurrection.concept.id,
    "source_retired_hub",
    "tombstoned ids are never recycled",
  );

  await insertAuditEntry({
    orgId: org.id,
    conceptId: first.concept.id,
    conceptLabel: first.concept.label,
    actor: creator,
    now: 25_000,
  });
  const audit = await listAuditEntries(org.id);
  assert.ok(audit.length >= 1);
  assert.equal(audit[0].actorUserId, creator.userId);
});

test("company source concepts replace in place and retire permanently", async () => {
  const creator = makeIdentity("sourcer");
  const org = await makeOrg("Source Co", creator);
  const sourceId = `source_${randomUUID().replace(/-/g, "").slice(0, 10)}`;

  const seed = (key: string, label: string) => ({
    id: `${sourceId}_${key}`,
    label,
    category: "repository",
    strength: 0.8,
    summary: `${label} summary`,
    excerpt: `${label} excerpt`,
    citationIds: ["cite_a"],
  });

  const firstSync = await replaceOrgSourceConcepts({
    orgId: org.id,
    sourceId,
    sourceName: "acme/repo",
    seeds: [seed("repository", "acme/repo"), seed("issues", "Open Issues")],
    now: 30_000,
  });
  assert.equal(firstSync.filed.length, 2);
  const hub = firstSync.filed[0];
  assert.equal(firstSync.filed[1].links[0], hub.id, "spokes link to the hub");

  const before = await loadOntologyForOwner(orgOwner(org.id));
  const positionBefore = before.concepts.find((c) => c.id === hub.id);

  const secondSync = await replaceOrgSourceConcepts({
    orgId: org.id,
    sourceId,
    sourceName: "acme/repo",
    seeds: [seed("repository", "acme/repo")],
    now: 31_000,
  });
  assert.equal(secondSync.filed.length, 1);

  const after = await loadOntologyForOwner(orgOwner(org.id));
  const hubAfter = after.concepts.find((c) => c.id === hub.id);
  assert.ok(hubAfter, "surviving seed stays");
  assert.equal(hubAfter?.x, positionBefore?.x, "position is stable across syncs");
  assert.equal(hubAfter?.mentionCount, (positionBefore?.mentionCount ?? 0) + 1);
  assert.ok(
    !after.concepts.some((c) => c.id === `${sourceId}_issues`),
    "removed seed disappears",
  );
  const tombstone = after.tombstones.find((t) => t.id === `${sourceId}_issues`);
  assert.ok(tombstone, "removed seed leaves a tombstone");
  assert.equal(tombstone?.replaced, true, "retirement is permanent");
});

test("deleting a company purges its shared Brain and registry", async () => {
  const creator = makeIdentity("deleter");
  const org = await makeOrg("Doomed Org", creator);

  await fileExtractedKnowledge({
    owner: orgOwner(org.id),
    capturedByUserId: creator.userId,
    conversation: { id: "conv_doom", title: "Doomed", projectId: null },
    candidates: [candidate("Vanishing Concept")],
    now: 40_000,
  });
  await upsertSharedProject({
    orgId: org.id,
    projectId: `proj_doom_${randomUUID().slice(0, 6)}`,
    name: "Doomed project",
    description: "",
    accent: "",
    sharer: creator,
  });

  await purgeOntologyOwner(orgOwner(org.id));
  await deleteOrg(org.id);

  for (const table of [
    venomOntologyConceptsTable,
    venomOntologyEvidenceTable,
    venomOntologyLinksTable,
    venomOntologyTombstonesTable,
    venomOntologyOwnersTable,
  ] as const) {
    const rows = await db.select().from(table).where(eq(table.ownerId, org.id));
    assert.equal(rows.length, 0);
  }
  const orgRows = await db
    .select()
    .from(venomOrgsTable)
    .where(eq(venomOrgsTable.id, org.id));
  assert.equal(orgRows.length, 0);
  for (const table of [
    venomOrgMembersTable,
    venomOrgInvitesTable,
    venomOrgSharedProjectsTable,
    venomOrgSourcesTable,
    venomOrgAuditTable,
  ] as const) {
    const rows = await db.select().from(table).where(eq(table.orgId, org.id));
    assert.equal(rows.length, 0);
  }
});

test("identity derivation uses verified emails and sensible names", () => {
  const verified = identityFromClerkUser({
    id: "user_1",
    firstName: "Ada",
    lastName: "Lovelace",
    primaryEmailAddressId: "em_1",
    emailAddresses: [
      {
        id: "em_1",
        emailAddress: "Ada@Example.com",
        verification: { status: "verified" },
      },
      {
        id: "em_2",
        emailAddress: "unverified@example.com",
        verification: { status: "unverified" },
      },
    ],
  });
  assert.equal(verified.name, "Ada Lovelace");
  assert.deepEqual(verified.emails, ["ada@example.com"]);

  const unverifiedOnly = identityFromClerkUser({
    id: "user_2",
    primaryEmailAddressId: "em_3",
    emailAddresses: [
      {
        id: "em_3",
        emailAddress: "solo@example.com",
        verification: { status: "unverified" },
      },
    ],
  });
  assert.deepEqual(
    unverifiedOnly.emails,
    [],
    "an unverified address never becomes invite-matching evidence",
  );
  assert.equal(
    unverifiedOnly.primaryEmail,
    "solo@example.com",
    "the primary address survives as display metadata only",
  );
  assert.equal(unverifiedOnly.name, "solo");
});

test("an account with only unverified emails cannot pass any invite door", async () => {
  const creator = makeIdentity("verifiedfounder");
  const org = await makeOrg("Verified Only Co", creator);
  const email = `unverified_${randomUUID().slice(0, 8)}@example.com`;

  // A Clerk account claims the invited address but never verified it. Its
  // identity carries no match evidence, so inviting that address must leave
  // a pending invite rather than create a membership.
  const claimant = identityFromClerkUser({
    id: `user_unverified_${randomUUID().slice(0, 8)}`,
    primaryEmailAddressId: "em_1",
    emailAddresses: [
      { id: "em_1", emailAddress: email, verification: { status: "unverified" } },
    ],
  });
  const matches = [claimant].filter((identity) =>
    identity.emails.includes(email),
  );
  const outcome = await inviteMember({
    orgId: org.id,
    email,
    role: "member",
    inviter: creator,
    matches,
  });
  assert.equal(outcome.status, "invited", "no direct add without verification");
  if (outcome.status !== "invited") return;

  // They cannot see the pending invite addressed to their unverified email…
  const visible = await listInvitesForEmails(claimant.emails);
  assert.equal(visible.length, 0);

  // …and cannot accept it.
  await assert.rejects(
    acceptInvite({ inviteId: outcome.invite.id, identity: claimant }),
    (error: unknown) =>
      error instanceof VenomOrgError && error.status === 403,
  );

  const directory = await listMemberDirectory(org.id);
  assert.equal(
    directory.members.some((member) => member.userId === claimant.userId),
    false,
    "no membership row appeared for the unverified account",
  );
  assert.equal(directory.invites.length, 1, "the invite is still waiting");
});

// ---------------------------------------------------------------------------
// Live revocation events: an already-open device must hear about a removal
// or company deletion immediately, without waiting for a directory poll.
// ---------------------------------------------------------------------------

import express from "express";
import type { AddressInfo } from "node:net";
import { createVenomOrgsRouter } from "./venom-orgs-router";
import type { VenomOrgDirectory } from "../lib/venom-org-directory";

function bootOrgsApp(identities: Map<string, VenomOrgIdentity>) {
  const directory: VenomOrgDirectory = {
    async getIdentity(userId: string) {
      const identity = identities.get(userId);
      if (!identity) throw new Error(`no identity for ${userId}`);
      return identity;
    },
    async findByEmail() {
      return [];
    },
  };
  const app = express();
  app.use(express.json());
  app.use(
    createVenomOrgsRouter({
      resolveUserId: (req) => req.header("x-test-user") ?? null,
      directory,
      isWorkspaceMember: () => true,
      githubRequest: async () => {
        throw new Error("github not used in this test");
      },
      resolveAddresses: async () => [],
      fetchWebsite: async () => {
        throw new Error("website fetch not used in this test");
      },
    }),
  );
  const server = app.listen(0);
  const port = (server.address() as AddressInfo).port;
  return { server, baseUrl: `http://127.0.0.1:${port}` };
}

/** Read SSE data events off a fetch response until the predicate matches. */
async function nextEvent(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  matches: (event: Record<string, unknown>) => boolean,
  timeoutMs: number,
): Promise<Record<string, unknown>> {
  const decoder = new TextDecoder();
  let buffer = "";
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error("timed out waiting for SSE event");
    const chunk = await Promise.race([
      reader.read(),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("timed out waiting for SSE event")), remaining),
      ),
    ]);
    if (chunk.done) throw new Error("event stream closed early");
    buffer += decoder.decode(chunk.value, { stream: true });
    const frames = buffer.split(/\r?\n\r?\n/);
    buffer = frames.pop() ?? "";
    for (const frame of frames) {
      const data = frame
        .split(/\r?\n/)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trim())
        .join("");
      if (!data) continue;
      const parsed = JSON.parse(data) as Record<string, unknown>;
      if (matches(parsed)) return parsed;
    }
  }
}

test("membership events: removal and deletion reach an open stream instantly", async () => {
  const admin = makeIdentity("evadmin");
  const member = makeIdentity("evmember");
  const identities = new Map([
    [admin.userId, admin],
    [member.userId, member],
  ]);
  const org = await makeOrg("Event Push Inc", admin);
  await inviteMember({
    orgId: org.id,
    email: member.emails[0]!,
    role: "member",
    inviter: admin,
    matches: [member],
  });
  await requireMembership(org.id, member.userId);

  const { server, baseUrl } = bootOrgsApp(identities);
  const streamAbort = new AbortController();
  // Declared beside streamAbort so the finally below can abort it: a failure
  // after the admin stream opens must not leave that connection alive, or
  // server.close() waits on it forever and the real error hides behind a
  // hang instead of a red test.
  const adminAbort = new AbortController();
  try {
    // Member's device opens its live stream.
    const stream = await fetch(`${baseUrl}/venom/orgs/events`, {
      headers: { "x-test-user": member.userId, accept: "text/event-stream" },
      signal: streamAbort.signal,
    });
    assert.equal(stream.status, 200);
    assert.match(stream.headers.get("content-type") ?? "", /text\/event-stream/);
    const reader = stream.body!.getReader();
    await nextEvent(reader, (event) => event.type === "connected", 3_000);

    // Admin removes the member; the open stream must hear it immediately.
    const removal = await fetch(
      `${baseUrl}/venom/orgs/${org.id}/members/${member.userId}`,
      { method: "DELETE", headers: { "x-test-user": admin.userId } },
    );
    assert.equal(removal.status, 204);
    const removedEvent = await nextEvent(
      reader,
      (event) => event.type === "membership-changed",
      3_000,
    );
    assert.equal(removedEvent.orgId, org.id);

    // Company deletion pushes to every remaining member (here: the admin).
    const adminStream = await fetch(`${baseUrl}/venom/orgs/events`, {
      headers: { "x-test-user": admin.userId, accept: "text/event-stream" },
      signal: adminAbort.signal,
    });
    const adminReader = adminStream.body!.getReader();
    await nextEvent(adminReader, (event) => event.type === "connected", 3_000);
    const deletion = await fetch(`${baseUrl}/venom/orgs/${org.id}`, {
      method: "DELETE",
      headers: { "x-test-user": admin.userId },
    });
    assert.equal(deletion.status, 204);
    const deletedEvent = await nextEvent(
      adminReader,
      (event) => event.type === "membership-changed",
      3_000,
    );
    assert.equal(deletedEvent.orgId, org.id);
  } finally {
    streamAbort.abort();
    adminAbort.abort();
    // Client-side aborts alone are not reliable teardown: depending on the
    // fetch implementation an aborted SSE socket can stay open, and then
    // the route's heartbeat keeps writing into it forever — server.close()
    // never settles and the test process hangs at exit. Destroy whatever
    // connections remain so close() is deterministic.
    const closed = new Promise<void>((resolve) => server.close(() => resolve()));
    server.closeAllConnections();
    await closed;
  }
});
