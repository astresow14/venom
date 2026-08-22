---
name: Semantic merge route mangling
description: Auto-merged rebases can silently corrupt files both sides edited — audit against parents; a clean typecheck is not enough.
---

After a rebase or sibling merge whose conflicts were auto-resolved, files both sides edited heavily can be silently mangled with zero conflict markers: schemas swapped across routes, handler bodies cross-pollinated, whole features dropped or hybridized, orphan statements stranded after the final export. It all parses or typechecks in waves (one syntax error hides the semantic wave behind it) — and the damage can sit on main's own tip, because sibling merges validate BEFORE their final rebase.

**Why:** multiple incidents here shipped shredded route/test files invisibly; one dropped an authorization flag plus the very test that pinned it.

**How to apply:**
- Treat "0 tsc errors" as necessary, not sufficient. Parse-check main's own copy of conflict-prone files before trusting rebase output (`pnpm exec esbuild <file> --outfile=/dev/null` from the package dir).
- Never hand-patch a shredded file. A textual 3-way (`git merge-file` over the true base, main tip, and pre-rebase task tip — recoverable via `ORIG_HEAD` or the gitsafe backup ref) usually reconstructs it with zero conflicts; a zero-conflict reconstruction that differs from what the merge shipped is itself proof of mangling.
- Recover the damaged side's *intended* features by diffing its commit against its parent, then graft them back as exact-string, count-guarded edits. Matching text elsewhere in the file is not proof of damage — look-alike blocks are the usual cross-pollination source, so anchor every repair by its surrounding context.
- Orphaned fragments after the final export are the merger's displaced intended code: read them as the spec for what to reinstall. The coverage they imply may never have been committed coherently anywhere — reconstruct it from intent, don't just delete the tail.
- Prove any repair with BOTH sides' behavior suites, then re-verify HEAD after every later rebase: a mangled resolution committed once gets replayed, and auto-replayed picks after your last conflict round are unverified.
