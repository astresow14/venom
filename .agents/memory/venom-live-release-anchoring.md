---
name: Venom live release anchoring
description: Contract for the app live-release pointer, iteration shipped-as stamps, and the latest-or-live baseline rule.
---

The portfolio app record's live pointer and the per-iteration "shipped as" stamp are separate concepts with different lifecycles:

- The app's live pointer moves **only inside provisioning publish/rollback success transactions** — never from portfolio routes, never client-supplied. A rollback moves it back to the restored release, which is what makes rollbacks visible on the record and timeline.
- An iteration's release stamp is **historical**: it records the release that shipped that package version, survives the iteration being superseded, and is never cleared. Publish and rollback both (re-)stamp matching iterations by build run, which backfills rows created before the feature existed.
- Approved/live divergence (`in_sync` / `live_behind` / `live_ahead` / `live_unversioned`) is **computed at read time** from pointer + stamps, never stored.
- Creating an iteration accepts a baseline that is only the newest approved package (default) or the currently live iteration — anything else is a 409. The client offers the choice only when `baselineSelectable` says the live revision still resolves.

**Why:** once candidate releases exist, "newest approved" and "what users are seeing" routinely split (unpublished v3, rollback to v2). Silently baselining on the newest package would iterate on work users never saw; storing divergence would go stale the moment the pointer moves.

**How to apply:** any new write path that publishes/rolls back releases must move the pointer and re-stamp iterations in the same transaction. Loosening the baseline rule (e.g. arbitrary historical baselines) is a server contract change first, not a client toggle. The mobile Improve sheet consumes the same context payload, so divergence fields are already available to it.
