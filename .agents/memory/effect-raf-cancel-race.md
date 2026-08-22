---
name: Effect rAF cancel race
description: Why scheduling focus (or any one-shot action) in a requestAnimationFrame from an effect that also setStates is a load-dependent flake.
---

# setState + requestAnimationFrame in one effect = scheduler race

An effect that (a) calls setState on its own dependency and (b) schedules a
one-shot action in `requestAnimationFrame` with `cancelAnimationFrame` in its
cleanup races two schedulers: React's re-render (triggered by the setState)
re-runs the effect and fires the cleanup; whenever that commit lands before
the browser's next frame, the cleanup cancels the rAF and the action silently
never happens. Which side wins flips with CPU load — locally it mostly
passes; on a loaded validation container it fails intermittently.

**How to recognize:** an intermittent "element rendered but never focused /
callback never fired" where the target provably exists (e.g. Playwright
`toBeFocused` polls resolve the node as `inactive` for the whole timeout),
failure rate rises with machine load, and budgets/timeouts make no difference.

**How to fix:** act synchronously inside the effect — by passive-effect time
the DOM is committed, so `handle.focus()` needs no frame delay. Reserve rAF
for effects that do not setState (then the cleanup only runs on real
unmount/dep change, e.g. a useFocusEffect claim with empty deps is safe).

**Where this bit:** the cross-tab build-run focus handoff on the mobile apps
screen; hardening wall-clock TTLs did nothing because time was never the
failure mode. Verify fixes with `--repeat-each` batches, not single runs.
