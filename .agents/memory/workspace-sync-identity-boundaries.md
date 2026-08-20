---
name: Workspace sync identity boundaries
description: Account-switch and legacy-data rules for safe multi-device workspace synchronization.
---

Every account-scoped async operation—not only saves—must capture its initiating account and token, then verify that identity before changing workspace state. Revision-conflict merges must carry deletion markers so absence is not mistaken for stale data to restore. Unscoped legacy device data requires an explicit import choice.

**Why:** Shared token getters can change while chat, extraction, or persistence is in flight, allowing one account's work to mutate another account. Union-only conflict merges resurrect deleted records because deletion is otherwise represented only by absence. Automatically claiming unscoped legacy data has the same cross-account risk on shared devices.

**How to apply:** Use per-session controllers, user-scoped cache keys, captured bearer tokens, identity guards after every await, and abort work on account change. Merge tombstones before live records during conflict retries, and require consent before attaching legacy data to an account.