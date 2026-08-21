/**
 * Turn the observed facts about the GitHub mirror into a verdict.
 *
 * The sync publishes snapshots of the workspace tree, never workspace history,
 * so drift is judged by tree identity: does the mirror's base branch — or,
 * while a sync is in flight, the sync pull request — carry the workspace tree?
 * Commit ancestry is deliberately ignored; local commit ids never appear on
 * the mirror, and counting "missing commits" would report drift forever.
 *
 * Kept free of git and network access so the rules can be unit tested:
 * `check-github-sync.ts` gathers the facts, this module judges them.
 */

import { describeAge, type SyncState } from "./sync-state";

export interface PullRequestFacts {
  number: number;
  url: string;
  headSha: string;
  /**
   * Whether the pull request head's tree is the workspace tree (directly, or
   * with workflow paths pinned to the base). Null when the head commit is not
   * available locally to inspect.
   */
  carriesWorkspaceTree: boolean | null;
  /** GitHub's merge verdict; null while GitHub is still computing it. */
  mergeable: boolean | null;
  mergeableState: string | null;
}

export interface DriftFacts {
  baseBranch: string;
  syncBranch: string;
  headSha: string;
  /** The base branch's tree is exactly the workspace tree. */
  mirrorMatchesTree: boolean;
  /**
   * The base branch differs from the workspace tree only under
   * `.github/workflows/` — the paths the sync pins to the base version while
   * no credential can write workflow files.
   */
  mirrorMatchesExceptWorkflows: boolean;
  /** Workflow files that differ from the base branch. */
  workflowChangesPending: number;
  /** All files that differ between the workspace tree and the base branch. */
  filesDiffering: number;
  syncBranchExists: boolean;
  /** The sync branch tip carries the workspace tree (exact or workflow-pinned). */
  syncBranchCarriesTree: boolean;
  workingTreeDirty: boolean;
  pullRequest: PullRequestFacts | null;
  state: SyncState;
  now: Date;
}

export type DriftLevel = "ok" | "warning" | "drift";

export interface DriftReport {
  level: DriftLevel;
  headline: string;
  findings: string[];
  nextStep: string | null;
}

const SYNC_COMMAND = "pnpm run sync:github";

/** A recorded success this old is worth mentioning even when nothing is missing. */
const STALE_SUCCESS_DAYS = 7;

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

function attemptFindings(facts: DriftFacts): string[] {
  const findings: string[] = [];
  const { lastAttempt, lastSuccess } = facts.state;

  if (!lastAttempt) {
    findings.push(
      `No sync attempt has been recorded yet, so an earlier failure would have left no trace. Run \`${SYNC_COMMAND}\` to start recording.`,
    );
    return findings;
  }

  const age = describeAge(lastAttempt.at, facts.now);

  if (lastAttempt.outcome === "failed") {
    findings.push(
      `The last sync attempt failed ${age}: ${lastAttempt.detail ?? "no reason recorded"}`,
    );
  } else if (lastAttempt.outcome === "skipped") {
    findings.push(
      `The last sync was skipped ${age}: ${lastAttempt.detail ?? "no reason recorded"}`,
    );
  }

  if (!lastSuccess) {
    findings.push("No sync has ever succeeded from this workspace.");
    return findings;
  }

  const successAge = (facts.now.getTime() - Date.parse(lastSuccess.at)) / 86_400_000;
  if (
    lastAttempt.outcome === "success" &&
    Number.isFinite(successAge) &&
    successAge >= STALE_SUCCESS_DAYS
  ) {
    findings.push(
      `The last successful sync was ${describeAge(lastSuccess.at, facts.now)}, so the mirror has not been confirmed recently.`,
    );
  }

  return findings;
}

const SEVERITY: Record<DriftLevel, number> = { ok: 0, warning: 1, drift: 2 };

