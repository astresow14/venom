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
