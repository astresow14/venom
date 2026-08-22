/**
 * Author-facing endpoints for the knowledge-move ledger.
 *
 * Everything here is strictly author-scoped: notices and suggestions are
 * only ever listed for the signed-in account, and every mutation re-verifies
 * ownership. Membership rules differ by direction on purpose:
 *
 * - UNDO needs no membership — retracting your own knowledge from a
 *   workspace you since left must keep working.
 * - ACCEPT (personal → workspace) re-checks live membership right before
 *   moving, because acceptance is the step that widens visibility.
 * - The manual Unsorted move re-checks membership the same way.
 */

import { getAuth } from "@clerk/express";
import { Router, type IRouter } from "express";
import {
  AcceptVenomKnowledgeSuggestionResponse,
  DismissVenomKnowledgeSuggestionResponse,
  ListVenomKnowledgeMovesResponse,
  MoveVenomUnsortedConceptBody,
  MoveVenomUnsortedConceptResponse,
  UndoVenomKnowledgeMoveResponse,
} from "@workspace/api-zod";
import {
  acceptKnowledgeSuggestion,
  dismissKnowledgeSuggestion,
  getKnowledgeMove,
  listKnowledgeMoves,
  undoKnowledgeMove,
  type RefilePayload,
  type SuggestionPayload,
} from "../lib/venom-knowledge-moves";
import {
  loadOntologyConcepts,
  moveOntologyConceptBetweenOwners,
  userOwner,
  workspaceOwner,
} from "../lib/venom-ontology-store";
import {
  getSharedWorkspaceMembership,
  workspaceAccessDeniedBody,
} from "../lib/workspace-membership";

const router: IRouter = Router();

router.get("/venom/knowledge/moves", async (req, res): Promise<void> => {
  const auth = getAuth(req);
  if (!auth.userId) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  const { notices, suggestions } = await listKnowledgeMoves(auth.userId);
  res.json(
    ListVenomKnowledgeMovesResponse.parse({
      notices: notices.map((record) => ({
        id: record.id,
        kind: record.kind,
        status: record.status,
        ...(record.kind === "refile"
          ? { direction: (record.payload as RefilePayload).direction }
          : {}),
        workspaceId: record.workspaceId,
        workspaceName: record.workspaceName,
        labels: record.labels,
        createdAt: record.createdAt.getTime(),
      })),
      suggestions: suggestions.map((record) => ({
        id: record.id,
        workspaceId: record.workspaceId,
        workspaceName: record.workspaceName,
        conceptId: (record.payload as SuggestionPayload).conceptId,
        label: record.labels[0] ?? "",
        createdAt: record.createdAt.getTime(),
      })),
    }),
  );
});

router.post(
  "/venom/knowledge/moves/:moveId/undo",
  async (req, res): Promise<void> => {
    const auth = getAuth(req);
    if (!auth.userId) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    const moveId = String(req.params.moveId ?? "");
    const outcome = await undoKnowledgeMove(auth.userId, moveId);
    if (outcome.outcome === "not_found") {
      res.status(404).json({ error: "Move not found" });
      return;
    }
    if (outcome.outcome === "conflict") {
      res
        .status(409)
        .json({ error: `Move already ${outcome.status}` });
      return;
    }
    if (outcome.outcome === "expired") {
      res
        .status(410)
        .json({ error: "The undo window for this move has closed" });
      return;
    }
    if (outcome.outcome === "changed") {
      res.status(409).json({
        error:
          "This knowledge has changed since the move, so undo is no longer available",
      });
      return;
    }
    res.json(
      UndoVenomKnowledgeMoveResponse.parse({ restored: outcome.restored }),
    );
  },
);

router.post(
  "/venom/knowledge/moves/:moveId/accept",
  async (req, res): Promise<void> => {
    const auth = getAuth(req);
    if (!auth.userId) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    const moveId = String(req.params.moveId ?? "");
    const record = await getKnowledgeMove(auth.userId, moveId);
    if (!record || record.kind !== "suggestion" || !record.workspaceId) {
      res.status(404).json({ error: "Suggestion not found" });
      return;
    }
    if (record.status !== "pending") {
      res.status(409).json({ error: `Suggestion already ${record.status}` });
      return;
    }
    // Live membership at the moment of consent: accepting is what widens
    // visibility, so a stale suggestion into a workspace the author left
    // (or was removed from) must die here.
    const membership = await getSharedWorkspaceMembership(
      record.workspaceId,
      auth.userId,
    );
    if (!membership) {
      res.status(403).json(workspaceAccessDeniedBody());
      return;
    }
    const outcome = await acceptKnowledgeSuggestion(auth.userId, record);
    if (outcome.outcome === "not_found" || outcome.outcome === "gone") {
      res.status(404).json({ error: "Suggestion no longer applies" });
      return;
    }
    if (outcome.outcome === "conflict") {
      res.status(409).json({ error: `Suggestion already ${outcome.status}` });
      return;
    }
    res.json(
      AcceptVenomKnowledgeSuggestionResponse.parse({
        workspaceId: record.workspaceId,
        workspaceName: membership.workspaceName,
        conceptId: (record.payload as SuggestionPayload).conceptId,
        movedConceptId: outcome.moved.id,
        merged: outcome.merged,
      }),
    );
  },
);

router.post(
  "/venom/knowledge/moves/:moveId/dismiss",
  async (req, res): Promise<void> => {
    const auth = getAuth(req);
    if (!auth.userId) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    const moveId = String(req.params.moveId ?? "");
    const outcome = await dismissKnowledgeSuggestion(auth.userId, moveId);
    if (outcome.outcome === "not_found") {
      res.status(404).json({ error: "Suggestion not found" });
      return;
    }
    if (outcome.outcome === "conflict") {
      res.status(409).json({ error: `Suggestion already ${outcome.status}` });
      return;
    }
    res.json(
      DismissVenomKnowledgeSuggestionResponse.parse({ dismissed: true }),
    );
  },
);

router.post(
  "/venom/knowledge/unsorted/:conceptId/move",
  async (req, res): Promise<void> => {
    const auth = getAuth(req);
    if (!auth.userId) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    const parsed = MoveVenomUnsortedConceptBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid move request" });
      return;
    }
    const membership = await getSharedWorkspaceMembership(
      parsed.data.workspaceId,
      auth.userId,
    );
    if (!membership) {
      res.status(403).json(workspaceAccessDeniedBody());
      return;
    }
    const conceptId = String(req.params.conceptId ?? "");
    const concepts = await loadOntologyConcepts(userOwner(auth.userId));
    const concept = concepts.find((entry) => entry.id === conceptId);
    if (!concept) {
      res.status(404).json({ error: "Concept not found" });
      return;
    }
    if (concept.unsorted !== true) {
      // This endpoint exists for the Unsorted review; sorted personal
      // knowledge reaches a workspace via a suggestion accept instead.
      res.status(409).json({ error: "Concept is not unsorted" });
      return;
    }
    const moved = await moveOntologyConceptBetweenOwners({
      fromOwner: userOwner(auth.userId),
      toOwner: workspaceOwner(parsed.data.workspaceId),
      conceptId,
      movedByUserId: auth.userId,
      targetProjectId: null,
    });
    if (!moved) {
      res.status(404).json({ error: "Concept not found" });
      return;
    }
    res.json(
      MoveVenomUnsortedConceptResponse.parse({
        workspaceId: parsed.data.workspaceId,
        workspaceName: membership.workspaceName,
        conceptId,
        movedConceptId: moved.moved.id,
        merged: moved.merged,
      }),
    );
  },
);

export default router;
