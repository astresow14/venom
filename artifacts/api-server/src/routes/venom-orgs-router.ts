/**
 * Company (organization) API for Venom: workspaces, membership, invites,
 * company-shared projects, company knowledge sources, the shared Brain
 * read endpoint, and the explicit promote-to-company action.
 *
 * Identity is the auth provider's (Clerk user ids + verified emails via
 * the backend API); org records and the shared ontology live in our
 * database. Every org-scoped route revalidates membership server-side —
 * removal takes effect on the next request, so a departed member's device
 * loses the company layer immediately.
 */

import { Router, type IRouter, type Request } from "express";
import {
  ConnectVenomOrgGitHubSourceBody,
  ConnectVenomOrgWebsiteSourceBody,
  CreateVenomOrgBody,
  InviteVenomOrgMemberBody,
  PromoteVenomConceptToOrgBody,
  ShareVenomOrgProjectBody,
} from "@workspace/api-zod";
import {
  asRepositoryPath,
  citationId,
  githubSource,
  parsePublicWebsiteUrl,
  sourceErrorResponse,
  sourceId,
  SourceRequestError,
  websiteText,
  type AddressResolver,
  type GitHubRequest,
  type WebsiteFetcher,
} from "./venom-sources-router";
import type { VenomOrgDirectory } from "../lib/venom-org-directory";
import {
  acceptInvite,
  createOrg,
  declineInvite,
  deleteOrg,
  deleteOrgSource,
  getSharedProjectForProject,
  insertAuditEntry,
  inviteMember,
  listAuditEntries,
  listInvitesForEmails,
  listMemberDirectory,
  listOrgSources,
  listOrgSummariesForUser,
  listSharedProjects,
  normalizeInviteEmail,
  removeMember,
  removeSharedProject,
  requireAdmin,
  requireMembership,
  revokeInvite,
  saveOrgSource,
  upsertSharedProject,
  VenomOrgError,
  type VenomOrgMemberView,
} from "../lib/venom-org-store";
import {
  InvalidConceptPayload,
  loadOntologyForOwner,
  orgOwner,
  promoteConceptToOrg,
  purgeOntologyOwner,
  replaceOrgSourceConcepts,
  type OrgSourceConceptSeed,
} from "../lib/venom-ontology-store";
import {
  orgTenant,
  purgeMasterTenant,
} from "../lib/venom-master-ontology";
import {
  ORG_EVENTS_HEARTBEAT_MS,
  publishOrgMembershipChanged,
  subscribeOrgEvents,
} from "../lib/venom-org-events";

export type OrgsRouterOptions = {
  resolveUserId: (req: Request) => string | null | undefined;
  directory: VenomOrgDirectory;
  isWorkspaceMember: (userId: string) => boolean;
  githubRequest: GitHubRequest;
  resolveAddresses: AddressResolver;
  fetchWebsite: WebsiteFetcher;
};

const MAX_ORG_ID = 64;
const MAX_INVITE_ID = 64;
const MAX_USER_ID = 64;
const MAX_PROJECT_ID = 120;
const MAX_SOURCE_ID = 160;

const compact = (text: string, max: number): string =>
  text.replace(/\s+/g, " ").trim().slice(0, max);

function sendOrgFailure(
  req: Request,
  res: Parameters<Parameters<IRouter["get"]>[1]>[1],
  error: unknown,
  fallback: string,
): void {
  if (error instanceof VenomOrgError) {
    res.status(error.status).json({ error: error.message });
    return;
  }
  req.log?.error({ err: error }, fallback);
  res.status(500).json({ error: fallback });
}

function sendSourceFailure(
  req: Request,
  res: Parameters<Parameters<IRouter["get"]>[1]>[1],
  error: unknown,
  fallback: string,
): void {
  if (error instanceof VenomOrgError) {
    res.status(error.status).json({ error: error.message });
    return;
  }
  const { status, message } = sourceErrorResponse(req, error, fallback);
  res.status(status).json({ error: message });
}

