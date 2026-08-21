---
name: Semantic merge route mangling
description: Auto-merged rebases can silently corrupt files both sides edited — audit handlers against both parents, not just conflict markers.
---

The rule: after a rebase whose conflicts were "resolved" by a semantic merger, a clean typecheck of conflicted files is not enough — files with heavy edits on both sides can be silently mangled in regions that never showed a marker.

**Why:** During one rebase, the auto-merge of a large Express route file (multiple similar handlers) produced: the same request schema pasted into all three route parses, one route's log/prompt/body fragments swapped into another, a GET route replaced by a duplicate POST opener, an entire feature branch (`if (...) { run... }`) dropped and hybridized with the adjacent branch, and orphaned variable declarations dumped after `export default router;`. All of it parsed; only some of it typechecked as errors.

**How to apply:** After any auto-merged rebase, for each file both sides changed heavily: (1) run tsc, but treat "0 errors" as necessary, not sufficient; (2) map structural anchors (route paths, exported symbols) across ours/theirs/result — count and order must reconcile; (3) when a handler is damaged, don't patch line by line: identify which parent owns the region (`diff` the region against each parent), take that parent's block wholesale, and splice the other side's localized additions back in; (4) check for dead code after the module's final export; (5) rely on both sides' test suites — run the OTHER side's feature specs too (their voice/persona tests catch damage to their features that your own specs never exercise).

**Compounding across rebases:** a mangled auto-merge that gets committed as a conflict resolution becomes part of the branch history — the next rebase replays the mangled commit and the later repair commit separately, and the merger can re-mangle the same file at the first step. Before continuing a multi-commit replay, snapshot the branch tip's version of fragile files (`git show ORIG_HEAD:<path>`) and the other parent's delta; after the rebase completes, rebuild the file as tip-version + other-parent delta rather than trusting the replayed result.
