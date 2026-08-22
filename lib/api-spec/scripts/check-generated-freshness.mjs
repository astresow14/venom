#!/usr/bin/env node
/**
 * Freshness gate for the generated API clients.
 *
 * One spec (lib/api-spec/openapi.yaml) generates two committed client copies:
 *   - lib/api-zod/src/generated
 *   - lib/api-client-react/src/generated
 * A replayed auto-merge (or a skipped regeneration after a spec change) can
 * leave one copy silently stale; nothing fails until some consumer file
 * happens to reference the missing surface. This gate makes drift impossible
 * to miss:
 *
 *   1. Check out the commit under test (HEAD by default) into a disposable
 *      git worktree and re-run the generation pipeline there
 *      (`pnpm --filter ./lib/api-spec run codegen:generate` — the same orval +
 *      hoist steps the developer-facing `codegen` script runs). Regeneration
 *      is byte-stable on a fresh tree, so any resulting diff means the
 *      committed copies do not match the committed spec.
 *   2. Fail if `git status --porcelain` in the worktree reports any change
 *      (modified, deleted, or untracked) under the generated directories.
 *   3. Fail if `git diff --check` (against the empty tree, so every line of
 *      current content is inspected) flags whitespace errors — this enforces
 *      the blank-line-at-EOF tail normalization that the codegen pipeline
 *      applies in scripts/hoist-literal-consts.mjs.
 *
 * Why a worktree: validation suites run in parallel, and regeneration (orval
 * with `clean: true`) deletes and rewrites the generated trees while other
 * suites are bundling the apps that import them. Metro under CI=1 does not
 * watch files, so one bundle built during that window keeps serving an error
 * for the rest of the run. Isolating the regeneration in a checkout of the
 * commit keeps this gate strictly read-only for the real working tree.
 *
 * The worktree borrows the real workspace's node_modules via symlinks (no
 * install step). That is also why the gate runs `codegen:generate` rather
 * than full `codegen`: workspace-package symlinks under the borrowed
 * node_modules realpath back into the real tree, so `typecheck:libs` would
 * compile real-tree sources without their project-reference redirects and
 * report bogus errors. The typecheck tail never changes generated files, so
 * skipping it does not affect the freshness verdict.
 *
 * Set CODEGEN_FRESHNESS_REF to gate a commit other than HEAD.
 *
 * On failure the fix is never hand-editing generated files:
 *   pnpm --filter ./lib/api-spec run codegen   # then commit the result
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));

const GENERATED_DIRS = [
  "lib/api-zod/src/generated",
  "lib/api-client-react/src/generated",
];

/** Hard failure that should abort the gate (still running cleanup). */
class GateError extends Error {}

function run(cmd, args, opts = {}) {
  const res = spawnSync(cmd, args, { encoding: "utf8", ...opts });
  if (res.error) {
    throw new GateError(`failed to spawn ${cmd}: ${res.error.message}`);
  }
  return res;
}

/**
 * pnpm runs package scripts with the cwd set to the package directory, so a
 * path-walking git command issued from here would silently answer for
 * lib/api-spec alone. Every git call must target its repository root (the
 * real one or the worktree) explicitly.
 */
function git(dir, args) {
  return run("git", ["-C", dir, ...args]);
}

/** Workspace package dirs (depth <= 2) that have node_modules to borrow. */
function findNodeModulesDirs(root) {
  const found = [];
  const consider = (rel) => {
    if (fs.existsSync(path.join(root, rel, "node_modules"))) found.push(rel);
  };
  consider(".");
  for (const d1 of fs.readdirSync(root, { withFileTypes: true })) {
    if (!d1.isDirectory() || d1.name === "node_modules" || d1.name.startsWith("."))
      continue;
    consider(d1.name);
    for (const d2 of fs.readdirSync(path.join(root, d1.name), {
      withFileTypes: true,
    })) {
      if (!d2.isDirectory() || d2.name === "node_modules" || d2.name.startsWith("."))
        continue;
      consider(path.join(d1.name, d2.name));
    }
  }
  return found;
}

