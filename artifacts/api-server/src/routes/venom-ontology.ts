/**
 * Read/query API over the server-side Venom ontology store: cross-project
 * concept search and single-concept lookups with neighbors and evidence.
 *
 * Both endpoints accept an optional `org` query parameter. Without it they
 * read the caller's personal Brain; with it they read that company's shared
 * Brain after revalidating membership, so a removed member loses the layer
 * on their very next request.
 */

import { Router, type IRouter, type Request } from "express";
import { getAuth } from "@clerk/express";
import { VENOM_ONTOLOGY_OWNER_TYPE_USER } from "@workspace/db";
import {
  getOntologyConceptDetailForOwner,
  orgOwner,
  searchOntologyConceptsForOwner,
  userOwner,
  type OntologyOwner,
} from "../lib/venom-ontology-store";
import { requireMembership, VenomOrgError } from "../lib/venom-org-store";
import {
  collectEvidencePersonIds,
  defaultEvidenceAttribution,
  identityDisplayLabel,
  resolveVenomIdentities,
} from "../lib/venom-identity";
import { readWorkspaceConversation } from "../lib/venom-conversation-read";
import { databaseWorkspaceStore } from "./venom-workspace";

const MAX_DETAIL_PEOPLE = 16;

const MAX_QUERY_LENGTH = 200;
const MAX_CONCEPT_ID_LENGTH = 120;

const MAX_ORG_ID_LENGTH = 64;
const MAX_CONVERSATION_ID_LENGTH = 120;
const DEFAULT_SEARCH_LIMIT = 20;
const MAX_SEARCH_LIMIT = 50;

const router: IRouter = Router();

/** Resolve the Brain layer a request reads: personal, or a company's. */
async function resolveOwnerScope(
  req: Request,
  userId: string,
): Promise<OntologyOwner> {
  const rawOrg = typeof req.query.org === "string" ? req.query.org.trim() : "";
  if (!rawOrg) return userOwner(userId);
  if (rawOrg.length > MAX_ORG_ID_LENGTH) {
    throw new VenomOrgError(404, "Company not found.");
  }
  await requireMembership(rawOrg, userId);
  return orgOwner(rawOrg);
}

router.get("/venom/ontology/search", async (req, res): Promise<void> => {
  const auth = getAuth(req);
  if (!auth.userId) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  const rawQuery = typeof req.query.q === "string" ? req.query.q : "";
  if (rawQuery.length > MAX_QUERY_LENGTH) {
    res.status(400).json({ error: "Search query is too long" });
    return;
  }
  if (!rawQuery.trim()) {
    res.json({ results: [] });
    return;
  }

  const rawLimit = Number(req.query.limit);
  const limit = Number.isFinite(rawLimit)
    ? Math.max(1, Math.min(MAX_SEARCH_LIMIT, Math.floor(rawLimit)))
    : DEFAULT_SEARCH_LIMIT;

  try {
    const owner = await resolveOwnerScope(req, auth.userId);
    const results = await searchOntologyConceptsForOwner(
      owner,
      rawQuery,
      limit,
    );
    res.json({ results });
  } catch (error) {
    if (error instanceof VenomOrgError) {
      res.status(error.status).json({ error: error.message });
      return;
    }
    req.log.error({ err: error }, "Venom ontology search failed");
    res.status(500).json({ error: "Knowledge search unavailable" });
  }
});

router.get(
  "/venom/ontology/concepts/:conceptId",
  async (req, res): Promise<void> => {
    const auth = getAuth(req);
    if (!auth.userId) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }

    const conceptId = req.params.conceptId;
    if (!conceptId || conceptId.length > MAX_CONCEPT_ID_LENGTH) {
      res.status(404).json({ error: "Concept not found" });
      return;
    }

    try {
      const owner = await resolveOwnerScope(req, auth.userId);
      const detail = await getOntologyConceptDetailForOwner(owner, conceptId);
      if (!detail) {
        res.status(404).json({ error: "Concept not found" });
        return;
      }

      // Attribution defaulting happens at presentation time only: personal
      // evidence from before attribution existed is reported as the
      // ontology owner's, while stored rows keep their null stamp (so they
      // stay recognizable as pre-attribution). Company layers never default
      // a null stamp to the viewer — an unattributed shared record must not
      // masquerade as the requester's own work.
      const sources =
        owner.ownerType === VENOM_ONTOLOGY_OWNER_TYPE_USER
          ? defaultEvidenceAttribution(detail.concept.sources, auth.userId)
          : detail.concept.sources;
      const personIds = collectEvidencePersonIds(sources, MAX_DETAIL_PEOPLE);

      // Personal absorption restricts stamps to the owner; company records
      // carry any member's stamp, so this can resolve teammates too.
      let people = personIds.map((userId) => ({
        userId,
        displayName: null as string | null,
      }));
      try {
        const identities = await resolveVenomIdentities(personIds);
        people = personIds.map((userId) => ({
          userId,
          displayName: identityDisplayLabel(identities.get(userId)),
        }));
      } catch {
        // An identity hiccup must not hide the concept; clients label the
        // evidence with their own signed-in identity instead.
      }

      res.json({
        concept: { ...detail.concept, sources },
        neighbors: detail.neighbors,
        people,
      });
    } catch (error) {
      if (error instanceof VenomOrgError) {
        res.status(error.status).json({ error: error.message });
        return;
      }
      req.log.error({ err: error }, "Venom ontology concept lookup failed");
      res.status(500).json({ error: "Knowledge lookup unavailable" });
    }
  },
);

/**
 * Read-only view of one conversation from the synced workspace snapshot.
 *
 * Evidence rows on a server-side concept cite conversations the device may
 * never have synced; without this lookup the trail of proof dead-ends one
 * level below the concept. Owner-scoped by construction: it only ever reads
 * the signed-in user's own snapshot, so a foreign id simply misses.
 */
router.get(
  "/venom/conversations/:conversationId",
  async (req, res): Promise<void> => {
    const auth = getAuth(req);
    if (!auth.userId) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }

    const conversationId = req.params.conversationId;
    if (
      typeof conversationId !== "string" ||
      !conversationId ||
      conversationId.length > MAX_CONVERSATION_ID_LENGTH
    ) {
      res.status(404).json({ error: "Conversation not found" });
      return;
    }

    try {
      const workspace = await databaseWorkspaceStore.get(auth.userId);
      const found = workspace
        ? readWorkspaceConversation(workspace.state, conversationId)
        : null;
      if (!found) {
        res.status(404).json({ error: "Conversation not found" });
        return;
      }
      res.json(found);
    } catch (error) {
      req.log.error({ err: error }, "Venom conversation lookup failed");
      res.status(500).json({ error: "Conversation lookup unavailable" });
    }
  },
);

export default router;
