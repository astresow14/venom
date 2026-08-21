/**
 * Sync this Replit checkout to the GitHub mirror as a pull request.
 *
 * The branch ruleset on `main` has no bypass actors, so nothing may be pushed
 * straight to `main`. This script publishes the checkout as a *snapshot
 * commit* — the current tree parented on the mirror's `main` — force-pushes it
 * to a sync branch, and opens (or refreshes) a pull request against the
 * default branch.
 *
 * The mirror receives tree snapshots, never workspace history:
 *
 *  - Workspace history is not publishable. Automatic checkpoints commit
 *    whatever sits in the checkout, and once something credential-shaped lands
 *    in a commit it stays reachable from HEAD forever; rewriting checkpointed
 *    history is not safe here. A snapshot ships the current tree and nothing
 *    else, so the credential guard scans exactly what will be published, and a
 *    poisoned commit deep in history can never wedge the mirror.
 *  - The pull request can always merge: its head is built on the mirror's own
 *    `main`, so mirror-side commits (CI proofs and the like) never leave the
 *    sync branch conflicting. Each sync rebuilds the snapshot on the current
 *    base.
 *
 * When the diff touches `.github/workflows/` and no credential can write
 * workflow files, those paths stay at the base branch's version for this run —
 * reported loudly and recorded — while everything else still ships. The
 * workflow changes follow on the first sync after a workflow-capable
 * credential is configured. A diff that touches *only* workflow files still
 * fails, because then there would be nothing to sync at all.
 *
 * Credentials are resolved by `lib/github`, which prefers the self-refreshing
 * Replit GitHub connector and switches to a workflow-capable credential (a
 * GitHub App installation token, or `GITHUB_TOKEN`) when the push carries a
 * change under `.github/workflows/`, so CI changes need no hand-pasted token.
 * Tokens are held in memory only: they are passed to git through
 * `GIT_CONFIG_COUNT` + `http.extraheader`, never written to `.git/config`, never
 * placed in a remote URL, and redacted from any output this script prints.
 *
 * Every run records its outcome (success, failure, or skip) so a sync that
 * quietly failed in a post-merge log is still visible later through
 * `pnpm run check:github-sync`.
 *
 * Usage:
 *   pnpm run sync:github                 open/refresh the pull request
 *   pnpm run sync:github -- --dry-run    report what would be pushed
 *   pnpm run sync:github -- --record-skip  record that this run was skipped
 *   pnpm run sync:github -- --branch my-sync --title "..." --body "..."
 */

import {
  credentialRefusalMessage,
  dedupeFindings,
  scanForCredentialFiles,
} from "./lib/credential-guard";
import { git, gitEnvWithToken, SyncError } from "./lib/git";
import {
  CredentialPool,
  describeCredential,
  github,
  redact,
  warnIfExpiring,
  workflowSetupHelp,
} from "./lib/github";
import {
  isWorkflowPath,
  pathsDiffering,
  treeOf,
  treeWithPrefixFromBase,
  WORKFLOW_PREFIX,
} from "./lib/publish-tree";
import {
  firstLine,
  recordSyncAttempt,
  stateFilePath,
  type SyncAttempt,
  type SyncOutcome,
} from "./lib/sync-state";

const DEFAULT_REPO = "astresow14/venom";
const DEFAULT_BRANCH = "replit-sync";

/**
 * The identity on snapshot commits. Fixed, so a snapshot never depends on
 * whoever happens to have configured git in this container.
 */
const SNAPSHOT_IDENTITY = {
  GIT_AUTHOR_NAME: "Replit Workspace Sync",
  GIT_AUTHOR_EMAIL: "replit-workspace-sync@users.noreply.github.com",
  GIT_COMMITTER_NAME: "Replit Workspace Sync",
  GIT_COMMITTER_EMAIL: "replit-workspace-sync@users.noreply.github.com",
};

interface Options {
  repo: string;
  branch: string;
  title: string | null;
  body: string | null;
  dryRun: boolean;
  recordSkip: boolean;
}

