---
name: Venom source tombstone semantics
description: Why a deletion marker must record why an entity went away, and which tombstones a newer incoming snapshot is allowed to beat.
---

A tombstone for a synced entity has to record *why* the entity went away, not just when. Two
kinds behave differently in the cross-device merge:

- **Replaced** (a refresh put a newer snapshot in the old one's place): absolute. No incoming
  copy may revive the id, whatever timestamp it carries. The flag is sticky through marker
  merging — a later plain deletion marker for the same id must not downgrade it.
- **Deleted** (the user disconnected it): time-compared. An incoming snapshot newer than the
  marker wins, because reconnecting the same source afterwards has to be allowed.

**Why:** the merge originally kept any source whose snapshot time beat the tombstone. Device
clocks are not comparable across devices, and a second device can sync an id before it learns
about a refresh, so a retired source resurrected on its own — two cards for the same site and
retired citations resolving to live links again. Timestamp comparison can only arbitrate
between events on one device's clock; permanence has to be stated, not inferred.

A permanent tombstone also has to outrank plain ones when the bounded marker list is capped:
oldest-first eviction otherwise drops the very marker that carries the guarantee, and heavy
source churn silently reopens the resurrection path.

**How to apply:** when adding a rule of the form "keep it if its timestamp beats the
tombstone", ask whether the entity could ever legitimately come back. If it cannot, record
that on the marker, skip the comparison, and give the marker eviction priority in whatever
caps the list. Both the mobile context and the desktop workspace library carry their own copy
of these merge rules — change them together, or the side that still resurrects the entity will
write it back to the cloud.
