/**
 * Persistence and business rules for Venom company workspaces: orgs,
 * membership, invites, company-shared projects, company sources, and the
 * contribution audit trail.
 *
 * The shared ontology itself lives in the venom_ontology_* tables under
 * owner scope ("org", orgId) — see venom-ontology-store. This module only
 * owns the org registry tables and their invariants (roles, last-admin
 * guard, one-company-per-project sharing).
 */

import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import {
  db,
  venomOrgsTable,
  venomOrgMembersTable,
  venomOrgInvitesTable,
  venomOrgSharedProjectsTable,
  venomOrgSourcesTable,
  venomOrgAuditTable,
  VENOM_ORG_ROLE_ADMIN,
  VENOM_ORG_ROLE_MEMBER,
  type VenomOrgRow,
  type VenomOrgMemberRow,
  type VenomOrgInviteRow,
  type VenomOrgSharedProjectRow,
  type VenomOrgSourceRow,
} from "@workspace/db";
import type { VenomOrgIdentity } from "./venom-org-directory";

export class VenomOrgError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export type VenomOrgRole = "admin" | "member";

export type VenomOrgSummary = {
  id: string;
  name: string;
  role: VenomOrgRole;
  memberCount: number;
  createdAt: number;
};

export type VenomOrgMemberView = {
  userId: string;
  name: string;
  email: string | null;
  role: VenomOrgRole;
};

export type VenomOrgPendingInviteView = {
  id: string;
  email: string;
  role: VenomOrgRole;
  invitedByName: string;
  createdAt: number;
};

export type VenomOrgInviteForMeView = VenomOrgPendingInviteView & {
  orgId: string;
  orgName: string;
};

const MAX_ORG_NAME = 80;
const MAX_ORGS_PER_USER = 50;

const randomToken = () => randomUUID().replace(/-/g, "").slice(0, 20);
export const generateOrgId = () => `org_${randomToken()}`;
export const generateOrgInviteId = () => `oinv_${randomToken()}`;
export const generateOrgAuditId = () => `oaud_${randomToken()}`;

function asRole(raw: string | null | undefined): VenomOrgRole {
  return raw === VENOM_ORG_ROLE_ADMIN ? "admin" : "member";
}

export function normalizeOrgName(raw: string): string {
  return raw.replace(/\s+/g, " ").trim().slice(0, MAX_ORG_NAME);
}

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function normalizeInviteEmail(raw: string): string {
  const email = raw.trim().toLowerCase();
  if (!EMAIL_PATTERN.test(email) || email.length > 320) {
    throw new VenomOrgError(400, "Enter a valid email address.");
  }
  return email;
}

function memberView(row: VenomOrgMemberRow): VenomOrgMemberView {
  return {
    userId: row.userId,
    name: row.name,
    email: row.email,
    role: asRole(row.role),
  };
}

function inviteView(row: VenomOrgInviteRow): VenomOrgPendingInviteView {
  return {
    id: row.id,
    email: row.email,
    role: asRole(row.role),
    invitedByName: row.invitedByName,
    createdAt: row.createdAt.getTime(),
  };
}

async function memberCounts(orgIds: string[]): Promise<Map<string, number>> {
  if (orgIds.length === 0) return new Map();
  const rows = await db
    .select({
      orgId: venomOrgMembersTable.orgId,
      count: sql<number>`COUNT(*)::int`,
    })
    .from(venomOrgMembersTable)
    .where(inArray(venomOrgMembersTable.orgId, orgIds))
    .groupBy(venomOrgMembersTable.orgId);
  return new Map(rows.map((row) => [row.orgId, row.count]));
}

function summaryFrom(
  org: VenomOrgRow,
  role: VenomOrgRole,
  memberCount: number,
): VenomOrgSummary {
  return {
    id: org.id,
    name: org.name,
    role,
    memberCount: Math.max(1, memberCount),
    createdAt: org.createdAt.getTime(),
  };
}

// ---------------------------------------------------------------------------
// Orgs & membership
// ---------------------------------------------------------------------------

