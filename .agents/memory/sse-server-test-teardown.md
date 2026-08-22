---
name: SSE server test teardown
description: Integration tests that open SSE streams must destroy server connections explicitly; client abort alone can wedge the test process forever and mask real failures.
---

# SSE server test teardown

**Rule:** any integration test that opens an SSE stream against an in-process
HTTP server must tear down server-side: start `server.close()`, then call
`server.closeAllConnections()`, and await the close callback. Never rely on
client `AbortController.abort()` alone to end the connection.

**Why:** a fetch abort is not guaranteed to destroy the underlying loopback
socket (observed Node/undici-version dependent). The route's SSE heartbeat
`setInterval` then keeps writing into the still-open socket successfully
forever, `server.close()` never settles, and the `node --test` child never
exits (`--test-timeout=0`). Two compounding hazards observed:

- The wedge is **silent**: `✔/✖` prints only after a test settles, so a test
  whose *assertions already failed* shows nothing — the runner just hangs
  after the previous test's output. The hang can therefore mask a real,
  unrelated assertion failure inside the same test.
- Downstream, the whole suite chain (`&&`-chained sub-suites) never reaches
  later suites, and completion validation times out rather than failing with
  a readable error.

**How to diagnose:** the stuck child still runs with `--report-signal=SIGUSR2`
in this environment — `kill -USR2 <pid>` writes a `report.*.json` whose
`libuv` section lists live handles. A loopback tcp pair (both ends in the same
process) plus a referenced timer = an SSE stream survived client abort.
Delete the report file afterwards (untracked files reach history here).

**How to apply:** in the test's `finally`:
`const closed = new Promise(r => server.close(r)); server.closeAllConnections(); await closed;`
Production servers are unaffected (they don't exit per-request), so the fix
belongs in the test teardown, not the route. Consider `.unref()` on new SSE
heartbeat intervals as belt-and-braces.