function parseArgs(argv: string[]): Options {
  const options: Options = {
    repo: process.env.VENOM_GITHUB_REPO?.trim() || DEFAULT_REPO,
    branch: process.env.VENOM_GITHUB_SYNC_BRANCH?.trim() || DEFAULT_BRANCH,
    title: null,
    body: null,
    dryRun: false,
    recordSkip: false,
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
      case "--dry-run":
        options.dryRun = true;
        break;
      case "--record-skip":
        options.recordSkip = true;
        break;
      case "--repo":
        options.repo = readValue();
        break;
      case "--branch":
        options.branch = readValue();
        break;
      case "--title":
        options.title = readValue();
        break;
      case "--body":
        options.body = readValue();
        break;
      case "--help":
      case "-h":
        console.log(
          [
            "Usage: pnpm run sync:github [-- options]",
            "",
            "  --branch <name>  sync branch to push (default: " +
              DEFAULT_BRANCH +
              ")",
            "  --repo <o/n>     target repository (default: " +
              DEFAULT_REPO +
              ")",
            "  --title <text>   pull request title (new pull requests only)",
            "  --body <text>    pull request body override",
            "  --dry-run        report what would be pushed, change nothing",
            "  --record-skip    record a skipped sync and exit, contacting nothing",
          ].join("\n"),
        );
        process.exit(0);
        break;
      default:
        throw new SyncError(`Unknown argument: ${arg}`);
    }
  }

  if (!/^[^/\s]+\/[^/\s]+$/.test(options.repo)) {
    throw new SyncError(
      `--repo must look like "owner/name", got "${options.repo}"`,
    );
  }

  return options;
}

/** What the run knows so far, so a failure can still be recorded usefully. */
interface Progress {
  repo: string;
  branch: string;
  headSha: string | null;
  pullRequest: { number: number; url: string } | null;
}

function record(
  progress: Progress,
  outcome: SyncOutcome,
  detail: string,
): void {
  const attempt: SyncAttempt = {
    at: new Date().toISOString(),
    outcome,
    repo: progress.repo,
    branch: progress.branch,
    headSha: progress.headSha,
    detail: firstLine(redact(detail)),
    pullRequest: progress.pullRequest,
  };

  let repoRoot: string;
  try {
    repoRoot = git(["rev-parse", "--show-toplevel"]);
  } catch {
    return;
  }

  recordSyncAttempt(stateFilePath(repoRoot), attempt);
}

const progress: Progress = {
  repo: DEFAULT_REPO,
  branch: DEFAULT_BRANCH,
  headSha: null,
  pullRequest: null,
};

/**
 * Stop the sync when anything it would publish is key material.
 *
 * The push publishes a snapshot of the current tree — never workspace
 * history — so this scan covers exactly what ships: every tracked file, by
 * name and by leading bytes. A key that was committed and deleted again lives
 * only in local history, which no longer travels; `scanHistoryForCredentials`
 * stays available in `lib/credential-guard` for any routine that ever
 * publishes real history.
 *
 * The scan reads the checkout, so it only speaks for the push while the
 * checkout is exactly HEAD — the caller refuses dirty trees first.
 *
 * `ls-files` is scoped to the working directory, and pnpm runs this script from
 * `scripts/`, so git has to be pointed at the repository root explicitly or the
 * scan silently covers one package instead of the tree being pushed.
 */
function refuseCredentialFiles(repoRoot: string): void {
  const tracked = git(["-C", repoRoot, "ls-files", "-z"]).split("\0").filter(Boolean);

  const findings = dedupeFindings(scanForCredentialFiles(repoRoot, tracked));

  if (findings.length > 0) {
    throw new SyncError(credentialRefusalMessage(findings));
  }

  console.log(`Scanned:     ${tracked.length} tracked file(s) for key material`);
}

