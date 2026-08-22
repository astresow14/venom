---
name: Validation parallelism vs file-writing gates
description: Why a validation command must never rewrite files other suites read, and the pnpm filtered-run silent-skip trap.
---

# Validation parallelism vs file-writing gates

Completion validation runs all registered commands **concurrently**. A gate that rewrites files
other suites consume — e.g. regenerating the API clients in place while Metro/Vite bundle the apps
that import them — races their builds. Orval's `clean: true` even deletes the whole generated tree
before rewriting it, so there is a window where imports simply don't exist.

**Why:** the venom web suite's bundle warm-up failed an entire validation run with a persistent
HTTP 500: the freshness gate's in-place codegen ran concurrently, Metro built the entry bundle
during the rewrite window, and Metro under `CI=1` does not watch files — one poisoned build kept
serving the same error for every warm-up retry until the deadline. Idle reproduction was green,
which is the tell for this class of flake.

**How to apply:**
- A validation gate must be strictly read-only for the real working tree. If it needs to run a
  generator/build to compare outputs, isolate it in a disposable `git worktree` of the commit under
  test and diff there (`git -C <worktree> status --porcelain`). Borrow the real workspace's
  node_modules via directory symlinks — pnpm's package-level links are relative and resolve from
  their real location, so resolution matches the real workspace with no install step.
- Limits of borrowed node_modules: workspace-package symlinks realpath back into the **real** tree,
  so `tsc --build` in the worktree loses project-reference redirects and reports bogus errors
  (missing DOM lib names). Keep typecheck out of worktree gates; run only the generation steps.
- `pnpm --filter <pkg> run <script>` treats a missing script as a **silent skip (exit 0)** — a
  renamed script turns a filtered gate into one that never runs and always passes. Spawn
  `pnpm run <script>` with cwd inside the package instead; that fails hard when the script is absent.
- `process.exit()` inside `try` skips `finally` — worktree/tempdir cleanup must not rely on it;
  return exit codes outward and `process.exit` only after cleanup.
