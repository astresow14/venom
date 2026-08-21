/**
 * Read/query API over the server-side Venom ontology store: cross-project
 * concept search and single-concept lookups with neighbors and evidence.
 */

import { Router, type IRouter } from "express";
import { getAuth } from "@clerk/express";
import {
  getOntologyConceptDetail,
  searchOntologyConcepts,
} from "../lib/venom-ontology-store";
import {
  collectEvidencePersonIds,
  defaultEvidenceAttribution,
  identityDisplayLabel,
  resolveVenomIdentities,
} from "../lib/venom-identity";

/** Matches the VenomOntologyConceptDetail.people maxItems contract. */
const MAX_DETAIL_PEOPLE = 16;

const MAX_QUERY_LENGTH = 200;
const MAX_CONCEPT_ID_LENGTH = 120;
const DEFAULT_SEARCH_LIMIT = 20;
const MAX_SEARCH_LIMIT = 50;

const router: IRouter = Router();

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
    const results = await searchOntologyConcepts(auth.userId, rawQuery, limit);
    res.json({ results });
  } catch (error) {
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
    if (
      typeof conceptId !== "string" ||
      !conceptId ||
      conceptId.length > MAX_CONCEPT_ID_LENGTH
    ) {
      res.status(404).json({ error: "Concept not found" });
      return;
    }

    try {
      const detail = await getOntologyConceptDetail(auth.userId, conceptId);
      if (!detail) {
        res.status(404).json({ error: "Concept not found" });
        return;
      }

      // Attribution defaulting happens at presentation time only: evidence
      // from before attribution existed is reported as the ontology
      // owner's, while stored rows keep their null stamp (so they stay
      // recognizable as pre-attribution).
      const sources = defaultEvidenceAttribution(
        detail.concept.sources,
        auth.userId,
      );
      const personIds = collectEvidencePersonIds(sources, MAX_DETAIL_PEOPLE);

      // Absorption restricts stamps to the owner, so this only ever
      // resolves the requester's own identity today.
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
      req.log.error({ err: error }, "Venom ontology concept lookup failed");
      res.status(500).json({ error: "Knowledge lookup unavailable" });
    }
  },
);

export default router;
