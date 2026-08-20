---
name: Durable draft cleanup
description: Ordering rule for local drafts that survive composer and authentication transitions.
---

Local drafts that survive authentication or composer unmounts must be scoped to both account and project, bounded, and expired after a short retention window. Successful filing must close the save queue, await any in-flight write, and only then clear the persisted draft.

**Why:** A debounced or already-running save can finish after successful cleanup and silently resurrect content that was already filed.

**How to apply:** Whenever a local draft has autosave plus an explicit commit action, serialize writes and cleanup through one coordinator. Reject new saves after commit starts, await pending work, then delete the stored draft.