export async function createOrg(input: {
  name: string;
  creator: VenomOrgIdentity;
}): Promise<VenomOrgSummary> {
  const name = normalizeOrgName(input.name);
  if (!name) throw new VenomOrgError(400, "Give the company a name.");

  const existing = await db
    .select({ orgId: venomOrgMembersTable.orgId })
    .from(venomOrgMembersTable)
    .where(eq(venomOrgMembersTable.userId, input.creator.userId));
  if (existing.length >= MAX_ORGS_PER_USER) {
    throw new VenomOrgError(400, "You are in too many companies already.");
  }

  const orgId = generateOrgId();
  const org = await db.transaction(async (tx) => {
    const [created] = await tx
      .insert(venomOrgsTable)
      .values({
        id: orgId,
        name,
        createdByUserId: input.creator.userId,
      })
      .returning();
    await tx.insert(venomOrgMembersTable).values({
      orgId,
      userId: input.creator.userId,
      role: VENOM_ORG_ROLE_ADMIN,
      name: input.creator.name,
      email: input.creator.primaryEmail,
      addedByUserId: input.creator.userId,
    });
    return created;
  });

  return summaryFrom(org, "admin", 1);
}

export async function getOrg(orgId: string): Promise<VenomOrgRow | null> {
  const [row] = await db
    .select()
    .from(venomOrgsTable)
    .where(eq(venomOrgsTable.id, orgId))
    .limit(1);
  return row ?? null;
}

export async function getMembership(
  orgId: string,
  userId: string,
): Promise<VenomOrgMemberRow | null> {
  const [row] = await db
    .select()
    .from(venomOrgMembersTable)
    .where(
      and(
        eq(venomOrgMembersTable.orgId, orgId),
        eq(venomOrgMembersTable.userId, userId),
      ),
    )
    .limit(1);
  return row ?? null;
}

export type OrgAccess = {
  org: VenomOrgRow;
  membership: VenomOrgMemberRow;
  role: VenomOrgRole;
};

/** Every org-scoped read and write goes through this membership check. */
export async function requireMembership(
  orgId: string,
  userId: string,
): Promise<OrgAccess> {
  const org = await getOrg(orgId);
  if (!org) throw new VenomOrgError(404, "Company not found.");
  const membership = await getMembership(orgId, userId);
  if (!membership) {
    throw new VenomOrgError(403, "You are not a member of this company.");
  }
  return { org, membership, role: asRole(membership.role) };
}

export async function requireAdmin(
  orgId: string,
  userId: string,
): Promise<OrgAccess> {
  const access = await requireMembership(orgId, userId);
  if (access.role !== "admin") {
    throw new VenomOrgError(403, "Only company admins can do this.");
  }
  return access;
}

export async function listOrgSummariesForUser(
  userId: string,
): Promise<VenomOrgSummary[]> {
  const rows = await db
    .select({ org: venomOrgsTable, role: venomOrgMembersTable.role })
    .from(venomOrgMembersTable)
    .innerJoin(
      venomOrgsTable,
      eq(venomOrgsTable.id, venomOrgMembersTable.orgId),
    )
    .where(eq(venomOrgMembersTable.userId, userId))
    .orderBy(asc(venomOrgsTable.createdAt), asc(venomOrgsTable.id));

  const counts = await memberCounts(rows.map((row) => row.org.id));
  return rows.map((row) =>
    summaryFrom(row.org, asRole(row.role), counts.get(row.org.id) ?? 1),
  );
}

export async function listInvitesForEmails(
  emails: string[],
): Promise<VenomOrgInviteForMeView[]> {
  const normalized = [...new Set(emails.map((email) => email.toLowerCase()))];
  if (normalized.length === 0) return [];
  const rows = await db
    .select({ invite: venomOrgInvitesTable, orgName: venomOrgsTable.name })
    .from(venomOrgInvitesTable)
    .innerJoin(venomOrgsTable, eq(venomOrgsTable.id, venomOrgInvitesTable.orgId))
    .where(inArray(venomOrgInvitesTable.email, normalized))
    .orderBy(asc(venomOrgInvitesTable.createdAt));
  return rows.map((row) => ({
    ...inviteView(row.invite),
    orgId: row.invite.orgId,
    orgName: row.orgName,
  }));
}