function main(repoRoot, sha, worktree) {
  const add = git(repoRoot, [
    "worktree",
    "add",
    "--detach",
    "--quiet",
    worktree,
    sha,
  ]);
  if (add.status !== 0) {
    console.error(add.stderr);
    throw new GateError(`could not create a worktree for ${sha}`);
  }

  // Borrow installed dependencies. pnpm's package-level node_modules contain
  // relative symlinks that resolve from their *real* location, so linking the
  // directories themselves keeps resolution identical to the real workspace.
  for (const rel of findNodeModulesDirs(repoRoot)) {
    const wtDir = path.join(worktree, rel);
    if (!fs.existsSync(wtDir)) continue; // package not present at this commit
    fs.symlinkSync(
      path.join(repoRoot, rel, "node_modules"),
      path.join(wtDir, "node_modules"),
      "dir",
    );
  }

  console.log(
    `[codegen-freshness] regenerating API clients from the spec at ${sha.slice(0, 10)} (isolated worktree) ...`,
  );
  // Run directly in the package dir: a filtered `pnpm --filter ... run`
  // treats a missing script as a silent skip (exit 0), which would turn a
  // renamed script into a gate that never regenerates and always passes.
  // A direct `pnpm run` fails hard when the script is absent.
  const codegen = run("pnpm", ["run", "codegen:generate"], {
    cwd: path.join(worktree, "lib", "api-spec"),
    stdio: "inherit",
    encoding: undefined,
  });
  if (codegen.status !== 0) {
    throw new GateError(`codegen failed (exit ${codegen.status})`);
  }

  let exitCode = 0;

  // 1) Freshness: regeneration must not change the checked-out tree.
  const status = git(worktree, [
    "status",
    "--porcelain",
    "--",
    ...GENERATED_DIRS,
  ]);
  if (status.status !== 0) {
    console.error(status.stderr);
    throw new GateError("git status failed in the worktree");
  }
  if (status.stdout.trim() !== "") {
    exitCode = 1;
    console.error("");
    console.error(
      "[codegen-freshness] FAIL: regenerating from the spec changed the generated client trees.",
    );
    console.error(
      `The copies committed at ${sha.slice(0, 10)} are stale relative to lib/api-spec/openapi.yaml:`,
    );
    console.error(status.stdout.trimEnd());
    const stat = git(worktree, ["diff", "--stat", "--", ...GENERATED_DIRS]);
    if (stat.status === 0 && stat.stdout.trim() !== "") {
      console.error("");
      console.error(stat.stdout.trimEnd());
    }
    console.error("");
    console.error(
      "Fix: run `pnpm --filter ./lib/api-spec run codegen` and commit the regenerated output.",
    );
    console.error("Never hand-edit files under the generated directories.");
  }

  // 2) Tail normalization: no whitespace errors (e.g. a blank line at EOF)
  // anywhere in the generated trees. Diffing against the empty tree makes git
  // treat every tracked file as newly added, so --check inspects every line
  // of the current content instead of only uncommitted changes.
  const emptyTreeRes = git(worktree, ["hash-object", "-t", "tree", "/dev/null"]);
  if (emptyTreeRes.status !== 0) {
    console.error(emptyTreeRes.stderr);
    throw new GateError("could not compute the empty tree hash");
  }
  const check = git(worktree, [
    "diff",
    "--check",
    emptyTreeRes.stdout.trim(),
    "--",
    ...GENERATED_DIRS,
  ]);
  if (check.status !== 0) {
    exitCode = 1;
    console.error("");
    console.error(
      "[codegen-freshness] FAIL: whitespace errors in generated output (git diff --check):",
    );
    console.error((check.stdout + check.stderr).trimEnd());
    console.error(
      "The blank-line-at-EOF tail normalization (lib/api-spec/scripts/hoist-literal-consts.mjs) did not hold.",
    );
  }

  return exitCode;
}

// Resolve the repository root from the script's own location, never from the
// ambient cwd.
let exitCode = 1;
let tmpBase = null;
let repoRoot = null;
try {
  const rootRes = run("git", ["-C", scriptDir, "rev-parse", "--show-toplevel"]);
  if (rootRes.status !== 0) {
    console.error(rootRes.stderr);
    throw new GateError("could not resolve the git repository root");
  }
  repoRoot = rootRes.stdout.trim();

  const refName = process.env.CODEGEN_FRESHNESS_REF ?? "HEAD";
  const shaRes = git(repoRoot, [
    "rev-parse",
    "--verify",
    `${refName}^{commit}`,
  ]);
  if (shaRes.status !== 0) {
    console.error(shaRes.stderr);
    throw new GateError(`could not resolve ref "${refName}" to a commit`);
  }
  const sha = shaRes.stdout.trim();

  // Clear any admin records left by a previous crashed run before adding.
  git(repoRoot, ["worktree", "prune"]);

  tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "codegen-freshness-"));
  exitCode = main(repoRoot, sha, path.join(tmpBase, "tree"));
} catch (error) {
  if (error instanceof GateError) {
    console.error(`[codegen-freshness] ${error.message}`);
  } else {
    console.error(error);
  }
  exitCode = 1;
} finally {
  // fs.rmSync does not follow directory symlinks, so the borrowed
  // node_modules links are removed without touching their targets.
  if (tmpBase !== null) fs.rmSync(tmpBase, { recursive: true, force: true });
  if (repoRoot !== null) {
    try {
      git(repoRoot, ["worktree", "prune"]);
    } catch {
      // cleanup is best-effort; the next run prunes again before adding
    }
  }
}

if (exitCode === 0) {
  console.log(
    "[codegen-freshness] OK: generated clients are up to date with the spec and normalized.",
  );
}
process.exit(exitCode);
