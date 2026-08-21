/**
 * Report whether the GitHub mirror still carries this workspace's tree.
 *
 * The post-merge hook never fails setup over a sync problem, so a disconnected
 * connector, a network hiccup, or a stale sync pull request can leave the
 * mirror quietly behind. This command makes that visible after the fact: it
 * reads the recorded last-sync marker and compares the local tree against
 * GitHub.
 *
 * The sync publishes tree snapshots rather than workspace history, so the
 * comparison here is tree identity, not commit ancestry: local commit ids
 * never appear on the mirror. Workflow paths the sync may have pinned to the
 * base version (see `lib/publish-tree`) are judged the same way the sync
 * builds them, so the two commands always agree on what "current" means.
 *
 * Like the sync itself, it authenticates through the Replit GitHub connector,
 * so no personal access token is pasted or stored.
 *
 * Usage:
 *   pnpm run check:github-sync              report drift, exit 1 when it exists
 *   pnpm run check:github-sync -- --quiet   only print when something is wrong
 *
 * Exit codes: 0 in sync, 1 drift or warning, 2 the check itself could not run.
 */

import { git, gitEnvWithToken, gitStatus, SyncError } from "./lib/git";
import {
  github,
  redact,
  resolveCredential,
  type Credential,
} from "./lib/github";
import {
  isWorkflowPath,
  pathsDiffering,
  treeOf,
  treeWithPrefixFromBase,
  WORKFLOW_PREFIX,
} from "./lib/publish-tree";
import { classifyDrift, type PullRequestFacts } from "./lib/sync-drift";
import {
  describeAge,
  readSyncState,
  stateFilePath,
  type SyncState,
} from "./lib/sync-state";

const DEFAULT_REPO = "astresow14/venom";
const DEFAULT_BRANCH = "replit-sync";

interface Options {
  repo: string;
  branch: string;
  quiet: boolean;
}

function parseArgs(argv: string[]): Options {
  const options: Options = {
    repo: process.env.VENOM_GITHUB_REPO?.trim() || DEFAULT_REPO,
    branch: process.env.VENOM_GITHUB_SYNC_BRANCH?.trim() || DEFAULT_BRANCH,
    quiet: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const readValue = (): string => {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new SyncError(`Missing value for ${arg}`);
      }
      index += 1;
      return value;
    };

    switch (arg) {
      // pnpm forwards its own separator when flags are passed through `--`.
      case "--":
        break;
      case "--quiet":
        options.quiet = true;
        break;
      case "--repo":
        options.repo = readValue();
        break;
      case "--branch":
        options.branch = readValue();
        break;
      case "--help":
      case "-h":
        console.log(
          [
            "Usage: pnpm run check:github-sync [-- options]",
            "",
            "  --branch <name>  sync branch to inspect (default: " +
              DEFAULT_BRANCH +
              ")",
            "  --repo <o/n>     target repository (default: " +
              DEFAULT_REPO +
              ")",
            "  --quiet          print nothing when the mirror is up to date",
          ].join("\n"),
        );
        process.exit(0);
        break;
      default:
        throw new SyncError(`Unknown argument: ${arg}`);
    }
  }

  return options;
}

/** What the marker alone can say, for when GitHub cannot be reached. */
function printRecordedHistory(state: SyncState, now: Date): void {
  if (!state.lastAttempt) {
    console.log("Last attempt: none recorded");
  } else {
    const attempt = state.lastAttempt;
    console.log(
      `Last attempt: ${attempt.outcome} ${describeAge(attempt.at, now)}${attempt.detail ? ` — ${attempt.detail}` : ""}`,
    );
  }

  if (!state.lastSuccess) {
    console.log("Last success: never");
  } else {
    const success = state.lastSuccess;
    const sha = success.headSha ? ` (${success.headSha.slice(0, 8)})` : "";
    const pull = success.pullRequest
      ? ` -> pull request #${success.pullRequest.number}`
      : "";
    console.log(`Last success: ${describeAge(success.at, now)}${sha}${pull}`);
  }
}