export function classifyDrift(facts: DriftFacts): DriftReport {
  const findings: string[] = [];
  let severity = SEVERITY.ok;
  const raise = (next: DriftLevel): void => {
    severity = Math.max(severity, SEVERITY[next]);
  };

  const pull = facts.pullRequest;
  const mirrorCurrent = facts.mirrorMatchesTree || facts.mirrorMatchesExceptWorkflows;
  let pullCarriesTree = false;
  let resyncNeeded = false;

  if (mirrorCurrent) {
    if (facts.mirrorMatchesExceptWorkflows) {
      raise("warning");
      findings.push(
        `\`${facts.baseBranch}\` carries the workspace tree except ${plural(facts.workflowChangesPending, "workflow file")} under .github/workflows, which no available credential can write.`,
      );
    }
    if (pull) {
      raise("warning");
      findings.push(
        `Pull request #${pull.number} is still open although \`${facts.baseBranch}\` already carries the workspace tree; it can be closed.`,
      );
    }
  } else if (pull) {
    if (pull.carriesWorkspaceTree === false) {
      raise("drift");
      resyncNeeded = true;
      findings.push(
        `Pull request #${pull.number} is stale: its head ${pull.headSha.slice(0, 8)} does not carry the current workspace tree.`,
      );
    } else if (pull.carriesWorkspaceTree === null) {
      raise("warning");
      resyncNeeded = true;
      findings.push(
        `Pull request #${pull.number} points at ${pull.headSha.slice(0, 8)}, which this checkout cannot inspect, so it may be stale.`,
      );
    } else {
      pullCarriesTree = true;
    }

    if (pull.mergeable === false || pull.mergeableState === "dirty") {
      raise("drift");
      resyncNeeded = true;
      findings.push(
        `Pull request #${pull.number} conflicts with \`${facts.baseBranch}\`; a fresh sync rebuilds the snapshot on the current \`${facts.baseBranch}\` and clears the conflict.`,
      );
    } else if (pull.mergeableState === "blocked") {
      // Waiting on the required checks is the pull request's normal resting
      // state between a sync and a merge, so it is a note, not a problem.
      findings.push(
        `Pull request #${pull.number} is waiting for the required checks before it can merge.`,
      );
    } else if (pull.mergeableState === "clean") {
      findings.push(`Pull request #${pull.number} is ready to merge on GitHub.`);
    } else if (pull.mergeable === null) {
      findings.push(
        `GitHub has not finished computing whether pull request #${pull.number} can merge.`,
      );
    }
  } else {
    raise("drift");
    resyncNeeded = true;
    findings.push(
      facts.syncBranchCarriesTree
        ? `The sync branch \`${facts.syncBranch}\` carries the workspace tree, but no pull request is open to land it on \`${facts.baseBranch}\`.`
        : facts.syncBranchExists
          ? `\`${facts.baseBranch}\` is ${plural(facts.filesDiffering, "file")} behind the workspace tree and the sync branch does not carry it either.`
          : `\`${facts.baseBranch}\` is ${plural(facts.filesDiffering, "file")} behind the workspace tree and the sync branch \`${facts.syncBranch}\` does not exist on GitHub.`,
    );
  }

  if (facts.workingTreeDirty) {
    raise("warning");
    findings.push("The working tree has uncommitted changes, which the sync refuses to push.");
  }

  for (const finding of attemptFindings(facts)) {
    raise(finding.startsWith("The last sync attempt failed") ? "drift" : "warning");
    findings.push(finding);
  }

  const level: DriftLevel =
    severity >= SEVERITY.drift ? "drift" : severity >= SEVERITY.warning ? "warning" : "ok";

  const headline =
    level === "drift"
      ? `DRIFT: GitHub \`${facts.baseBranch}\` does not carry the workspace tree.`
      : level === "warning"
        ? "WARNING: the GitHub mirror needs attention."
        : facts.mirrorMatchesTree
          ? `OK: GitHub \`${facts.baseBranch}\` matches the workspace tree.`
          : "OK: the sync pull request is carrying the workspace tree.";

  const onlyWorkflowsPending =
    facts.mirrorMatchesExceptWorkflows && level === "warning" && !facts.workingTreeDirty;

  const nextStep =
    level === "ok"
      ? null
      : facts.workingTreeDirty
        ? `Commit or stash the local changes, then run \`${SYNC_COMMAND}\`.`
        : resyncNeeded
          ? `Run \`${SYNC_COMMAND}\` to refresh the mirror.`
          : onlyWorkflowsPending
            ? `Configure a workflow-capable credential (see replit.md), then run \`${SYNC_COMMAND}\` to publish the held-back workflow files.`
            : !mirrorCurrent && pullCarriesTree
              ? `Merge the sync pull request on GitHub once its required checks pass.`
              : `Run \`${SYNC_COMMAND}\` to refresh the mirror.`;

  return { level, headline, findings, nextStep };
}
