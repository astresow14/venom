/**
 * API for the anonymous Venom master ontology: per-user and per-company
 * contribution consent, the aggregate master Brain map, and "related in the
 * Venom network" suggestions.
 *
 * Every read here serves aggregate data only — concepts and links that
 * cleared the distinct-tenant anonymity threshold — and every consent write
 * is enforced server-side (company settings by admins only). Turning
 * contribution off removes the tenant's past signals before responding.
 */

import { Router, type IRouter, type Request, type Response } from "express";
import { getAuth } from "@clerk/express";
import {
  ApplyVenomMasterSuggestionBody,
  DismissVenomMasterSuggestionBody,
  UpdateVenomMasterContributionBody,
} from "@workspace/api-zod";
import {
  contributeConceptGraph,
  dismissMasterSuggestion,
  getMasterBrain,
  getMasterConcept,
  getMasterSuggestions,
  isMasterContributionEnabled,
  orgTenant,
  setMasterContribution,
  userTenant,
} from "../lib/venom-master-ontology";
import {
  fileExtractedKnowledge,
  loadOntologyConcepts,
  orgOwner,
  userOwner,
  type OntologyOwner,
} from "../lib/venom-ontology-store";
import {
  requireAdmin,
  requireMembership,
  VenomOrgError,
} from "../lib/venom-org-store";

const MAX_ORG_ID_LENGTH = 64;

const router: IRouter = Router();

function requireUserId(req: Request, res: Response): string | null {
  const auth = getAuth(req);
  if (!auth.userId) {
    res.status(401).json({ error: "Unauthorized" });
    return null;
  }
  return auth.userId;
}

function orgIdParam(req: Request, res: Response): string | null {
  const raw = typeof req.params.orgId === "string" ? req.params.orgId.trim() : "";
  if (!raw || raw.length > MAX_ORG_ID_LENGTH) {
    res.status(404).json({ error: "Company not found." });
    return null;
  }
  return raw;
}

function sendMasterFailure(
  req: Request,
  res: Response,
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

// ─── Personal consent ────────────────────────────────────────────────────────

router.get("/venom/master/contribution", async (req, res): Promise<void> => {
  const userId = requireUserId(req, res);
  if (!userId) return;
  try {
    const enabled = await isMasterContributionEnabled(userTenant(userId));
    res.json({ enabled });
  } catch (error) {
    sendMasterFailure(
      req,
      res,
      error,
      "The contribution setting is unavailable right now.",
    );
  }
});

router.put("/venom/master/contribution", async (req, res): Promise<void> => {
  const userId = requireUserId(req, res);
  if (!userId) return;
  const body = UpdateVenomMasterContributionBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: "Invalid contribution setting" });
    return;
  }
  try {
    const tenant = userTenant(userId);
    const { enabled } = await setMasterContribution({
      tenant,
      enabled: body.data.enabled,
      updatedByUserId: userId,
    });
    if (enabled) {
      // Seed signals from the current Brain so the choice takes effect
      // without waiting for the next filing. Same boundary as filings:
      // labels, categories, and link pairs only.
      try {
        await contributeConceptGraph(
          tenant,
          await loadOntologyConcepts(userOwner(userId)),
        );
      } catch (error) {
        req.log?.warn(
          { err: error },
          "Master ontology backfill failed after personal opt-in",
        );
      }
    }
    res.json({ enabled });
  } catch (error) {
    sendMasterFailure(
      req,
      res,
      error,
      "The contribution setting could not be saved right now.",
    );
  }
});

// ─── Company consent (admin-controlled) ──────────────────────────────────────

router.get(
  "/venom/orgs/:orgId/contribution",
  async (req, res): Promise<void> => {
    const userId = requireUserId(req, res);
    if (!userId) return;
    const orgId = orgIdParam(req, res);
    if (!orgId) return;
    try {
      await requireMembership(orgId, userId);
      const enabled = await isMasterContributionEnabled(orgTenant(orgId));
      res.json({ enabled });
    } catch (error) {
      sendMasterFailure(
        req,
        res,
        error,
        "The company contribution setting is unavailable right now.",
      );
    }
  },
);