async function pullRequestFacts(
  credential: Credential,
  repo: string,
  branch: string,
  baseBranch: string,
  trees: { repoRoot: string; workspaceTree: string; publishableTree: string },
): Promise<PullRequestFacts | null> {
  const [owner] = repo.split("/");
  const open = await github<Array<{ number: number; html_url: string }>>(
    `/repos/${repo}/pulls?state=open&base=${encodeURIComponent(baseBranch)}&head=${encodeURIComponent(`${owner}:${branch}`)}`,
    credential.token,
  );

  if (open.status !== 200) {
    throw new SyncError(`Could not list pull requests (HTTP ${open.status}).`);
  }
  if (open.data.length === 0) {
    return null;
  }

  const number = open.data[0].number;
  const detail = await github<{
    html_url?: string;
    head?: { sha?: string };
    mergeable?: boolean | null;
    mergeable_state?: string;
  }>(`/repos/${repo}/pulls/${number}`, credential.token);

  if (detail.status !== 200) {
    throw new SyncError(
      `Could not read pull request #${number} (HTTP ${detail.status}).`,
    );
  }

  const pullHead = detail.data.head?.sha ?? "";
  let carriesWorkspaceTree: boolean | null = null;
  if (
    pullHead &&
    gitStatus(["cat-file", "-e", `${pullHead}^{commit}`]) === 0
  ) {
    const pullTree = treeOf(trees.repoRoot, pullHead);
    carriesWorkspaceTree =
      pullTree === trees.workspaceTree || pullTree === trees.publishableTree;
  }

  return {
    number,
    url: detail.data.html_url ?? open.data[0].html_url,
    headSha: pullHead,
    carriesWorkspaceTree,
    mergeable: detail.data.mergeable ?? null,
    mergeableState: detail.data.mergeable_state ?? null,
  };
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const now = new Date();
  const repoRoot = git(["rev-parse", "--show-toplevel"]);
  const state = readSyncState(stateFilePath(repoRoot));

  const report = (lines: string[]): void => {
    for (const line of lines) {
      console.log(line);
    }
  };

  let credential: Credential;
  try {
    credential = await resolveCredential(options.repo);
  } catch (error: unknown) {
    // Without a credential the live comparison is impossible, but the marker
    // still says whether the mirror was ever confirmed current.
    console.log("GitHub sync check");
    printRecordedHistory(state, now);
    console.log("");
    console.log(
      `WARNING: cannot reach GitHub to compare.\n${redact(error instanceof Error ? error.message : String(error))}`,
    );
    process.exitCode = 1;
    return;
  }

  const authEnv = gitEnvWithToken(credential.token);
  const remoteUrl = `https://github.com/${options.repo}.git`;

  const repository = await github<{
    default_branch?: string;
    message?: string;
  }>(`/repos/${options.repo}`, credential.token);
  if (repository.status !== 200 || !repository.data.default_branch) {
    throw new SyncError(
      `Cannot read ${options.repo} (HTTP ${repository.status}): ${repository.data.message ?? "unknown error"}`,
    );
  }
  const baseBranch = repository.data.default_branch;

  const baseRef = `refs/venom-sync/${baseBranch}`;
  const syncRef = `refs/venom-sync/${options.branch}`;
  git(
    ["fetch", "--no-tags", "--force", remoteUrl, `${baseBranch}:${baseRef}`],
    authEnv,
  );
  const syncBranchExists =
    gitStatus(
      [
        "fetch",
        "--no-tags",
        "--force",
        remoteUrl,
        `${options.branch}:${syncRef}`,
      ],
      authEnv,
    ) === 0;

  const headSha = git(["rev-parse", "HEAD"]);
  const baseSha = git(["rev-parse", baseRef]);

  const workspaceTree = treeOf(repoRoot, headSha);
  const baseTree = treeOf(repoRoot, baseRef);
  const differing = pathsDiffering(repoRoot, baseRef, headSha);
  const workflowChanges = differing.filter(isWorkflowPath);
  // The tree the sync would publish if no credential can write workflows:
  // workflow paths pinned to the base version. Identical to the workspace
  // tree when no workflow file differs.
  const publishableTree =
    workflowChanges.length > 0
      ? treeWithPrefixFromBase(repoRoot, headSha, baseRef, WORKFLOW_PREFIX)
      : workspaceTree;

  const mirrorMatchesTree = baseTree === workspaceTree;
  const mirrorMatchesExceptWorkflows =
    !mirrorMatchesTree && baseTree === publishableTree;

  const syncTree = syncBranchExists ? treeOf(repoRoot, syncRef) : null;
  const syncBranchCarriesTree =
    syncTree !== null &&
    (syncTree === workspaceTree || syncTree === publishableTree);

  const pullRequest = await pullRequestFacts(
    credential,
    options.repo,
    options.branch,
    baseBranch,
    { repoRoot, workspaceTree, publishableTree },
  );

  const verdict = classifyDrift({
    baseBranch,
    syncBranch: options.branch,
    headSha,
    mirrorMatchesTree,
    mirrorMatchesExceptWorkflows,
    workflowChangesPending: workflowChanges.length,
    filesDiffering: differing.length,
    syncBranchExists,
    syncBranchCarriesTree,
    workingTreeDirty: git(["status", "--porcelain"]).length > 0,
    pullRequest,
    state,
    now,
  });

  if (options.quiet && verdict.level === "ok") {
    return;
  }

  const mirrorLine = mirrorMatchesTree
    ? "matches the workspace tree"
    : mirrorMatchesExceptWorkflows
      ? `matches the workspace tree except ${workflowChanges.length} held-back workflow file(s)`
      : `${differing.length} file(s) differ from the workspace tree`;

  report([
    "GitHub sync check",
    `Repository:   ${options.repo}`,
    `Credential:   ${credential.source}`,
  ]);
  printRecordedHistory(state, now);
  report([
    "",
    `Local HEAD:   ${headSha.slice(0, 8)}`,
    `Mirror ${baseBranch}:  @ ${baseSha.slice(0, 8)} — ${mirrorLine}`,
    `Sync branch:  ${options.branch} ${
      syncBranchExists
        ? `@ ${git(["rev-parse", syncRef]).slice(0, 8)} — ${syncBranchCarriesTree ? "carries the workspace tree" : "does not carry the workspace tree"}`
        : "(missing on GitHub)"
    }`,
    pullRequest
      ? `Pull request: #${pullRequest.number} ${pullRequest.url} (merge state: ${pullRequest.mergeableState ?? "unknown"})`
      : "Pull request: none open",
    "",
    verdict.headline,
    ...verdict.findings.map((finding) => `  - ${finding}`),
    ...(verdict.nextStep ? ["", verdict.nextStep] : []),
  ]);

  if (verdict.level !== "ok") {
    process.exitCode = 1;
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`\nGitHub sync check could not run.\n${redact(message)}`);
  process.exitCode = 2;
});
