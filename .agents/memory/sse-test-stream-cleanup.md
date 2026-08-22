---
name: SSE test stream cleanup
description: Why an SSE integration test must abort every opened stream in finally, and how a leaked stream masks real failures as infinite hangs.
---

# SSE integration tests: abort every stream in finally

Rule: any test that opens an event-stream `fetch` must create ALL of its
AbortControllers beside the try block and abort every one of them in
`finally` — not just the first stream, and not only on the success path.

**Why:** `server.close(cb)` waits for every open connection. A stream whose
abort only happens on the success path stays open when an assertion between
"stream opened" and "abort reached" throws; the thrown error is queued behind
`finally`, which awaits `server.close()` forever. The real red assertion is
never printed — the suite just goes silent and eats the entire validation
poll budget (observed: a missing-schema 500 on a route turned into a
30-minute hang twice in a row).

**How to recognize:** `node --test` output stops after the previous test's ✔
with nothing printed for the running test; the process sleeps (State S);
`pg_stat_activity` shows no active queries and no advisory locks — the wait
is purely in-process. The only unbounded await in such a test is
`server.close()`.

**How to apply:** hoist every AbortController next to the first one before
`try`; in `finally`, abort them all (aborting an unused controller is a
no-op), then await `server.close()`. Per-event reads should keep their own
timeout race (a 3s `nextEvent` deadline); the finally hygiene is what turns
a hidden hang back into a loud failure.
