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
citation for the same item and anything left unmatched renders as an archived
reference instead of a raw marker. That match must be tiered rather than a
single identity key: the provider reference is the strong signal but it is not
stable (issues get renumbered, doc paths renamed), so an unmatched reference
falls back to the URL. The fallback needs ambiguity guards on both sides or two
items on one page collapse into one — skip a URL that several refreshed
citations share, skip a refreshed citation some other cited item already matches
exactly, and skip a target that several distinct retired items would land on
(several ids for one unreferenced item may still share it). Deliberate
alternative: persisting an archive of retired citations would require an
OpenAPI/workspace-schema change on both clients and the server.

The retired-citation archive is bounded and part of the synced workspace
payload, so it needs shrinking as well as growing. An archived entry is only
ever rendered through a `[source:...]` marker in a saved answer, which makes
reachability from those markers the safe test for dropping one; a deterministic
citation id also means a restored item usually returns under its original id,
where the live citation already wins over the archive when rendering. Dropping
an entry an item reclaimed under a *new* id is only safe after the answers
citing it have been remapped onto that live citation, otherwise the reader
silently loses the title the answer was rendered with.

A retired source has two independent defenses, and browser coverage of one
proves nothing about the other: the local merge (legacy sources blob re-read on
reload) and the signed-in restore (cloud snapshot merged with local state and
its own tombstone set). Only the restore runs for a signed-in reader, so it
needs its own regression test. Reaching it from a browser test means the sync
test mode's fake cloud must outlive a reload — an in-memory harness silently
falls back to the local path and the test passes for the wrong reason.

**How to apply:** when adding a new source provider, keep the connect request
reconstructable from the stored source record, and keep the id derivation
deterministic. Apply a refresh by replacing the whole source record; if the
recomputed id differs (renamed repo, changed URL), retire the old record with a
deletion tombstone so cloud sync cannot resurrect the stale snapshot beside the
new one.
