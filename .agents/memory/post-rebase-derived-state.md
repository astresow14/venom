---
name: Post-rebase derived state
description: After any rebase, every derived layer (generated clients, composite dist, db schema, node_modules, running servers) must be re-derived — auto-merge keeps them silently wrong.
---

# Post-rebase derived state

**Rule:** a completed rebase proves only that *source* text merged. Every
derived layer must be re-derived or re-verified before trusting any check:

- **Generated API clients:** regenerate from the merged spec. Auto-merge of
  generated output has produced mangled types with no conflict reported.
  Never hand-merge or trust replayed generated files.
- **Composite lib dist:** dependents typecheck against emitted `.d.ts`;
  rebuild (`tsc -b`, `--force` when in doubt) or "missing property/export"
  errors point at healthy code. Rebuild the references of *every* package
  that has a typecheck script, not only the packages the diff touched — a
  sibling merge can leave another app's dists stale, which fabricates
  "pre-existing" type errors that vanish once rebuilt.
- **Database schema:** missing-column/relation errors from previously-green
  code mean push the schema — each task environment has its own dev db, and
  a sibling task's push never ran here.
- **Installed packages:** a merged-in manifest entry is not installed until
  `pnpm install` runs; module-resolution failures are not merge bugs.
- **Package-level typecheck of every touched package:** green test suites
  are not enough — a merge once corrupted a route file nothing imported in
  tests, and only that package's own `tsc` exposed it.
- **Running dev servers predate the rebase:** restart workflows before
  trusting e2e or browser signals.

**Why:** each of these has independently masqueraded as a broken merge or
broken code and cost a debugging cycle.

**Semantic conflicts need no textual conflict.** Two independently-green
branches can merge into a red result: one branch's test pinned a behavior
the other deliberately removed, and because neither edited the same file,
the merge raised nothing. When a suite your diff cannot touch fails,
reproduce that one spec in isolation, find both owning commits
(`git log --oneline -- <spec file>`), and reconcile the stale expectation
with the newer design's stated contract instead of debugging your own diff.

**How to apply:** after every rebase round — including a "clean" one with
zero conflicts — regenerate codegen if the spec moved, rebuild libs, push
schema if the db package moved, reinstall if manifests moved, typecheck
each touched package, and restart affected workflows. Sibling-task merges
arrive as quiet mid-session task-status notices; treat any such notice as
"a rebase just happened" and re-run this checklist — a previously green
local run says nothing about the post-merge tree.

**Stale-dist signature at completion validation:** when the quiet rebase
lands right before `markTaskComplete`, the first symptom can be the
validation run itself failing across several unrelated suites at once while
each passed standalone minutes earlier. Tells: unit test files failing
*whole* at `file:1:1` (module-level import crash on a lib export that only
exists in rebuilt dist) and browser suites dying on vite
`Failed to fetch dynamically imported module …?t=` module invalidation.
Fix is the checklist above (`pnpm install` + root `tsc --build --force`),
not debugging your own diff or the failing specs.

**Missing-schema signature:** a skipped push does not always fail loudly.
Routes that swallow errors print caught-error noise with Postgres
`routine: 'parserOpenTable'` (= relation does not exist, 42P01) while their
tests still pass, and a route that 500s can surface as a silent suite HANG
when a test's cleanup deadlocks on the failure (see
sse-test-stream-cleanup.md). Grep suite logs for `parserOpenTable`/42P01
after any merge that touched lib/db; the push here is
`cd lib/db && pnpm run push`.

**Hang mode:** a missing new table (Postgres 42P01) in api-server
integration suites can hang the whole validation run rather than fail fast —
the process never exits (fail-closed gates/pools), so the run dies only at
the ~30-min poll budget with SIGTERM. If validation stalls in api-server
after a rebase, check for 42P01 in its log and run the lib/db push before
anything else.