export async function listMemberDirectory(orgId: string): Promise<{
  members: VenomOrgMemberView[];
  invites: VenomOrgPendingInviteView[];
}> {
  const [members, invites] = await Promise.all([
    db
      .select()
      .from(venomOrgMembersTable)
      .where(eq(venomOrgMembersTable.orgId, orgId))
      .orderBy(asc(venomOrgMembersTable.createdAt), asc(venomOrgMembersTable.userId)),
    db
      .select()
      .from(venomOrgInvitesTable)
      .where(eq(venomOrgInvitesTable.orgId, orgId))
      .orderBy(asc(venomOrgInvitesTable.createdAt), asc(venomOrgInvitesTable.id)),
  ]);
  return {
    members: members.map(memberView),
    invites: invites.map(inviteView),
  };
}

export type InviteOutcome =
  | { status: "added"; member: VenomOrgMemberView }
  | { status: "invited"; invite: VenomOrgPendingInviteView };

/**
 * Invite by email. When the email already belongs to a Venom account the
 * membership is created immediately; otherwise a pending invite waits for
 * the address to show up on a signed-in account.
 */
export async function inviteMember(input: {
  orgId: string;
  email: string;
  role: VenomOrgRole;
  inviter: VenomOrgIdentity;
  matches: VenomOrgIdentity[];
}): Promise<InviteOutcome> {
  const email = normalizeInviteEmail(input.email);
  const role = input.role === "admin" ? VENOM_ORG_ROLE_ADMIN : VENOM_ORG_ROLE_MEMBER;
  const target = input.matches.find((identity) => identity.emails.includes(email));

  if (target) {
    const existing = await getMembership(input.orgId, target.userId);
    if (existing) {
      throw new VenomOrgError(409, "They are already a member of this company.");
    }
    const [member] = await db.transaction(async (tx) => {
      const inserted = await tx
        .insert(venomOrgMembersTable)
        .values({
          orgId: input.orgId,
          userId: target.userId,
          role,
          name: target.name,
          email: target.primaryEmail ?? email,
          addedByUserId: input.inviter.userId,
        })
        .onConflictDoNothing()
        .returning();
      await tx
        .delete(venomOrgInvitesTable)
        .where(
          and(
            eq(venomOrgInvitesTable.orgId, input.orgId),
            eq(venomOrgInvitesTable.email, email),
          ),
        );
      return inserted;
    });
    if (!member) {
      throw new VenomOrgError(409, "They are already a member of this company.");
    }
    return { status: "added", member: memberView(member) };
  }

  const [existingInvite] = await db
    .select()
    .from(venomOrgInvitesTable)
    .where(
      and(
        eq(venomOrgInvitesTable.orgId, input.orgId),
        eq(venomOrgInvitesTable.email, email),
      ),
    )
    .limit(1);
  if (existingInvite) {
    throw new VenomOrgError(409, "That email already has a pending invite.");
  }

  const [invite] = await db
    .insert(venomOrgInvitesTable)
    .values({
      id: generateOrgInviteId(),
      orgId: input.orgId,
      email,
      role,
      invitedByUserId: input.inviter.userId,
      invitedByName: input.inviter.name,
    })
    .onConflictDoNothing()
    .returning();
  if (!invite) {
    throw new VenomOrgError(409, "That email already has a pending invite.");
  }
  return { status: "invited", invite: inviteView(invite) };
}

async function getInvite(inviteId: string): Promise<VenomOrgInviteRow | null> {
  const [row] = await db
    .select()
    .from(venomOrgInvitesTable)
    .where(eq(venomOrgInvitesTable.id, inviteId))
    .limit(1);
  return row ?? null;
}

