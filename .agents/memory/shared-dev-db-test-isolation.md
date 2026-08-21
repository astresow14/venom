---
name: Shared dev DB vs background workers
description: Integration tests share the dev database with the running dev server; its rescue workers must age-gate claims
---

Server integration tests run against the same database as the always-on dev server workflow. Any background worker that claims rows by status (queue rescuers, stale-run reconcilers) will grab rows a test process just created, no matter what the test stubs in its own process. Rescue-style reconciliation must only claim rows older than a grace period — fresh rows are already scheduled in-process by their creator.

**Why:** A suite asserting a just-created run was still queued flaked only on slower machines: the dev server's 10s reconcile loop claimed the row mid-test and moved it to preparing. In-test scheduler stubs cannot help because the claim happens in another process.

**How to apply:** When a test asserts pre-processing state for rows in shared tables, check what the dev server's periodic workers select on. Give rescuers a created-at cutoff (minutes) rather than disabling them; that also stops redundant re-scheduling of fresh work in production. Restart the dev workflow before trusting a rerun — the gate must run in the claiming process.
