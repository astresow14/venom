/**
 * Build the tree the GitHub sync actually publishes.
 *
 * The mirror receives snapshots of the workspace tree, never workspace
 * history. Automatic checkpoints commit whatever sits in the checkout, so the
 * workspace's own history can carry things that must not be published (a
 * credential once landed in `attached_assets/` this way), and rewriting
 * checkpointed history is not safe. Publishing a snapshot means the only
 * content that ever ships is the current tree — which the credential guard can
 * scan in full before anything is pushed.
 *
 * `.github/workflows/` needs special handling: GitHub refuses a push that
 * touches workflow files unless the credential has explicit workflow write
 * access. When no such credential is available, those paths are pinned to the
 * base branch's version so one unwritable directory does not hold every other
 * change hostage. The sync and the drift check both build the same pinned tree
 * through this module, so what gets pushed and what gets judged always agree.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { git, gitRaw } from "./git";

/** Paths GitHub only lets workflow-capable credentials write. */
export const WORKFLOW_PREFIX = ".github/workflows/";

export function isWorkflowPath(path: string): boolean {
  return path.startsWith(WORKFLOW_PREFIX);
}

/** The tree object a revision points at. */
export function treeOf(repoRoot: string, revision: string): string {
  return git(["-C", repoRoot, "rev-parse", `${revision}^{tree}`]);
}

/**
 * Repository-relative paths whose content differs between two revisions.
 *
 * A plain two-dot diff on purpose: snapshots compare tree against tree, and
 * merge-base reasoning would reintroduce the history the sync no longer
 * publishes.
 */
export function pathsDiffering(
  repoRoot: string,
  baseRevision: string,
  headRevision: string,
): string[] {
  return git(["-C", repoRoot, "diff", "--name-only", baseRevision, headRevision])
    .split("\n")
    .filter(Boolean);
}

/**
 * The tree of `headRevision`, with everything under `prefix` reset to its
 * state in `baseRevision`: edits reverted, additions dropped, deletions
 * restored.
 *
 * Built in a throwaway index (`GIT_INDEX_FILE` points at a temp file), so the
 * real index and the working tree are never touched.
 */
export function treeWithPrefixFromBase(
  repoRoot: string,
  headRevision: string,
  baseRevision: string,
  prefix: string,
): string {
  const scratch = mkdtempSync(join(tmpdir(), "venom-sync-index-"));
  const env = { ...process.env, GIT_INDEX_FILE: join(scratch, "index") };

  try {
    git(["-C", repoRoot, "read-tree", headRevision], env);

    const current = gitRaw(["-C", repoRoot, "ls-files", "-z", "--", prefix], undefined, env)
      .toString("utf8")
      .split("\0")
      .filter(Boolean);
    if (current.length > 0) {
      gitRaw(
        ["-C", repoRoot, "update-index", "--force-remove", "-z", "--stdin"],
        `${current.join("\0")}\0`,
        env,
      );
    }

    // `ls-tree -r -z` emits "<mode> <type> <sha>\t<path>" records; feed them to
    // `update-index --index-info` as "<mode> <sha>\t<path>".
    const baseEntries = gitRaw(
      ["-C", repoRoot, "ls-tree", "-r", "-z", baseRevision, "--", prefix],
      undefined,
      env,
    )
      .toString("utf8")
      .split("\0")
      .filter(Boolean)
      .map((entry) => {
        const tab = entry.indexOf("\t");
        const [mode, , sha] = entry.slice(0, tab).split(" ");
        return `${mode} ${sha}\t${entry.slice(tab + 1)}`;
      });
    if (baseEntries.length > 0) {
      gitRaw(
        ["-C", repoRoot, "update-index", "-z", "--index-info"],
        `${baseEntries.join("\0")}\0`,
        env,
      );
    }

    return git(["-C", repoRoot, "write-tree"], env);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}
