---
name: Semantic merge route mangling
description: Auto-merged rebases can silently corrupt files both sides edited — audit against parents; a clean typecheck is not enough.
---

After a rebase whose conflicts were resolved by a semantic merger, files both sides edited heavily can be silently mangled in regions that never showed a marker: duplicated schemas across similar handlers, fragments swapped between routes, whole feature branches dropped or hybridized, dropped imports beside kept re-exports, statements displaced past the module's final export. All of it parses; only some of it typechecks as errors.

**Why:** several incidents here landed mangled route and test files on main with zero conflict markers, including one whose damage (a dropped authorization flag plus its truncated test) shipped invisibly because nothing red remained.

**How to apply:**
- Treat "0 tsc errors" as necessary, not sufficient. Map structural anchors (route paths, exported symbols, top-level `});` count) across ours/theirs/result, and check for dead code after the final export.
- Repair by splicing the owning parent's whole block, never line-by-line patching. Build a coherence table of every historical version of the file first (`git log --all -- <file>` + cheap marker counts): a later merge may already contain the repair, and sibling task-branch tips can carry the identical mangling — verify before splicing from any of them.
- The strongest proof and repair is a textual 3-way reconstruction: merge the owning task branch's tip against the other parent from their true merge-base. A zero-conflict reconstruction that differs from what the merge shipped is proof of mangling — install the reconstruction, sanity-checked with invariant counts all parents agree on.
- Orphaned statements after a test's closing `});` (esbuild: "Top-level await is not supported with cjs") can coexist with real assertions deleted from the body, and the orphan may appear in *every* historical version — meaning the coherent original was never committed. Then the lost coverage must be reconstructed from the fragments' intent, not restored; deleting the tail alone silently drops coverage.
- When damage may span code and tests, audit the code path the tests covered too: a truncated test can hide a matching truncated route (here: a role-based exclusion flag vanished from the one call site its test asserted).
- A mangled resolution committed once compounds: later rebases replay it and can re-mangle the same file with no pause, and auto-replayed picks after your last conflict round are unverified. After any rebase completes, re-verify HEAD itself (typecheck + the touched suites of BOTH sides), and rebuild lib dists before believing phantom type errors (see workspace-composite-dts, post-rebase-derived-state).
- A merge can land with no completion validation ever running against the merged result (concurrent tasks validated before it landed). When a file you never touched fails to parse or a suite you never touched fails, suspect the latest merge, not your diff.
- A merged sibling's new tables exist only in its own task environment: run the db package's schema push in your environment before believing its integration tests are broken (`relation ... does not exist`).
- Mangling can sit on main's own tip: a feature commit itself lands garbled (duplicated consts, an unclosed block, handler bodies cross-pollinated between similar routes) and every branch inherits it byte-identical. Repair it in-branch (established precedent); recover intent by diffing that commit against its parent — its hunks separate intended additions from damage.
- One parse error suppresses every semantic error tsc would report: after fixing the syntax, expect a second wave (wrong body schemas, out-of-scope variables, swapped owners) that was invisible before.
- Orphaned statements after the final export are often the merger's displaced *intended* code — read them as the spec for what to reinstall at the right site.
- The cross-pollination source is usually a legit look-alike block elsewhere in the same file, so matching text is not proof of damage; disambiguate every repair anchor by its following context and count-guard scripted replacements so they refuse ambiguous matches.

## Durable repair lesson

Never hand-patch a semantically-shredded file: a plain textual 3-way (`git merge-file` over base = the task's branch point, main tip, and the pre-rebase task tip — recoverable via `ORIG_HEAD` or the gitsafe backup ref) usually reconstructs it with zero conflicts. Then trust tests, not inspection: typecheck to find every casualty, and run BOTH sides' suites over the result — a typecheck-clean file both sides touched is only proven by its tests.

**2026-08 escalation:** the mangling class can land on main itself — a sibling task's merge shipped venom.ts with swapped zod schemas across routes, a duplicated route stub replacing a GET, fused/duplicated ledger blocks, and orphan fragments after `export default router;` (file didn't even parse). Mobile-only CI let it through. When validation gates on a file main broke: repair it in-branch — reconstruct from the last clean pre-merge copy plus the merge's *intended* additions (test expectations pin the intent), never wholesale-revert the sibling's feature. Always parse-check main's own copy of conflict-prone files (`pnpm exec esbuild <file> --outfile=/dev/null` from the package dir) before trusting rebase output or starting validation.

## The mangling can already be ON main
Sibling merges validate BEFORE their final rebase, so main's tip itself can carry a
shredded file (duplicate route registrations, cross-route bodies, route-scoped code at
top level, undefined identifiers) that no CI ever compiled. Verify with
`git show :2:<file>` vs `git show main-repl/main:<file>` — identical means main is the
broken side, and `git log -S` on "your" constructs may just be finding pre-existing
helpers, not evidence your work already merged.

Repair recipe: `diff base main-tip` to catalog main's *intended* features (imports,
inserted blocks, renames), then rebuild the file from the healthy branch side and graft
each feature back as asserted exact-string edits (script them; assert each anchor occurs
exactly once). Take API shapes from the sibling's cleanly-merged lib files, not from the
shredded fragments. Prove the splice with both sides' behavior suites before continuing
the rebase.
