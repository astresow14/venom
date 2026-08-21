---
name: Venom signed-in restore merge
description: Rules for reconciling a restored cloud workspace with the snapshot the device already holds, so unsynced work survives without resurrecting deleted content.
---

A signed-in restore must merge the device's own saved snapshot forward instead of taking the
cloud payload wholesale, and it may only add to the projects the cloud still lists — plus the
projects a device-local baseline proves the cloud has never seen.

**Why:** the device persists every edit locally but only reaches the cloud when a save
succeeds, so anything written offline (or after a save that kept failing) exists solely in the
local snapshot; a wholesale cloud restore silently deletes it on the next reload. The
project-scoped filter is what keeps the opposite direction safe: deletions travel as
tombstones, but the snapshot alone cannot tell a project created here from one another device
removed — both are simply on the device and absent from the cloud.

Telling them apart needs device-local bookkeeping the uploaded snapshot must not carry: a
baseline of the projects the cloud is known to have seen, written after every successful save
(exactly what was uploaded, so deletions prune it) and after every restore (everything the
cloud snapshot listed, keeping earlier entries while the device still holds the project, so a
reload that never persisted the merge reaches the same verdict). A project missing from that
baseline is unsynced local work and merges forward; one listed in it was dropped by the cloud
and stays gone. A device with no baseline recorded falls back to the stricter cloud-only rule.
Tombstones still outrank all of it.

Two further guards belong with that merge:

- Only a snapshot saved under this account's own storage key may be merged. A device with no
  scoped snapshot is holding freshly seeded starter content, and merging that grafts a demo
  project and its chat onto a real workspace.
- Decide "does this restore need uploading?" by comparing the merged state against the cloud
  snapshot run through the *same* merge, never against the raw payload. The merge fixes key
  order and re-sorts collections, so a raw comparison reports a difference on every hydration
  and turns each reload into a pointless upload.

**How to apply:** whenever the hydration or merge logic changes, cover both directions — work
written while saves fail surviving a reload, and a stale local snapshot failing to bring back
deleted chats, messages, clusters, or projects. A browser-level check needs a cloud snapshot
to exist first (the restore path is skipped for an account that never saved), then saves kept
failing across the reload so a passing assertion cannot come from a fresh upload.
