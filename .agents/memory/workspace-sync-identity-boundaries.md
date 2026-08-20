---
name: Workspace sync identity boundaries
description: Account-switch and legacy-data rules for safe multi-device workspace synchronization.
---

Every account-scoped async operation—not only saves—must capture its initiating account and authentication context, then verify that identity before changing workspace state. Revision-conflict merges must carry deletion markers so absence is not mistaken for stale data to restore. Cloud hydration must also merge newer user-scoped local state before declaring the workspace synced. Unscoped legacy device data requires an explicit import choice.

**Why:** Shared token getters or cookie sessions can change while chat, extraction, or persistence is in flight, allowing one account's work to mutate another account. Union-only conflict merges resurrect deleted records because deletion is otherwise represented only by absence. A reload can interrupt a debounced cloud save after the local write; treating the older cloud snapshot as authoritative then loses the user's latest change. Automatically claiming unscoped legacy data has the same cross-account risk on shared devices.

**How to apply:** Use per-session controllers, user-scoped cache keys, captured authentication context, identity guards after every await, and abort work on account change. During hydration and conflict retries, merge tombstones before live records, keep the cloud revision as the save baseline, and queue any merged local difference. Require consent before attaching legacy data to an account.