---
name: Venom project undo restore
description: How undo coexists with permanent tombstoned deletion — capture before delete, rebuild under fresh ids after
---

Undo for a synced deletion never argues with the tombstones. The delete commits exactly as before (tombstones written, content gone); undo rebuilds the captured content as **new entities under fresh ids** through the shared capture/restore pair in the workspace-merge lib, re-exported by both apps like every other merge rule.

**Why:** Tombstones are the sync invariant — nothing may resurrect a dead id, and a deferred-commit undo would open windows where devices disagree about whether the delete happened. Fresh-id rebuild follows the existing fallback-workspace precedent, so a restore merges across devices as ordinary new work while the old ids stay dead everywhere. This shape was chosen over "delay the tombstones" deliberately.

**How to apply:** Any future undo/trash/restore feature for synced entities should reuse or mirror the pair:
- capture the snapshot *inside* the state updater that performs the delete (StrictMode double-invoke safe — last run wins), keep it in a ref, render only a small descriptor;
- restore = fresh ids for every tombstoned id space + remap all cross-references; ids that are never tombstoned (archived-citation ids, message content markers, attachment stamps) stay verbatim;
- removing a delete-seeded fallback workspace during restore needs tombstones of its own, and only while the fallback is provably untouched;
- pending snapshots are in-memory only and account-scoped: cleared on user change, one at a time, gone on reload — by design, not oversight.

Side effects that ride along: org linkage (orgId/orgMirror) is dropped (share bound the dead id); source sync claims are dropped so the scheduled worker re-syncs and re-attests promptly; stale attestations degrade gracefully because the server *skips* failed verifications rather than rejecting the save.