export async function acceptInvite(input: {
  inviteId: string;
  identity: VenomOrgIdentity;
}): Promise<VenomOrgSummary> {
  const invite = await getInvite(input.inviteId);
  if (!invite) throw new VenomOrgError(404, "This invite no longer exists.");
  if (!input.identity.emails.includes(invite.email)) {
    throw new VenomOrgError(403, "This invite was sent to a different email.");
  }
  const org = await getOrg(invite.orgId);
  if (!org) {
    await db
      .delete(venomOrgInvitesTable)
      .where(eq(venomOrgInvitesTable.id, invite.id));
    throw new VenomOrgError(404, "This company no longer exists.");
  }

  await db.transaction(async (tx) => {
    await tx
      .insert(venomOrgMembersTable)
      .values({
        orgId: invite.orgId,
        userId: input.identity.userId,
        role: invite.role,
        name: input.identity.name,
        email: input.identity.primaryEmail ?? invite.email,
        addedByUserId: invite.invitedByUserId,
      })
      .onConflictDoNothing();
    await tx
      .delete(venomOrgInvitesTable)
      .where(eq(venomOrgInvitesTable.id, invite.id));
  });

  const counts = await memberCounts([org.id]);
  return summaryFrom(org, asRole(invite.role), counts.get(org.id) ?? 1);
}

export async function declineInvite(input: {
  inviteId: string;
  identity: VenomOrgIdentity;
}): Promise<void> {
  const invite = await getInvite(input.inviteId);
  if (!invite) throw new VenomOrgError(404, "This invite no longer exists.");
  if (!input.identity.emails.includes(invite.email)) {
    throw new VenomOrgError(403, "This invite was sent to a different email.");
  }
  await db
    .delete(venomOrgInvitesTable)
    .where(eq(venomOrgInvitesTable.id, invite.id));
}

export async function revokeInvite(input: {
  orgId: string;
  inviteId: string;
}): Promise<void> {
  const deleted = await db
    .delete(venomOrgInvitesTable)
    .where(
      and(
        eq(venomOrgInvitesTable.id, input.inviteId),
        eq(venomOrgInvitesTable.orgId, input.orgId),
      ),
    )
    .returning({ id: venomOrgInvitesTable.id });
  if (deleted.length === 0) {
    throw new VenomOrgError(404, "This invite no longer exists.");
  }
}

/**
 * End a membership. Admins can remove anyone; a member can remove
 * themselves (leave). The last admin can never be removed — the company
 * must be deleted instead, so a shared Brain is never left ownerless.
 */
export async function removeMember(input: {
  orgId: string;
  targetUserId: string;
}): Promise<void> {
  const target = await getMembership(input.orgId, input.targetUserId);
  if (!target) throw new VenomOrgError(404, "They are not a member of this company.");

  if (asRole(target.role) === "admin") {
    const [admins] = await db
      .select({ count: sql<number>`COUNT(*)::int` })
      .from(venomOrgMembersTable)
      .where(
        and(
          eq(venomOrgMembersTable.orgId, input.orgId),
          eq(venomOrgMembersTable.role, VENOM_ORG_ROLE_ADMIN),
        ),
      );
    if ((admins?.count ?? 0) <= 1) {
      throw new VenomOrgError(
        409,
        "The last admin cannot be removed. Delete the company instead.",
      );
    }
  }

  await db
    .delete(venomOrgMembersTable)
    .where(
      and(
        eq(venomOrgMembersTable.orgId, input.orgId),
        eq(venomOrgMembersTable.userId, input.targetUserId),
      ),
    );
}

/** Remove the org registry rows. The ontology purge runs separately. */
export async function deleteOrg(orgId: string): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.delete(venomOrgAuditTable).where(eq(venomOrgAuditTable.orgId, orgId));
    await tx
      .delete(venomOrgSourcesTable)
      .where(eq(venomOrgSourcesTable.orgId, orgId));
    await tx
      .delete(venomOrgSharedProjectsTable)
      .where(eq(venomOrgSharedProjectsTable.orgId, orgId));
    await tx
      .delete(venomOrgInvitesTable)
      .where(eq(venomOrgInvitesTable.orgId, orgId));
    await tx
      .delete(venomOrgMembersTable)
      .where(eq(venomOrgMembersTable.orgId, orgId));
    await tx.delete(venomOrgsTable).where(eq(venomOrgsTable.id, orgId));
  });
}

// ---------------------------------------------------------------------------
// Company-shared projects
// ---------------------------------------------------------------------------

export type SharedProjectView = {
  projectId: string;
  orgId: string;
  name: string;
  description: string;
  accent: string;
  sharedByUserId: string;
  sharedByName: string;
  sharedAt: number;
  updatedAt: number;
};

