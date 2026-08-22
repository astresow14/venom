---
name: Shared dev DB vs background workers
description: Integration tests share the dev database with the running dev server; its rescue workers must age-gate claims
---

Server integration tests run against the same database as the always-on dev server workflow. Any background worker that claims rows by status (queue rescuers, stale-run reconcilers) will grab rows a test process just created, no matter what the test stubs in its own process. Rescue-style reconciliation must only claim rows older than a grace period — fresh rows are already scheduled in-process by their creator.

**Why:** A suite asserting a just-created run was still queued flaked only on slower machines: the dev server's 10s reconcile loop claimed the row mid-test and moved it to preparing. In-test scheduler stubs cannot help because the claim happens in another process.

**How to apply:** When a test asserts pre-processing state for rows in shared tables, check what the dev server's periodic workers select on. Give rescuers a created-at cutoff (minutes) rather than disabling them; that also stops redundant re-scheduling of fresh work in production. Restart the dev workflow before trusting a rerun — the gate must run in the claiming process.

## Queue-rescue tests: inject a future clock, never backdate

Once a rescuer is age-gated, its test cannot insert a fresh queued row and expect rescue (fails the gate), and backdating the fixture past the gate re-exposes it to the live dev server's reconcile loop. Instead give the reconcile function an optional `now` (defaulting to `Date.now()`) used only for the rescue cutoff, thread it through the `*ForTests` export, and have the test pass `Date.now() + gate + slack`: the fresh fixture qualifies as aged inside the test's own invocation only and stays invisible to every other process until cleanup deletes it. Keep any stale-run fail-sweep inside the same reconcile on the real clock — a future clock there would fail-sweep foreign in-flight rows on the shared DB.

**Why:** an out-of-chain suite went stale exactly this way: the rescuer gained an age gate, the fresh-fixture rescue assertion silently rotted, and the backdating "fix" would have traded a deterministic failure for a cross-process race plus real provider calls when the dev worker claimed the row.

## Retention sweeps: dual-timestamp gate + injected future clock

For staleness-based retention sweeps (rows selected by an old `refreshedAt`-style column), fixtures with a rewound timestamp are exactly what the live server's sweep hunts — and a fake user id that 404s upstream gets its fixture *deleted* mid-test. Two-part pattern: (1) the sweep's predicate requires `createdAt` to predate the cutoff too — a no-op in production where both timestamps move together at insert, but it hides fresh fixtures (and this file's older `now: 1000` fixtures) from the live server; (2) the test writes fixtures with *current* timestamps and runs the sweep with an injected `now` 30+ days in the future, so rows are stale only inside the test's own invocation. Test fetchers must throw for unknown ids (real rows on the shared DB stay untouched; deletion needs an explicit "gone") and assertions on totals must be subset-based (`failed === scanned - fixtures`).

- Count-based invariants (e.g. "last admin cannot be revoked") read the whole shared table: any integration test asserting them must park all pre-existing rows first and restore them in finally — the running dev server re-creates its bootstrap row on every boot, so a suite that was green on an empty table starts failing forever once the live row lands.
