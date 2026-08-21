---
name: Post-rebase derived state
description: After any rebase, every derived layer (generated clients, composite dist, db schema, node_modules, running servers) must be re-derived — auto-merge keeps them silently wrong.
---

# Post-rebase derived state

**Rule:** a completed rebase proves only that *source* text merged. Every
derived layer must be re-derived or re-verified before trusting any check:

- **Generated API clients:** regenerate from the merged spec. Auto-merge of
  generated output has produced mangled types (fields literally renamed to
  fragments) with no conflict reported. Never hand-merge or trust replayed
  generated files.
- **Composite lib dist:** dependents typecheck against emitted `.d.ts`;
  rebuild (`tsc -b`, `--force` when in doubt) or "missing property/export"
  errors point at healthy code.
- **Database schema:** missing-column/relation errors from previously-green
  code mean push the schema — each task environment has its own dev db, and
  another task's push never ran here.
- **Installed packages:** a merged-in manifest entry is not installed until
  `pnpm install` runs; module/plugin-resolution failures are not merge bugs.
- **Package-level typecheck of every touched package:** green test suites
  are not enough — a replay once corrupted a route file nothing imported in
  tests, and only that package's own `tsc` exposed it.
- **Running dev servers predate the rebase:** restart workflows before
  trusting e2e or browser signals.

**Why:** each of these has independently masqueraded as a broken merge or
broken code and cost a debugging cycle; one mangled generated client also
cost a completion-review cycle because only the full workspace build caught
it.

**How to apply:** after every rebase round — including a "clean" one with
zero conflicts — regenerate codegen if the spec moved, rebuild libs, push
schema if the db package moved, reinstall if manifests moved, typecheck each
touched package, and restart affected workflows. Late working-tree edits made
between rebase rounds can be silently dropped; re-verify them too.

**Semantic conflicts need no textual conflict.** Two independently-green
tasks can merge into a red main: one task's e2e spec pinned a behavior a
later task deliberately removed (a device-side runner moved server-side),
and since the later task never edited the spec file, the rebase auto-merge
raised nothing. The first task whose completion validation runs the full
suite on combined main eats the failure. When validation fails in a suite
your diff cannot touch: reproduce the one spec in isolation (flake vs
deterministic), then `git log --oneline -- <spec file>` to find both owning
commits, and reconcile the stale spec with the newer design's *stated*
contract (commit message, spec headers, memory notes) rather than guessing —
the failing expectation may be testing behavior that is intentionally gone.
