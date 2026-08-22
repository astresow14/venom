/**
 * Classified filing: land extracted clusters in the right store without a
 * user-picked destination.
 *
 * The extraction model annotates each cluster with a scope verdict; this
 * module validates those verdicts (`resolveClusterScope`), RE-CHECKS the
 * author's live membership for every targeted workspace after the model
 * call, and then files:
 *
 * - confident personal clusters → sorted personal Brain,
 * - confident workspace clusters → that workspace's Brain, with an
 *   undoable auto-file notice recorded BEFORE the response mentions it,
 * - everything else → the author-private Unsorted holding area.
 *
 * Failure posture: a workspace batch that cannot be filed-with-notice is
 * demoted to Unsorted rather than dropped or silently filed — the notice
 * is part of the guardrail, not decoration. The personal store is written
 * exactly once per extraction (a single filing pass), so ambient strength
 * decay applies once no matter how clusters were classified.
 */

import type { NormalizedKnowledgeCluster } from "./venom-knowledge";
import type { InsightCandidate, OntologyConcept } from "./venom-ontology-core";
import {
  fileExtractedKnowledge,
  restoreConceptStates,
  userOwner,
  workspaceOwner,
} from "./venom-ontology-store";
import {
  getSharedWorkspaceMembership,
  type SharedWorkspaceMembership,
} from "./workspace-membership";
import { resolveClusterScope } from "./venom-scope-classification";
import {
  recordAutoFileNotice,
  type AutoFilePayload,
} from "./venom-knowledge-moves";

/** One workspace the extraction filed into, as reported to the author. */
export type WorkspaceFilingSummary = {
  noticeId: string;
  workspaceId: string;
  workspaceName: string;
  labels: string[];
  /** The workspace-store records the filing touched (not sent to clients). */
  filed: OntologyConcept[];
};

export type ClassifiedFilingResult = {
  /** Personal-store records (sorted and unsorted) for the client to apply. */
  filed: OntologyConcept[];
  workspaceFilings: WorkspaceFilingSummary[];
  /** Labels that filed into the sorted personal Brain (re-filing trigger). */
  personalLabels: string[];
  /** Labels that landed in the Unsorted holding area. */
  unsortedLabels: string[];
};

/** Strip scope verdicts off a cluster, leaving a plain filing candidate. */
export function candidateFromCluster(
  cluster: NormalizedKnowledgeCluster,
): InsightCandidate {
  const { scope: _scope, scopeConfidence: _confidence, ...rest } = cluster;
  return rest;
}

/**
 * File classified clusters for an author with shared-workspace memberships.
 * Callers with NO memberships must not route through here — the route files
 * personal directly with zero classification overhead.
 */
export async function performClassifiedFiling(input: {
  userId: string;
  conversation: { id: string; title: string; projectId: string | null };
  clusters: NormalizedKnowledgeCluster[];
  /** Memberships as listed BEFORE the model call (names + ids for display). */
  memberships: SharedWorkspaceMembership[];
  now?: number;
}): Promise<ClassifiedFilingResult> {
  const now = input.now ?? Date.now();
  const memberIds = new Set(
    input.memberships.map((membership) => membership.workspaceId),
  );
  const nameById = new Map(
    input.memberships.map((membership) => [
      membership.workspaceId,
      membership.workspaceName,
    ]),
  );

  const personal: InsightCandidate[] = [];
  const unsorted: InsightCandidate[] = [];
  const byWorkspace = new Map<string, InsightCandidate[]>();

  for (const cluster of input.clusters) {
    const candidate = candidateFromCluster(cluster);
    const resolved = resolveClusterScope(
      { scope: cluster.scope, scopeConfidence: cluster.scopeConfidence },
      memberIds,
    );
    if (resolved.kind === "personal") {
      personal.push(candidate);
    } else if (resolved.kind === "workspace") {
      const batch = byWorkspace.get(resolved.workspaceId) ?? [];
      batch.push(candidate);
      byWorkspace.set(resolved.workspaceId, batch);
    } else {
      unsorted.push(candidate);
    }
  }

  // Workspace batches first: any batch that cannot complete the whole
  // file-then-notice sequence is demoted to Unsorted before the single
  // personal-store pass below picks it up.
  const workspaceFilings: WorkspaceFilingSummary[] = [];
  for (const [workspaceId, batch] of byWorkspace) {
    // Membership re-check AFTER the model call, per targeted workspace:
    // the model's verdict can never widen access that was revoked while
    // it was thinking, and the fresh role decides admin-only visibility.
    let role: SharedWorkspaceMembership["role"] | null = null;
    let workspaceName = nameById.get(workspaceId) ?? "";
    try {
      const live = await getSharedWorkspaceMembership(workspaceId, input.userId);
      if (live) {
        role = live.role;
        workspaceName = live.workspaceName;
      }
    } catch (error) {
      console.error("venom filing membership re-check failed", error);
    }
    if (role === null) {
      unsorted.push(...batch);
      continue;
    }

    try {
      const filing = await fileExtractedKnowledge({
        owner: workspaceOwner(workspaceId),
        capturedByUserId: input.userId,
        // Workspace knowledge is cross-project: same contract as the old
        // explicit workspace filing.
        conversation: { ...input.conversation, projectId: null },
        candidates: batch,
        excludeAdminOnlyConcepts: role !== "admin",
        now,
      });
      const labels = batch.map((candidate) => candidate.label);
      const payload: AutoFilePayload = {
        conversation: input.conversation,
        candidates: batch,
        touched: filing.touchedBefore,
        // Post-filing fingerprints: undo verifies these still match so it
        // can never erase a teammate's later edit, merge, or deletion.
        touchedAfter: filing.filed.map((concept) => ({
          id: concept.id,
          lastUpdatedAt: concept.lastUpdatedAt,
        })),
      };
      let noticeId: string;
      try {
        noticeId = await recordAutoFileNotice({
          userId: input.userId,
          workspaceId,
          workspaceName,
          labels,
          payload,
          now,
        });
      } catch (noticeError) {
        // No notice, no filing: compensate and fall back to Unsorted so an
        // automatic workspace write is never invisible to its author.
        console.error(
          "venom auto-file notice failed; reverting workspace filing",
          noticeError,
        );
        await restoreConceptStates(
          workspaceOwner(workspaceId),
          filing.touchedBefore,
          now,
        );
        unsorted.push(...batch);
        continue;
      }
      workspaceFilings.push({
        noticeId,
        workspaceId,
        workspaceName,
        labels,
        filed: filing.filed,
      });
    } catch (error) {
      console.error("venom workspace auto-filing failed", error);
      unsorted.push(...batch);
    }
  }

  // One personal pass covers both confident-personal and Unsorted clusters.
  const personalCandidates: InsightCandidate[] = [
    ...personal,
    ...unsorted.map((candidate) => ({ ...candidate, unsorted: true })),
  ];
  const personalFiled =
    personalCandidates.length > 0
      ? await fileExtractedKnowledge({
          owner: userOwner(input.userId),
          capturedByUserId: input.userId,
          conversation: input.conversation,
          candidates: personalCandidates,
          now,
        })
      : { filed: [] as OntologyConcept[], touchedBefore: [] };

  return {
    filed: personalFiled.filed,
    workspaceFilings,
    personalLabels: personal.map((candidate) => candidate.label),
    unsortedLabels: unsorted.map((candidate) => candidate.label),
  };
}
