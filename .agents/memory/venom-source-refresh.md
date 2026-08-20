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

Citation ids are hashes of the source id plus an item key, so they only churn
when the source id itself changes (renamed repo, changed URL). Saved answers
keep their inline markers, so a refresh remaps retired ids onto the refreshed
citation for the same item (matched by reference, else URL) and anything left
unmatched renders as an archived reference instead of a raw marker. Deliberate
alternative: persisting an archive of retired citations would require an
OpenAPI/workspace-schema change on both clients and the server.

**How to apply:** when adding a new source provider, keep the connect request
reconstructable from the stored source record, and keep the id derivation
deterministic. Apply a refresh by replacing the whole source record; if the
recomputed id differs (renamed repo, changed URL), retire the old record with a
deletion tombstone so cloud sync cannot resurrect the stale snapshot beside the
new one.
