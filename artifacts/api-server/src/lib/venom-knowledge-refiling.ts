/**
 * Re-filing pass: let new knowledge clarify old placements.
 *
 * Runs after each extraction filing, off the request path. It looks only at
 * cheap deterministic signals — exact normalized-label matches between what
 * just filed and what already exists — so it stays fast, free, and easy to
 * reason about:
 *
 * - Unsorted → workspace: an unsorted personal concept whose label just
 *   filed into a workspace is clarified by that arrival — but even then it
 *   only becomes a one-tap suggestion. Unsorted records live in the
 *   author's private store, and nothing may leave the private store and
 *   widen visibility without the author's explicit acceptance.
 * - Workspace → personal: a workspace concept authored solely by this user
 *   whose label the classifier just confidently filed as personal moves
 *   back out immediately — misfiles into shared stores should not linger,
 *   and this direction only ever narrows visibility.
 * - Personal → workspace: an established personal concept matching a fresh
 *   workspace filing is likewise only ever SUGGESTED. Accepting widens
 *   visibility to teammates, so that stays a one-tap decision, never
 *   automatic.
 *
 * Boundaries: every move re-checks live membership by loading through the
 * membership list at pass time; concepts touched by a recent move or
 * suggestion are left alone so undo and re-file cannot ping-pong.
 */

import { normalizeLabel } from "./venom-ontology-core";
import {
  loadOntologyConcepts,
  moveOntologyConceptBetweenOwners,
  userOwner,
  workspaceOwner,
} from "./venom-ontology-store";
import { listSharedWorkspaceMemberships } from "./workspace-membership";
import {
  recentMoveConceptIds,
  recordRefileNotice,
  recordSuggestion,
} from "./venom-knowledge-moves";

export type RefilingTrigger = {
  userId: string;
  conversation: { id: string; title: string; projectId: string | null };
  /** Labels the extraction just filed into the sorted personal Brain. */
  personalLabels: string[];
  /** Workspaces the extraction just filed into, with their labels. */
  workspaceFilings: Array<{
    workspaceId: string;
    workspaceName: string;
    labels: string[];
  }>;
  now?: number;
};

export type RefilingOutcome = {
  moved: number;
  suggested: number;
};

/** Hard caps per pass; anything beyond waits for the next filing. */
export const MAX_REFILE_MOVES_PER_PASS = 8;
export const MAX_SUGGESTIONS_PER_PASS = 4;

/** How many workspaces a single pass will scan for misfiled concepts. */
const MAX_WORKSPACES_SCANNED = 5;

/** Concepts involved in a move this recently are left alone. */
const RECENT_MOVE_WINDOW_MS = 24 * 60 * 60 * 1000;

/** A personal concept must be this established before we suggest sharing. */
function isEstablished(concept: {
  mentionCount: number;
  sources: unknown[];
}): boolean {
  return concept.mentionCount >= 2 || concept.sources.length >= 2;
}

export async function runKnowledgeRefilingPass(
  trigger: RefilingTrigger,
): Promise<RefilingOutcome> {
  const now = trigger.now ?? Date.now();
  const outcome: RefilingOutcome = { moved: 0, suggested: 0 };
  const hasSignals =
    trigger.personalLabels.length > 0 || trigger.workspaceFilings.length > 0;
  if (!hasSignals) return outcome;

  // Live membership list at pass time: a workspace the author just lost
  // never receives (or gives up) anything here.
  const memberships = await listSharedWorkspaceMemberships(trigger.userId);
  if (memberships.length === 0) return outcome;
  const membershipById = new Map(
    memberships.map((membership) => [membership.workspaceId, membership]),
  );

  const recentIds = await recentMoveConceptIds(
    trigger.userId,
    now - RECENT_MOVE_WINDOW_MS,
  );

  const personalConcepts = await loadOntologyConcepts(
    userOwner(trigger.userId),
  );
  const personalFiledSet = new Set(
    trigger.personalLabels.map((label) => normalizeLabel(label)),
  );

  // --- Workspace → personal -----------------------------------------------
  if (personalFiledSet.size > 0) {
    for (const membership of memberships.slice(0, MAX_WORKSPACES_SCANNED)) {
      if (outcome.moved >= MAX_REFILE_MOVES_PER_PASS) break;
      let workspaceConcepts;
      try {
        workspaceConcepts = await loadOntologyConcepts(
          workspaceOwner(membership.workspaceId),
        );
      } catch (error) {
        console.error("venom refiling workspace load failed", error);
        continue;
      }
      for (const concept of workspaceConcepts) {
        if (outcome.moved >= MAX_REFILE_MOVES_PER_PASS) break;
        if (recentIds.has(concept.id)) continue;
        if (!personalFiledSet.has(normalizeLabel(concept.label))) continue;
        // Only the author's own knowledge may leave a shared store: every
        // evidence stamp must name them, and admin-curated (admin-only)
        // records stay where the admin put them.
        if (concept.adminOnly === true) continue;
        if (concept.sources.length === 0) continue;
        if (
          !concept.sources.every(
            (evidence) => evidence.capturedByUserId === trigger.userId,
          )
        ) {
          continue;
        }
        const moved = await moveOntologyConceptBetweenOwners({
          fromOwner: workspaceOwner(membership.workspaceId),
          toOwner: userOwner(trigger.userId),
          conceptId: concept.id,
          movedByUserId: trigger.userId,
          targetProjectId: trigger.conversation.projectId,
          now,
        });
        if (!moved) continue;
        await recordRefileNotice({
          userId: trigger.userId,
          fromOwner: workspaceOwner(membership.workspaceId),
          toOwner: userOwner(trigger.userId),
          workspaceId: membership.workspaceId,
          workspaceName: membership.workspaceName,
          label: concept.label,
          payload: {
            direction: "workspace_to_personal",
            movedConceptId: moved.moved.id,
            merged: moved.merged,
            sourceBefore: moved.sourceBefore,
            targetBefore: moved.targetBefore,
            targetProjectId: trigger.conversation.projectId,
            afterUpdatedAt: moved.moved.lastUpdatedAt,
          },
          now,
        });
        outcome.moved += 1;
        recentIds.add(concept.id);
      }
    }
  }

  // --- Personal store → workspace (suggestion only, unsorted included) -----
  for (const filing of trigger.workspaceFilings) {
    if (outcome.suggested >= MAX_SUGGESTIONS_PER_PASS) break;
    const membership = membershipById.get(filing.workspaceId);
    if (!membership) continue;
    const filedSet = new Set(
      filing.labels.map((label) => normalizeLabel(label)),
    );
    for (const concept of personalConcepts) {
      if (outcome.suggested >= MAX_SUGGESTIONS_PER_PASS) break;
      if (recentIds.has(concept.id)) continue;
      const normalized = normalizeLabel(concept.label);
      if (!filedSet.has(normalized)) continue;
      // Conflicting fresh signals (the classifier just filed this same
      // label as personal) mean the destination is NOT clear — skip.
      if (personalFiledSet.has(normalized)) continue;
      // A clarified unsorted item qualifies immediately; sorted personal
      // knowledge must be established before we even suggest sharing it.
      if (concept.unsorted !== true && !isEstablished(concept)) continue;
      const suggestionId = await recordSuggestion({
        userId: trigger.userId,
        workspaceId: filing.workspaceId,
        workspaceName: membership.workspaceName,
        conceptId: concept.id,
        label: concept.label,
        projectId: concept.projectId,
        now,
      });
      if (suggestionId) {
        outcome.suggested += 1;
        recentIds.add(concept.id);
      }
    }
  }

  return outcome;
}