/** The pull request body, kept accurate across refreshes. */
function pullRequestBody(
  baseBranch: string,
  headSha: string,
  snapshotSha: string,
  publishedCount: number,
  heldBack: string[],
): string {
  return [
    "Automated snapshot sync of the Replit workspace.",
    "",
    `Workspace commit: \`${headSha}\``,
    `Snapshot commit: \`${snapshotSha}\` (the workspace tree rebuilt on \`${baseBranch}\`)`,
    `Files changed versus \`${baseBranch}\`: ${publishedCount}`,
    ...(heldBack.length > 0
      ? [
          "",
          "Held back at the base version pending a workflow-capable credential:",
          ...heldBack.map((path) => `- \`${path}\``),
        ]
      : []),
    "",
    "Opened by `pnpm run sync:github`.",
  ].join("\n");
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  progress.repo = options.repo;
  progress.branch = options.branch;
  try {
    // Read HEAD up front so a failure recorded later still names the commit
    // that never reached GitHub.
    progress.headSha = git(["rev-parse", "HEAD"]);
  } catch {
    // A missing HEAD is recorded as null; the attempt itself still matters.
  }

  if (options.recordSkip) {
    const reason =
      process.env.VENOM_GITHUB_SYNC_SKIP_REASON?.trim() ||
      "VENOM_SKIP_GITHUB_SYNC=1 was set for this run.";
    record(progress, "skipped", reason);
    console.log(`Recorded a skipped GitHub sync: ${reason}`);
    console.log(
      "Run `pnpm run check:github-sync` to see whether the mirror has fallen behind.",
    );
    return;
  }

  const repoRoot = git(["rev-parse", "--show-toplevel"]);

  const dirty = git(["status", "--porcelain"]);
  if (dirty) {
    throw new SyncError(
      [
        "The working tree has uncommitted changes, so there is nothing stable to sync.",
        "Commit (or stash) them first, then run the sync again:",
        dirty
          .split("\n")
          .map((line) => `  ${line}`)
          .join("\n"),
      ].join("\n"),
    );
  }

  // Refuse before anything is fetched or pushed: a key that reaches the
  // mirror has to be regenerated at the provider, so stopping early is the
  // only remedy that still works.
  refuseCredentialFiles(repoRoot);

  const credentials = new CredentialPool(options.repo);
  const credential = await credentials.base();
  const authEnv = gitEnvWithToken(credential.token);
  const remoteUrl = `https://github.com/${options.repo}.git`;

  console.log(`Repository:  ${options.repo}`);
  console.log(`Credential:  ${describeCredential(credential)}`);
  warnIfExpiring(credential);

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
  git(
    ["fetch", "--no-tags", "--force", remoteUrl, `${baseBranch}:${baseRef}`],
    authEnv,
  );

  const headSha = git(["rev-parse", "HEAD"]);
  progress.headSha = headSha;
  const baseSha = git(["rev-parse", baseRef]);

  console.log(`Base:        ${baseBranch} @ ${baseSha.slice(0, 8)}`);
  console.log(`Local HEAD:  ${headSha.slice(0, 8)}`);

  const changedPaths = pathsDiffering(repoRoot, baseRef, headSha);
  if (changedPaths.length === 0) {
    console.log(
      `\nThe mirror's ${baseBranch} already matches the workspace tree. Nothing to sync.`,
    );
    record(
      progress,
      "success",
      `Mirror ${baseBranch} already matched the workspace tree (${headSha.slice(0, 8)}).`,
    );
    return;
  }
  console.log(`Changes:     ${changedPaths.length} file(s) versus ${baseBranch}`);

  // A credential without workflow write access has its push rejected outright
  // when the pushed tree changes .github/workflows, so either find a credential
  // that can write them, or pin those paths to the base version and say so.
  const workflowPaths = changedPaths.filter(isWorkflowPath);
  let pushCredential = credential;
  let heldBack: string[] = [];
  if (workflowPaths.length > 0) {
    console.log(`Workflows:   ${workflowPaths.length} file(s) changed`);
    try {
      pushCredential = await credentials.forWorkflows(credential, workflowPaths);
      if (pushCredential !== credential) {
        console.log(
          `Pushing as:  ${describeCredential(pushCredential)} (writes .github/workflows)`,
        );
      }
      warnIfExpiring(pushCredential);
    } catch (error) {
      if (!(error instanceof SyncError)) {
        throw error;
      }
      if (workflowPaths.length === changedPaths.length) {
        // Everything that differs is a workflow file; holding them all back
        // would leave nothing to sync, so this run has genuinely failed.
        throw error;
      }
      heldBack = workflowPaths;
      console.log(
        [
          "",
          `Held back:   ${workflowPaths.length} workflow file(s) stay at the ${baseBranch} version — no available credential can write .github/workflows:`,
          ...workflowPaths.map((path) => `  ${path}`),
          "They sync automatically once a workflow-capable credential is configured (see replit.md).",
          "",
        ].join("\n"),
      );
    }
  }

  const treeSha =
    heldBack.length > 0
      ? treeWithPrefixFromBase(repoRoot, headSha, baseRef, WORKFLOW_PREFIX)
      : treeOf(repoRoot, headSha);
  const publishedCount = changedPaths.length - heldBack.length;

  if (options.dryRun) {
    console.log(
      `\nDry run: would publish the workspace tree (${publishedCount} changed file(s)${heldBack.length > 0 ? `, ${heldBack.length} workflow file(s) held back` : ""}) as a snapshot on ${baseBranch} @ ${baseSha.slice(0, 8)}, force-push it to ${options.branch}, and open or refresh the pull request.`,
    );
    return;
  }

  const subject = git(["log", "-1", "--pretty=%s"]);
  const snapshotSha = git(
    [
      "-C",
      repoRoot,
      "commit-tree",
      "-p",
      baseSha,
      "-m",
      `Sync Replit workspace: ${subject}`,
      "-m",
      [
        `Snapshot of the Replit workspace tree at commit ${headSha}.`,
        `Files changed versus ${baseBranch}: ${publishedCount}.`,
        ...(heldBack.length > 0
          ? [
              `Held back at the ${baseBranch} version pending a workflow-capable credential: ${heldBack.join(", ")}.`,
            ]
          : []),
      ].join("\n"),
      treeSha,
    ],
    { ...process.env, ...SNAPSHOT_IDENTITY },
  );

  try {
    git(
      ["push", "--force", remoteUrl, `${snapshotSha}:refs/heads/${options.branch}`],
      pushCredential === credential
        ? authEnv
        : gitEnvWithToken(pushCredential.token),
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // GitHub only reveals a missing workflow permission at push time for
    // fine-grained tokens, which report no scopes to inspect beforehand.
    if (workflowPaths.length > 0 && /workflow/i.test(message)) {
      throw new SyncError(
        [
          message,
          "",
          `GitHub refused the push: ${describeCredential(pushCredential)} cannot write .github/workflows.`,
          "",
          ...workflowSetupHelp(options.repo),
        ].join("\n"),
      );
    }
    throw error;
  }
  console.log(
    `Pushed:      snapshot ${snapshotSha.slice(0, 8)} (workspace ${headSha.slice(0, 8)}) -> ${options.branch}`,
  );

  const body =
    options.body ??
    pullRequestBody(baseBranch, headSha, snapshotSha, publishedCount, heldBack);

  const [owner] = options.repo.split("/");
  const existing = await github<Array<{ number: number; html_url: string }>>(
    `/repos/${options.repo}/pulls?state=open&base=${encodeURIComponent(baseBranch)}&head=${encodeURIComponent(`${owner}:${options.branch}`)}`,
    credential.token,
  );

  if (existing.status !== 200) {
    throw new SyncError(
      `Could not list pull requests (HTTP ${existing.status}).`,
    );
  }

  let pullNumber: number;
  let pullUrl: string;

  if (existing.data.length > 0) {
    pullNumber = existing.data[0].number;
    pullUrl = existing.data[0].html_url;

    // Keep the body accurate across refreshes; a stale "workspace commit"
    // line would misreport what the mirror is about to merge.
    const updated = await github<{ message?: string }>(
      `/repos/${options.repo}/pulls/${pullNumber}`,
      credential.token,
      { method: "PATCH", body: { body } },
    );
    if (updated.status !== 200) {
      console.log(
        `Note: could not refresh the pull request body (HTTP ${updated.status}); the diff itself is current.`,
      );
    }
    console.log(`Updated:     pull request #${pullNumber}`);
  } else {
    const created = await github<{
      number?: number;
      html_url?: string;
      message?: string;
    }>(`/repos/${options.repo}/pulls`, credential.token, {
      method: "POST",
      body: {
        title: options.title ?? `Sync Replit workspace: ${subject}`,
        head: options.branch,
        base: baseBranch,
        body,
      },
    });

    if (
      created.status !== 201 ||
      !created.data.number ||
      !created.data.html_url
    ) {
      throw new SyncError(
        `Could not open a pull request (HTTP ${created.status}): ${created.data.message ?? "unknown error"}`,
      );
    }

    pullNumber = created.data.number;
    pullUrl = created.data.html_url;
    console.log(`Opened:      pull request #${pullNumber}`);
  }

  progress.pullRequest = { number: pullNumber, url: pullUrl };

  const detail = await github<{ mergeable_state?: string }>(
    `/repos/${options.repo}/pulls/${pullNumber}`,
    credential.token,
  );

  console.log(`\nPull request: ${pullUrl}`);
  if (detail.data.mergeable_state) {
    console.log(`Merge state:  ${detail.data.mergeable_state}`);
  }
  console.log(
    `Merge it on GitHub once the required checks report success; main refuses direct pushes by design.`,
  );

  record(
    progress,
    "success",
    `Pushed snapshot ${snapshotSha.slice(0, 8)} of workspace ${headSha.slice(0, 8)} to ${options.branch} (pull request #${pullNumber}${detail.data.mergeable_state ? `, ${detail.data.mergeable_state}` : ""}${heldBack.length > 0 ? `; ${heldBack.length} workflow file(s) held back` : ""}).`,
  );
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  record(progress, "failed", message);
  console.error(`\nSync failed.\n${redact(message)}`);
  console.error(
    "Recorded the failure. Run `pnpm run check:github-sync` at any time to see whether GitHub is behind.",
  );
  process.exitCode = 1;
});