function sharedProjectView(row: VenomOrgSharedProjectRow): SharedProjectView {
  return {
    projectId: row.projectId,
    orgId: row.orgId,
    name: row.name,
    description: row.description,
    accent: row.accent,
    sharedByUserId: row.sharedByUserId,
    sharedByName: row.sharedByName,
    sharedAt: row.sharedAt,
    updatedAt: row.updatedAt,
  };
}

export async function upsertSharedProject(input: {
  orgId: string;
  projectId: string;
  name: string;
  description: string;
  accent: string;
  sharer: VenomOrgIdentity;
  now?: number;
}): Promise<SharedProjectView> {
  const now = input.now ?? Date.now();
  const name = input.name.replace(/\s+/g, " ").trim().slice(0, 120);
  if (!name) throw new VenomOrgError(400, "The project needs a name.");
  const description = input.description.trim().slice(0, 1000);
  const accent = input.accent.trim().slice(0, 32);

  const [existing] = await db
    .select()
    .from(venomOrgSharedProjectsTable)
    .where(eq(venomOrgSharedProjectsTable.projectId, input.projectId))
    .limit(1);

  if (existing && existing.orgId !== input.orgId) {
    throw new VenomOrgError(
      409,
      "This project is already shared with a different company.",
    );
  }

  if (existing) {
    const [updated] = await db
      .update(venomOrgSharedProjectsTable)
      .set({ name, description, accent, updatedAt: now })
      .where(eq(venomOrgSharedProjectsTable.projectId, input.projectId))
      .returning();
    return sharedProjectView(updated);
  }

  const [created] = await db
    .insert(venomOrgSharedProjectsTable)
    .values({
      projectId: input.projectId,
      orgId: input.orgId,
      name,
      description,
      accent,
      sharedByUserId: input.sharer.userId,
      sharedByName: input.sharer.name,
      sharedAt: now,
      updatedAt: now,
    })
    .returning();
  return sharedProjectView(created);
}

export async function removeSharedProject(input: {
  orgId: string;
  projectId: string;
}): Promise<void> {
  const deleted = await db
    .delete(venomOrgSharedProjectsTable)
    .where(
      and(
        eq(venomOrgSharedProjectsTable.orgId, input.orgId),
        eq(venomOrgSharedProjectsTable.projectId, input.projectId),
      ),
    )
    .returning({ projectId: venomOrgSharedProjectsTable.projectId });
  if (deleted.length === 0) {
    throw new VenomOrgError(404, "This project is not shared with the company.");
  }
}

export async function listSharedProjects(
  orgId: string,
): Promise<SharedProjectView[]> {
  const rows = await db
    .select()
    .from(venomOrgSharedProjectsTable)
    .where(eq(venomOrgSharedProjectsTable.orgId, orgId))
    .orderBy(
      asc(venomOrgSharedProjectsTable.sharedAt),
      asc(venomOrgSharedProjectsTable.projectId),
    );
  return rows.map(sharedProjectView);
}

/** Routing lookup used at extraction time. Null = not company-shared. */
export async function getSharedProjectForProject(
  projectId: string,
): Promise<VenomOrgSharedProjectRow | null> {
  const [row] = await db
    .select()
    .from(venomOrgSharedProjectsTable)
    .where(eq(venomOrgSharedProjectsTable.projectId, projectId))
    .limit(1);
  return row ?? null;
}

// ---------------------------------------------------------------------------
// Company sources
// ---------------------------------------------------------------------------

export type OrgSourceView = {
  id: string;
  orgId: string;
  provider: "github" | "website";
  name: string;
  url: string;
  summary: string;
  context: string;
  citations: unknown[];
  connectedByUserId: string;
  connectedByName: string;
  syncedAt: number;
};

function orgSourceView(row: VenomOrgSourceRow): OrgSourceView {
  return {
    id: row.sourceId,
    orgId: row.orgId,
    provider: row.provider === "github" ? "github" : "website",
    name: row.name,
    url: row.url,
    summary: row.summary,
    context: row.context,
    citations: Array.isArray(row.citations) ? (row.citations as unknown[]) : [],
    connectedByUserId: row.connectedByUserId,
    connectedByName: row.connectedByName,
    syncedAt: row.syncedAt,
  };
}

