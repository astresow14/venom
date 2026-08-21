---
name: Venom ontology store
description: Server-side knowledge database — how the workspace blob, absorb/hydrate, server filing, and client mirroring stay consistent.
---

The Brain's knowledge graph lives in dedicated ontology tables (owner-scoped: ownerType+ownerId, per-user today, org later). The workspace blob no longer stores clusters; the server strips them on PUT and injects them back (newest-first, capped) on every GET/PUT response. Snapshot-size limits therefore no longer cap knowledge growth.

**Rules that keep the store and devices agreeing:**
- **Absorb only after the revision-checked blob save succeeds.** A stale PUT (409) must never mutate the store; the revision check is the gate that keeps last-writer-wins blobs from corrupting per-concept merge state.
- **Ensure the lazy owner import runs BEFORE the blob is overwritten** with a stripped state, or the legacy knowledge is lost. The owner row doubles as the idempotent migration marker; concurrent claims race safely via insert-on-conflict-do-nothing.
- **Absorb mirrors the client merge exactly** (newer lastUpdatedAt wins, incoming wins ties, plain tombstone kills iff deletedAt >= lastUpdatedAt, replaced tombstones permanent). Any divergence between the two merge implementations shows up as concepts flapping between devices.
- **Server-side filing returns `filed` records; clients replace those ids wholesale** and apply the same decay (x0.96 floor 0.12) to untouched same-project clusters WITHOUT bumping lastUpdatedAt, so the next sync's tie-break (incoming wins) converges instead of fighting.
- **Manual Brain notes intentionally still file locally**: their conversation/message ids are created client-side after extraction, so server filing would anchor evidence to a throwaway conversation id and produce duplicate-label concepts. The store absorbs them on the next sync.

**Why:** the store is the system of record but devices work offline from injected snapshots; every write path must converge to the same merge result no matter the order PUTs land.

**How to apply:** when adding a new knowledge write path (new correction type, bulk edit, org tier), route it either through PUT-absorb or through a store API that reuses the same merge/tombstone helpers — never a third merge implementation.
