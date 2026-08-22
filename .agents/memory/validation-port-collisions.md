---
name: Validation vs test-workflow port collisions
description: Completion validation re-runs the test command; a stale suite still holding the Playwright webServer port fails it with "port already used".
---

# Validation vs test-workflow port collisions

**Rule:** before (re)running completion validation, make sure no earlier run of
the test suite is still alive. The configured test workflow can auto-start at
session boot and hold the Playwright webServer port for many minutes; the
validation's own copy of the suite then dies instantly with
"http://127.0.0.1:<port> is already used".

**Why:** validation executes the same test command as the workflow, and both
suites bind fixed webServer ports. One stale boot-run cost a full validation
cycle that looked like a test failure but was only a port squat.

**How to apply:** a near-instant validation failure on a webServer port error
means a stale suite still owns the port — end those processes and re-run.
A real suite run takes minutes; seconds-fast exits are port squats, not test
failures.

Two hard-won additions: (1) `ss` is absent in this container, so `ss | grep || echo FREE` reports a false ALL_FREE — prove a port with a real TCP connect (node net.connect) or lsof, never with a missing tool's empty output. (2) Removing or reconfiguring a scratch workflow can orphan its pnpm→expo child pair, which keeps the port; find the pair with `ps aux | grep expo` and kill those PIDs directly before re-running completion validation.

The squatter can also be YOU: `markTaskComplete` returns while validation
keeps running in the background, and any local Playwright run you start in
that window (e.g. verifying a review fix) holds the same fixed webServer
port the validation suite needs — it then dies with "port already used"
and the whole run reads as a test failure. After calling markTaskComplete,
don't run package Playwright suites until validation settles (check with
CheckTaskCompletionValidation); verify fixes first, complete second.

- While completion validation is in flight, its own desktop test:web webServer holds the default e2e port — run local specs with the VENOM_DESKTOP_E2E_PORT override instead of hunting a "stale" process that is actually the live validation run.