export async function saveOrgSource(input: {
  orgId: string;
  sourceId: string;
  provider: "github" | "website";
  name: string;
  url: string;
  summary: string;
  context: string;
  citations: unknown[];
  connectedBy: VenomOrgIdentity;
  now?: number;
}): Promise<OrgSourceView> {
  const now = input.now ?? Date.now();
  const values = {
    orgId: input.orgId,
    sourceId: input.sourceId,
    provider: input.provider,
    name: input.name.slice(0, 300),
    url: input.url.slice(0, 2048),
    summary: input.summary.slice(0, 1000),
    context: input.context.slice(0, 8000),
    citations: input.citations,
    connectedByUserId: input.connectedBy.userId,
    connectedByName: input.connectedBy.name,
    syncedAt: now,
  };
  const [row] = await db
    .insert(venomOrgSourcesTable)
    .values(values)
    .onConflictDoUpdate({
      target: [venomOrgSourcesTable.orgId, venomOrgSourcesTable.sourceId],
      set: {
        provider: values.provider,
        name: values.name,
        url: values.url,
        summary: values.summary,
        context: values.context,
        citations: values.citations,
        connectedByUserId: values.connectedByUserId,
        connectedByName: values.connectedByName,
        syncedAt: values.syncedAt,
      },
    })
    .returning();
  return orgSourceView(row);
}

export async function listOrgSources(orgId: string): Promise<OrgSourceView[]> {
  const rows = await db
    .select()
    .from(venomOrgSourcesTable)
    .where(eq(venomOrgSourcesTable.orgId, orgId))
    .orderBy(asc(venomOrgSourcesTable.createdAt), asc(venomOrgSourcesTable.sourceId));
  return rows.map(orgSourceView);
}

export async function deleteOrgSource(input: {
  orgId: string;
  sourceId: string;
}): Promise<void> {
  const deleted = await db
    .delete(venomOrgSourcesTable)
    .where(
      and(
        eq(venomOrgSourcesTable.orgId, input.orgId),
        eq(venomOrgSourcesTable.sourceId, input.sourceId),
      ),
    )
    .returning({ sourceId: venomOrgSourcesTable.sourceId });
  if (deleted.length === 0) {
    throw new VenomOrgError(404, "This source is not connected to the company.");
  }
}

// ---------------------------------------------------------------------------
// Contribution audit
// ---------------------------------------------------------------------------

export type OrgAuditEntryView = {
  id: string;
  action: "promoted";
  conceptId: string;
  conceptLabel: string;
  actorUserId: string;
  actorName: string;
  createdAt: number;
};

export async function insertAuditEntry(input: {
  orgId: string;
  conceptId: string;
  conceptLabel: string;
  actor: VenomOrgIdentity;
  now?: number;
}): Promise<OrgAuditEntryView> {
  const [row] = await db
    .insert(venomOrgAuditTable)
    .values({
      id: generateOrgAuditId(),
      orgId: input.orgId,
      action: "promoted",
      conceptId: input.conceptId.slice(0, 120),
      conceptLabel: input.conceptLabel.slice(0, 200),
      actorUserId: input.actor.userId,
      actorName: input.actor.name,
      createdAt: input.now ?? Date.now(),
    })
    .returning();
  return {
    id: row.id,
    action: "promoted",
    conceptId: row.conceptId,
    conceptLabel: row.conceptLabel,
    actorUserId: row.actorUserId,
    actorName: row.actorName,
    createdAt: row.createdAt,
  };
}

export async function listAuditEntries(
  orgId: string,
  limit = 50,
): Promise<OrgAuditEntryView[]> {
  const rows = await db
    .select()
    .from(venomOrgAuditTable)
    .where(eq(venomOrgAuditTable.orgId, orgId))
    .orderBy(desc(venomOrgAuditTable.createdAt), desc(venomOrgAuditTable.id))
    .limit(Math.max(1, Math.min(limit, 50)));
  return rows.map((row) => ({
    id: row.id,
    action: "promoted" as const,
    conceptId: row.conceptId,
    conceptLabel: row.conceptLabel,
    actorUserId: row.actorUserId,
    actorName: row.actorName,
    createdAt: row.createdAt,
  }));
}
