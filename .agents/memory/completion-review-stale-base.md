---
name: Completion review stale base
description: What to do when the completion code review rejects a task for "bundling" changes that are actually already-merged sibling tasks.
---

# Completion code review against a stale base

The completion code review can compute its diff from a base recorded before
sibling tasks merged into canonical main. When siblings merge mid-session and
the platform rebases the task environment onto the new main, those merged
commits sit in the branch history and a stale-base review misattributes them
to the current task ("bundles unrelated changes across ...").

**How to recognize:** the review names features this task never touched, yet
`git status` before completion showed only the intended files.

**How to verify:** `git log --oneline main-repl/main..HEAD` and
`git diff --stat main-repl/main..HEAD` — if the only commits/files ahead of
the canonical-main ref are this task's own work, and the flagged changes are
ancestors (`git merge-base --is-ancestor <sha> main-repl/main`), the
rejection is a base artifact, not real scope creep.

**How to fix:** do NOT revert the flagged changes — they are other tasks'
merged work; reverting would regress main. Call `markTaskComplete` again with
`request_fresh_code_review: true` so the review recomputes against the
current base.

**Note:** `git fetch main-repl` prompts for SSH credentials and hangs in this
environment; rely on the local `main-repl/main` ref, which the platform
advances on rebase.
