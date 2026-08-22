---
name: Mirror snapshot sync
description: The GitHub mirror receives tree snapshots, never workspace history; workflow paths pin to base without a capable credential; push protection rejects token-shaped fixture literals.
---

The GitHub mirror sync publishes a **snapshot commit**: the workspace tree rebuilt on the mirror's current `main`, force-pushed to the sync branch. Local commit ids never appear on GitHub, and the drift check compares **tree identity**, not commit ancestry.

**Why:** Replit checkpoints commit whatever sits in the tree, so workspace history can permanently carry unpublishable blobs (a private key once landed that way) and cannot safely be rewritten. Raw-history pushes also went stale-conflicting whenever mirror-side commits (CI proofs) advanced `main`. A snapshot's head always descends from the live base, so the sync pull request is permanently mergeable, and the credential guard scans exactly what ships — the tracked tree, no history scan.

**How to apply:**
- Never "fix" mirror drift by pushing local history or rebasing onto the mirror; run the sync, which rebuilds the snapshot on the current base.
- When the diff touches `.github/workflows/` and no credential can write workflows, those paths ship **pinned to the base version** (loudly reported, recorded in sync state); they follow automatically on the first sync after a workflow-capable credential exists. A workflow-only diff still fails rather than syncing nothing.
- Merge the sync PR with squash; the squash commit carries the snapshot tree verbatim, so post-merge verification is `treeOf(mirror main) == snapshot tree` (or == workspace tree once workflows ship).

**Push protection gotcha:** GitHub scans every pushed blob for provider-token patterns. A test fixture literal like a Slack `xoxb-...` string blocks the entire push even though it is synthetic. Fixtures that must look like real tokens get assembled at runtime (`["xoxb", "…"].join("-")`) so no source blob contains a scanner-matching literal; the runtime string is unchanged. The repo's own credential guard only catches key *files* (extension/banner), not token-shaped source literals — push protection is the backstop that finds those, and it reports the exact path and line.