router.put(
  "/venom/orgs/:orgId/contribution",
  async (req, res): Promise<void> => {
    const userId = requireUserId(req, res);
    if (!userId) return;
    const orgId = orgIdParam(req, res);
    if (!orgId) return;
    const body = UpdateVenomMasterContributionBody.safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ error: "Invalid contribution setting" });
      return;
    }
    try {
      await requireAdmin(orgId, userId);
      const tenant = orgTenant(orgId);
      const { enabled } = await setMasterContribution({
        tenant,
        enabled: body.data.enabled,
        updatedByUserId: userId,
      });
      if (enabled) {
        try {
          await contributeConceptGraph(
            tenant,
            await loadOntologyConcepts(orgOwner(orgId)),
          );
        } catch (error) {
          req.log?.warn(
            { err: error },
            "Master ontology backfill failed after company opt-in",
          );
        }
      }
      res.json({ enabled });
    } catch (error) {
      sendMasterFailure(
        req,
        res,
        error,
        "The company contribution setting could not be saved right now.",
      );
    }
  },
);

// ─── Master map ──────────────────────────────────────────────────────────────

router.get("/venom/master/brain", async (req, res): Promise<void> => {
  const userId = requireUserId(req, res);
  if (!userId) return;
  try {
    const brain = await getMasterBrain();
    res.json(brain);
  } catch (error) {
    sendMasterFailure(
      req,
      res,
      error,
      "The Venom network map is unavailable right now.",
    );
  }
});

// ─── Suggestions ─────────────────────────────────────────────────────────────

router.get("/venom/master/suggestions", async (req, res): Promise<void> => {
  const userId = requireUserId(req, res);
  if (!userId) return;
  const rawOrg = typeof req.query.org === "string" ? req.query.org.trim() : "";
  if (rawOrg.length > MAX_ORG_ID_LENGTH) {
    res.status(404).json({ error: "Company not found." });
    return;
  }
  try {
    let owner: OntologyOwner = userOwner(userId);
    if (rawOrg) {
      await requireMembership(rawOrg, userId);
      owner = orgOwner(rawOrg);
    }
    const ownConcepts = await loadOntologyConcepts(owner);
    const suggestions = await getMasterSuggestions({ userId, ownConcepts });
    res.json({ suggestions });
  } catch (error) {
    sendMasterFailure(
      req,
      res,
      error,
      "Venom network suggestions are unavailable right now.",
    );
  }
});

router.post(
  "/venom/master/suggestions/dismiss",
  async (req, res): Promise<void> => {
    const userId = requireUserId(req, res);
    if (!userId) return;
    const body = DismissVenomMasterSuggestionBody.safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ error: "Invalid suggestion" });
      return;
    }
    try {
      await dismissMasterSuggestion({ userId, label: body.data.label });
      res.json({ dismissed: true });
    } catch (error) {
      sendMasterFailure(
        req,
        res,
        error,
        "The suggestion could not be dismissed right now.",
      );
    }
  },
);

const SUGGESTION_CONVERSATION = {
  id: "venom-master-suggestions",
  title: "Venom network suggestions",
  projectId: null,
} as const;

router.post(
  "/venom/master/suggestions/apply",
  async (req, res): Promise<void> => {
    const userId = requireUserId(req, res);
    if (!userId) return;
    const body = ApplyVenomMasterSuggestionBody.safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ error: "Invalid suggestion" });
      return;
    }
    try {
      // Only above-threshold aggregate concepts can be applied; anything
      // else has never been visible and stays that way.
      const concept = await getMasterConcept(body.data.label);
      if (!concept) {
        res
          .status(404)
          .json({ error: "This suggestion is no longer available." });
        return;
      }
      const candidate = {
        label: concept.label,
        category: concept.category,
        confidence: 0.6,
        summary: "Added from Venom's shared knowledge network.",
        sourceMessageIds: [],
        relatedLabels: [],
      };
      const orgId = body.data.orgId?.trim();
      if (orgId) {
        const { org } = await requireMembership(orgId, userId);
        await fileExtractedKnowledge({
          owner: orgOwner(orgId),
          capturedByUserId: userId,
          conversation: { ...SUGGESTION_CONVERSATION },
          candidates: [candidate],
        });
        // Company concepts stay in the company layer; clients refresh the
        // shared Brain instead of mirroring anything locally.
        res.json({
          filedScope: { ownerType: "org", orgId, orgName: org.name },
        });
        return;
      }
      const { filed } = await fileExtractedKnowledge({
        owner: userOwner(userId),
        capturedByUserId: userId,
        conversation: { ...SUGGESTION_CONVERSATION },
        candidates: [candidate],
      });
      res.json({ filedScope: { ownerType: "user" }, filed });
    } catch (error) {
      sendMasterFailure(
        req,
        res,
        error,
        "The suggestion could not be added right now.",
      );
    }
  },
);

export default router;
