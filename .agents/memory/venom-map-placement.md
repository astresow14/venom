---
name: Venom knowledge-map placement determinism
description: How chat-cluster/concept map positions are placed and repaired without breaking cross-device sync
---

Chat-derived cluster positions are synced, persisted fields computed ONCE at creation — any stacking mistake lives forever, so placement and repair follow strict rules (shared lib: venom-workspace-merge clusterPlacement; server mirrors it in the ontology core by convention instead of importing).

**Rules:**
- All placement/repair geometry is integer-only with exact squared-distance comparisons — no trig/sqrt in anything recomputed on multiple devices. Cross-engine float ULP differences would sync ping-pong forever. The legacy label-hash seed keeps cos/sin only because it runs once, on one device, then is stored.
- The legacy hash seed must stay byte-identical everywhere (apps + server pin fixtures on it); changing it silently relocates every existing topic.
- Repair (separating stored stacks) runs on EVERY load/merge path in BOTH apps (normalize, merge, filed-cluster application, mobile migrate) so devices converge; a one-sided persisted repair ping-pongs because merge ties favor the device.
- Repair must NEVER touch lastUpdatedAt — repaired coords must not win merges or resurrect tombstones; both sides compute identical coordinates instead.
- Priority is ascending-id (creation-shaped): older cluster keeps its exact stored spot; violators re-place seeded from their own stored position, avoiding accepted ∪ pending stored spots (prevents cascades). Idempotent; returns the same array reference when nothing moves.
- Cross-copy parity between the shared lib and the server mirror is guarded by identical pinned fixtures in both suites (e.g. a (100,100) self-stack repairs to (82,118)) — if you change the algorithm, update BOTH pins or the drift is caught.

**Why:** positions persist into synced state; the map's tappability floor is 12 logical units (24 map px) owned by CLUSTER_SPACING_FLOOR in the shared lib and reused by source-dot layout.

**How to apply:** any new write path that creates or merges clusters/concepts must place via the shared helpers (clients) or the mirrored core helpers (server) and re-run the repair on merge outputs. UI-test fixture clusters must sit ≥ 12 apart or the repair will move them mid-test.
