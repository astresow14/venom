---
name: Venom connected-source refresh
description: Why refreshing a project source replays the original connect request instead of using a dedicated endpoint.
---

Refreshing a connected project source replays the original connect request
(GitHub repository path, or website URL) rather than calling a separate
refresh endpoint.

**Why:** the server derives a source id by hashing `projectId` + provider key,
so replaying the connect request recomputes the same id, a fresh attestation,
and a fresh citation set in one round trip. A dedicated endpoint would have to
duplicate that derivation, and attestations are bound to the citations they
were minted with, so partial metadata updates are not safe.

**How to apply:** when adding a new source provider, keep the connect request
reconstructable from the stored source record, and keep the id derivation
deterministic. Apply a refresh by replacing the whole source record; if the
recomputed id differs (renamed repo, changed URL), retire the old record with a
deletion tombstone so cloud sync cannot resurrect the stale snapshot beside the
new one.
