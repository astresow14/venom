---
name: Venom shared merge-rules library
description: Cross-device merge rules live in one shared workspace lib; apps re-export it, and drift or shadow copies are the failure mode to avoid.
---

The cross-device merge rules (deletion markers, tombstones, connected sources, scheduled-sync claims) live in one shared workspace lib. The phone and desktop apps do not define these rules — they re-export the lib's bindings under their historical export names, and both apps' suites assert export identity and cross-app parity so a shadow copy cannot sneak back in.

**Why:** the two apps once kept hand-written copies that had to agree exactly; one side reviving an entity the other retired wrote the revival back to the cloud and undid the fix. Duplicates in this area drift silently.

**How to apply:**
- Change merge behavior in the lib only; never reintroduce a local copy behind the same export name.
- A pure `export { x } from 'lib'` re-export creates **no local binding** — a module that also *calls* the helper must import it as well, or every call site becomes a runtime ReferenceError that typecheck catches but bundlers may not.
- The lib stays a single-file, type-only-deps package on purpose: it must load identically under `node --test --experimental-strip-types`, Metro, and Vite.
- Cross-app parity is judged on sources + tombstones + board stages; field and task-position normalization still differ per app, so whole-state comparisons fail for unrelated reasons.
- Board stages: duplicate names are kept and renamed deterministically (suffix " (n)" walked in position-then-id order, updatedAt untouched) — never dropped (silently deletes a user's column) and never kept verbatim (the api-server rejects saves whose stage names collide case-insensitively). Repairs must not bump updatedAt or they beat genuine edits in newest-wins merges.
- The api-server's scheduled-source sync imports the deletion-marker rules (isReplacementMarker, mergeDeletionMarkers, createDeletionMarkers, TOMBSTONE_LIMITS) and its suite guards them with the same identity + pinned-fixture pattern; the lib bundles fine under the server's esbuild test/build setup because its api-client deps are type-only. Only cadence pacing remains mirrored server-side — it lives in the phone's sourceState, not the lib.