/** Turn a connected source's clusters + citations into ontology seeds. */
function seedsFromConnectedSource(source: {
  name: string;
  citations: { id: string; title: string; excerpt: string }[];
  clusters: {
    id: string;
    label: string;
    category: string;
    strength: number;
    citationIds: string[];
  }[];
}): OrgSourceConceptSeed[] {
  const citationById = new Map(
    source.citations.map((citation) => [citation.id, citation]),
  );
  return source.clusters.map((cluster) => {
    const cited = cluster.citationIds
      .map((id) => citationById.get(id))
      .filter((citation): citation is NonNullable<typeof citation> =>
        Boolean(citation),
      );
    const excerpt =
      compact(
        cited
          .map((citation) => `${citation.title}: ${citation.excerpt}`)
          .join(" • "),
        1800,
      ) || `${cluster.label} — connected from ${source.name}`;
    return {
      id: cluster.id,
      label: cluster.label,
      category: cluster.category,
      strength: cluster.strength,
      summary: excerpt,
      excerpt,
      citationIds: cluster.citationIds,
    };
  });
}

export function createVenomOrgsRouter({
  resolveUserId,
  directory,
  isWorkspaceMember,
  githubRequest,
  resolveAddresses,
  fetchWebsite,
}: OrgsRouterOptions): IRouter {
  const router: IRouter = Router();

  const requireUser = (
    req: Request,
    res: Parameters<Parameters<IRouter["get"]>[1]>[1],
  ): string | null => {
    const userId = resolveUserId(req);
    if (!userId) {
      res.status(401).json({ error: "Unauthorized" });
      return null;
    }
    return userId;
  };

  const orgIdParam = (
    req: Request,
    res: Parameters<Parameters<IRouter["get"]>[1]>[1],
  ): string | null => {
    const orgId = req.params.orgId;
    if (typeof orgId !== "string" || !orgId || orgId.length > MAX_ORG_ID) {
      res.status(404).json({ error: "Company not found." });
      return null;
    }
    return orgId;
  };

  // -------------------------------------------------------------------
  // Org directory
  // -------------------------------------------------------------------

  router.get("/venom/orgs", async (req, res): Promise<void> => {
    const userId = requireUser(req, res);
    if (!userId) return;
    try {
      const orgs = await listOrgSummariesForUser(userId);
      let invites: Awaited<ReturnType<typeof listInvitesForEmails>> = [];
      try {
        const identity = await directory.getIdentity(userId);
        invites = await listInvitesForEmails(identity.emails);
      } catch (error) {
        // The org list must survive an auth-directory hiccup; invites
        // simply reappear on the next poll.
        req.log?.warn({ err: error }, "Venom org invite lookup unavailable");
      }
      res.json({ orgs: orgs.slice(0, 50), invites: invites.slice(0, 50) });
    } catch (error) {
      sendOrgFailure(req, res, error, "Companies are unavailable right now.");
    }
  });

  router.post("/venom/orgs", async (req, res): Promise<void> => {
    const userId = requireUser(req, res);
    if (!userId) return;
    const body = CreateVenomOrgBody.safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ error: "Give the company a name." });
      return;
    }
    try {
      const creator = await directory.getIdentity(userId);
      const org = await createOrg({ name: body.data.name, creator });
      res.json(org);
    } catch (error) {
      sendOrgFailure(req, res, error, "The company could not be created.");
    }
  });

  router.delete("/venom/orgs/:orgId", async (req, res): Promise<void> => {
    const userId = requireUser(req, res);
    if (!userId) return;
    const orgId = orgIdParam(req, res);
    if (!orgId) return;
    try {
      await requireAdmin(orgId, userId);
      // Snapshot membership before the rows disappear so every member's
      // open devices can be told the layer is gone.
      const { members } = await listMemberDirectory(orgId);
      await purgeOntologyOwner(orgOwner(orgId));
      // A dissolved company's anonymous network signals (and its consent
      // row) go with it, so its influence disappears from future aggregates.
      await purgeMasterTenant(orgTenant(orgId));
      await deleteOrg(orgId);
      publishOrgMembershipChanged(
        members.map((member) => member.userId),
        orgId,
      );
      res.status(204).end();
    } catch (error) {
      sendOrgFailure(req, res, error, "The company could not be deleted.");
    }
  });

  /**
   * Live membership events for the signed-in user. One long-lived SSE
   * stream per device; `membership-changed` tells an open client to drop
   * that company's cached data immediately instead of waiting out the
   * directory poll.
   */
  router.get("/venom/orgs/events", (req, res): void => {
    const userId = requireUser(req, res);
    if (!userId) return;
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders?.();
    res.write(`data: ${JSON.stringify({ type: "connected" })}\n\n`);
    const unsubscribe = subscribeOrgEvents(userId, res);
    const heartbeat = setInterval(() => {
      try {
        res.write(": keep-alive\n\n");
      } catch {
        // The close handler tears everything down.
      }
    }, ORG_EVENTS_HEARTBEAT_MS);
    req.on("close", () => {
      clearInterval(heartbeat);
      unsubscribe();
    });
  });

  // -------------------------------------------------------------------
  // Members & invites
  // -------------------------------------------------------------------

  router.get("/venom/orgs/:orgId/members", async (req, res): Promise<void> => {
    const userId = requireUser(req, res);
    if (!userId) return;
    const orgId = orgIdParam(req, res);
    if (!orgId) return;
    try {
      await requireMembership(orgId, userId);
      const { members, invites } = await listMemberDirectory(orgId);
      res.json({
        members: members
          .slice(0, 500)
          .map((member) => ({ ...member, isSelf: member.userId === userId })),
        invites: invites.slice(0, 200),
      });
    } catch (error) {
      sendOrgFailure(req, res, error, "Members are unavailable right now.");
    }
  });

  router.delete(
    "/venom/orgs/:orgId/members/:memberUserId",
    async (req, res): Promise<void> => {
      const userId = requireUser(req, res);
      if (!userId) return;
      const orgId = orgIdParam(req, res);
      if (!orgId) return;
      const targetUserId = req.params.memberUserId;
      if (
        typeof targetUserId !== "string" ||
        !targetUserId ||
        targetUserId.length > MAX_USER_ID
      ) {
        res.status(404).json({ error: "They are not a member of this company." });
        return;
      }
      try {
        const access = await requireMembership(orgId, userId);
        if (targetUserId !== userId && access.role !== "admin") {
          throw new VenomOrgError(
            403,
            "Only company admins can remove other members.",
          );
        }
        await removeMember({ orgId, targetUserId });
        // Push the ending to the departed member's open devices (covers
        // self-removal too: their other devices must drop the layer now).
        publishOrgMembershipChanged([targetUserId], orgId);
        res.status(204).end();
      } catch (error) {
        sendOrgFailure(req, res, error, "The member could not be removed.");
      }
    },
  );

  router.post("/venom/orgs/:orgId/invites", async (req, res): Promise<void> => {
    const userId = requireUser(req, res);
    if (!userId) return;
    const orgId = orgIdParam(req, res);
    if (!orgId) return;
    const body = InviteVenomOrgMemberBody.safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ error: "Enter a valid email address." });
      return;
    }
    try {
      await requireAdmin(orgId, userId);
      const email = normalizeInviteEmail(body.data.email);
      const [inviter, matches] = await Promise.all([
        directory.getIdentity(userId),
        directory.findByEmail(email),
      ]);
      const outcome = await inviteMember({
        orgId,
        email,
        role: body.data.role === "admin" ? "admin" : "member",
        inviter,
        matches,
      });
      if (outcome.status === "added") {
        const member: VenomOrgMemberView & { isSelf: boolean } = {
          ...outcome.member,
          isSelf: outcome.member.userId === userId,
        };
        res.json({ status: "added", member });
        return;
      }
      res.json({ status: "invited", invite: outcome.invite });
    } catch (error) {
      sendOrgFailure(req, res, error, "The invite could not be sent.");
    }
  });

  router.delete(
    "/venom/orgs/:orgId/invites/:inviteId",
    async (req, res): Promise<void> => {
      const userId = requireUser(req, res);
      if (!userId) return;
      const orgId = orgIdParam(req, res);
      if (!orgId) return;
      const inviteId = req.params.inviteId;
      if (
        typeof inviteId !== "string" ||
        !inviteId ||
        inviteId.length > MAX_INVITE_ID
      ) {
        res.status(404).json({ error: "This invite no longer exists." });
        return;
      }
      try {
        await requireAdmin(orgId, userId);
        await revokeInvite({ orgId, inviteId });
        res.status(204).end();
      } catch (error) {
        sendOrgFailure(req, res, error, "The invite could not be revoked.");
      }
    },
  );

  router.post(
    "/venom/org-invites/:inviteId/accept",
    async (req, res): Promise<void> => {
      const userId = requireUser(req, res);
      if (!userId) return;
      const inviteId = req.params.inviteId;
      if (
        typeof inviteId !== "string" ||
        !inviteId ||
        inviteId.length > MAX_INVITE_ID
      ) {
        res.status(404).json({ error: "This invite no longer exists." });
        return;
      }
      try {
        const identity = await directory.getIdentity(userId);
        const org = await acceptInvite({ inviteId, identity });
        res.json(org);
      } catch (error) {
        sendOrgFailure(req, res, error, "The invite could not be accepted.");
      }
    },
  );

  router.post(
    "/venom/org-invites/:inviteId/decline",
    async (req, res): Promise<void> => {
      const userId = requireUser(req, res);
      if (!userId) return;
      const inviteId = req.params.inviteId;
      if (
        typeof inviteId !== "string" ||
        !inviteId ||
        inviteId.length > MAX_INVITE_ID
      ) {
        res.status(404).json({ error: "This invite no longer exists." });
        return;
      }
      try {
        const identity = await directory.getIdentity(userId);
        await declineInvite({ inviteId, identity });
        res.status(204).end();
      } catch (error) {
        sendOrgFailure(req, res, error, "The invite could not be declined.");
      }
    },
  );

  // -------------------------------------------------------------------
  // Shared Brain
  // -------------------------------------------------------------------

  router.get("/venom/orgs/:orgId/brain", async (req, res): Promise<void> => {
    const userId = requireUser(req, res);
    if (!userId) return;
    const orgId = orgIdParam(req, res);
    if (!orgId) return;
    try {
      const { org } = await requireMembership(orgId, userId);
      const [{ concepts }, audit] = await Promise.all([
        loadOntologyForOwner(orgOwner(orgId)),
        listAuditEntries(orgId, 50),
      ]);
      const ordered = [...concepts]
        .sort((a, b) => b.lastUpdatedAt - a.lastUpdatedAt)
        .slice(0, 1000);
      res.json({ orgId, orgName: org.name, concepts: ordered, audit });
    } catch (error) {
      sendOrgFailure(
        req,
        res,
        error,
        "The company Brain is unavailable right now.",
      );
    }
  });

  router.post("/venom/orgs/:orgId/promote", async (req, res): Promise<void> => {
    const userId = requireUser(req, res);
    if (!userId) return;
    const orgId = orgIdParam(req, res);
    if (!orgId) return;
    const body = PromoteVenomConceptToOrgBody.safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ error: "Invalid concept payload" });
      return;
    }
    try {
      await requireMembership(orgId, userId);
      const shared = await listSharedProjects(orgId);
      const { concept } = await promoteConceptToOrg({
        orgId,
        concept: body.data.concept,
        promotedByUserId: userId,
        keepProjectIds: new Set(shared.map((project) => project.projectId)),
      });
      const actor = await directory.getIdentity(userId);
      await insertAuditEntry({
        orgId,
        conceptId: concept.id,
        conceptLabel: concept.label,
        actor,
      });
      res.json({ concept });
    } catch (error) {
      if (error instanceof InvalidConceptPayload) {
        res.status(400).json({ error: "Invalid concept payload" });
        return;
      }
      sendOrgFailure(
        req,
        res,
        error,
        "The concept could not be promoted right now.",
      );
    }
  });

  // -------------------------------------------------------------------
  // Shared projects
  // -------------------------------------------------------------------

  router.get("/venom/orgs/:orgId/projects", async (req, res): Promise<void> => {
    const userId = requireUser(req, res);
    if (!userId) return;
    const orgId = orgIdParam(req, res);
    if (!orgId) return;
    try {
      await requireMembership(orgId, userId);
      const projects = await listSharedProjects(orgId);
      res.json({ projects: projects.slice(0, 200) });
    } catch (error) {
      sendOrgFailure(
        req,
        res,
        error,
        "Shared projects are unavailable right now.",
      );
    }
  });

  router.put(
    "/venom/orgs/:orgId/projects/:projectId",
    async (req, res): Promise<void> => {
      const userId = requireUser(req, res);
      if (!userId) return;
      const orgId = orgIdParam(req, res);
      if (!orgId) return;
      const projectId = req.params.projectId;
      if (
        typeof projectId !== "string" ||
        !projectId ||
        projectId.length > MAX_PROJECT_ID
      ) {
        res.status(400).json({ error: "Invalid project details" });
        return;
      }
      const body = ShareVenomOrgProjectBody.safeParse(req.body);
      if (!body.success) {
        res.status(400).json({ error: "Invalid project details" });
        return;
      }
      try {
        await requireAdmin(orgId, userId);
        const sharer = await directory.getIdentity(userId);
        const project = await upsertSharedProject({
          orgId,
          projectId,
          name: body.data.name,
          description: body.data.description ?? "",
          accent: body.data.accent ?? "",
          sharer,
        });
        res.json(project);
      } catch (error) {
        sendOrgFailure(req, res, error, "The project could not be shared.");
      }
    },
  );

  router.delete(
    "/venom/orgs/:orgId/projects/:projectId",
    async (req, res): Promise<void> => {
      const userId = requireUser(req, res);
      if (!userId) return;
      const orgId = orgIdParam(req, res);
      if (!orgId) return;
      const projectId = req.params.projectId;
      if (
        typeof projectId !== "string" ||
        !projectId ||
        projectId.length > MAX_PROJECT_ID
      ) {
        res.status(404).json({ error: "This project is not shared with the company." });
        return;
      }
      try {
        const access = await requireMembership(orgId, userId);
        const row = await getSharedProjectForProject(projectId);
        if (!row || row.orgId !== orgId) {
          throw new VenomOrgError(
            404,
            "This project is not shared with the company.",
          );
        }
        if (access.role !== "admin" && row.sharedByUserId !== userId) {
          throw new VenomOrgError(
            403,
            "Only company admins or the sharer can unshare a project.",
          );
        }
        await removeSharedProject({ orgId, projectId });
        res.status(204).end();
      } catch (error) {
        sendOrgFailure(req, res, error, "The project could not be unshared.");
      }
    },
  );

  // -------------------------------------------------------------------
  // Company knowledge sources
  // -------------------------------------------------------------------

  router.get("/venom/orgs/:orgId/sources", async (req, res): Promise<void> => {
    const userId = requireUser(req, res);
    if (!userId) return;
    const orgId = orgIdParam(req, res);
    if (!orgId) return;
    try {
      await requireMembership(orgId, userId);
      const sources = await listOrgSources(orgId);
      res.json({ sources: sources.slice(0, 100) });
    } catch (error) {
      sendOrgFailure(req, res, error, "Company sources are unavailable right now.");
    }
  });

  router.post(
    "/venom/orgs/:orgId/sources/github",
    async (req, res): Promise<void> => {
      const userId = requireUser(req, res);
      if (!userId) return;
      const orgId = orgIdParam(req, res);
      if (!orgId) return;
      const body = ConnectVenomOrgGitHubSourceBody.safeParse(req.body);
      if (!body.success) {
        res.status(400).json({ error: "Invalid repository identifier" });
        return;
      }
      const repositoryPath = asRepositoryPath(body.data.repository);
      if (!repositoryPath) {
        res.status(400).json({ error: "Invalid repository identifier" });
        return;
      }
      try {
        await requireAdmin(orgId, userId);
        if (!isWorkspaceMember(userId)) {
          throw new VenomOrgError(
            403,
            "Your account is not authorized to use this workspace GitHub connection.",
          );
        }
        const [repository, issueResponse, pullRequests] = await Promise.all([
          githubRequest<Parameters<typeof githubSource>[1]>(
            `/repos/${repositoryPath}`,
          ),
          githubRequest<Parameters<typeof githubSource>[2]>(
            `/repos/${repositoryPath}/issues?state=open&per_page=20`,
          ),
          githubRequest<Parameters<typeof githubSource>[3]>(
            `/repos/${repositoryPath}/pulls?state=open&per_page=10`,
          ),
        ]);
        const issues = issueResponse.filter((issue) => !issue.pull_request);

        // Namespacing by org keeps source ids deterministic per company, so
        // reconnecting the same repository replaces its concepts in place.
        const connected = githubSource(
          `org_${orgId}`,
          repository,
          issues,
          pullRequests,
        );
        const identity = await directory.getIdentity(userId);
        await replaceOrgSourceConcepts({
          orgId,
          sourceId: connected.id,
          sourceName: connected.name,
          seeds: seedsFromConnectedSource(connected),
        });
        const saved = await saveOrgSource({
          orgId,
          sourceId: connected.id,
          provider: "github",
          name: connected.name,
          url: connected.url,
          summary: connected.summary,
          context: connected.context,
          citations: connected.citations,
          connectedBy: identity,
        });
        res.json(saved);
      } catch (error) {
        sendSourceFailure(
          req,
          res,
          error,
          "Venom could not connect this GitHub repository.",
        );
      }
    },
  );

  router.post(
    "/venom/orgs/:orgId/sources/website",
    async (req, res): Promise<void> => {
      const userId = requireUser(req, res);
      if (!userId) return;
      const orgId = orgIdParam(req, res);
      if (!orgId) return;
      const body = ConnectVenomOrgWebsiteSourceBody.safeParse(req.body);
      if (!body.success) {
        res.status(400).json({ error: "Invalid request body" });
        return;
      }
      try {
        await requireAdmin(orgId, userId);
        const { url, address } = await parsePublicWebsiteUrl(
          body.data.url,
          resolveAddresses,
        );
        const websiteResponse = await fetchWebsite(url, address);
        const contentType = websiteResponse.contentType;
        if (
          websiteResponse.status < 200 ||
          websiteResponse.status >= 300 ||
          (!contentType.includes("text/html") &&
            !contentType.includes("application/xhtml"))
        ) {
          throw new SourceRequestError(
            `Website returned an unexpected response (${websiteResponse.status}).`,
            422,
          );
        }

        const content = websiteText(websiteResponse.html);
        const id = sourceId(`org_${orgId}`, `website:${url.href}`);
        const citation = {
          id: citationId(id, "website"),
          provider: "website" as const,
          kind: "website" as const,
          title: body.data.name?.trim() || content.title || url.hostname,
          url: url.href,
          excerpt:
            compact(content.excerpt, 800) || "Public website reference",
          reference: null,
        };
        const connected = {
          id,
          provider: "website" as const,
          name: citation.title,
          url: url.href,
          summary: `${citation.title} • public website • ${content.keywords.join(", ") || "reference material"}`,
          context: `[source:${citation.id}] website: ${citation.title}. ${compact(content.excerpt, 7200)} (${url.href})`,
          citations: [citation],
          clusters: [
            {
              id: `${id}_website`,
              label: citation.title,
              category: "website",
              strength: 0.8,
              citationIds: [citation.id],
            },
            ...content.keywords.map((keyword, index) => ({
              id: `${id}_topic_${keyword}`,
              label: keyword,
              category: "topic",
              strength: Math.max(0.45, 0.68 - index * 0.08),
              citationIds: [citation.id],
            })),
          ],
        };
        const identity = await directory.getIdentity(userId);
        await replaceOrgSourceConcepts({
          orgId,
          sourceId: connected.id,
          sourceName: connected.name,
          seeds: seedsFromConnectedSource(connected),
        });
        const saved = await saveOrgSource({
          orgId,
          sourceId: connected.id,
          provider: "website",
          name: connected.name,
          url: connected.url,
          summary: connected.summary,
          context: connected.context,
          citations: connected.citations,
          connectedBy: identity,
        });
        res.json(saved);
      } catch (error) {
        sendSourceFailure(
          req,
          res,
          error,
          "Venom could not read this website.",
        );
      }
    },
  );

  router.delete(
    "/venom/orgs/:orgId/sources/:sourceId",
    async (req, res): Promise<void> => {
      const userId = requireUser(req, res);
      if (!userId) return;
      const orgId = orgIdParam(req, res);
      if (!orgId) return;
      const removeId = req.params.sourceId;
      if (
        typeof removeId !== "string" ||
        !removeId ||
        removeId.length > MAX_SOURCE_ID
      ) {
        res.status(404).json({ error: "This source is not connected to the company." });
        return;
      }
      try {
        await requireAdmin(orgId, userId);
        // Retire the source's concepts first (replaced tombstones make the
        // retirement permanent), then drop the registry row.
        await replaceOrgSourceConcepts({
          orgId,
          sourceId: removeId,
          sourceName: "Removed source",
          seeds: [],
        });
        await deleteOrgSource({ orgId, sourceId: removeId });
        res.status(204).end();
      } catch (error) {
        sendOrgFailure(req, res, error, "The source could not be removed.");
      }
    },
  );

  return router;
}
