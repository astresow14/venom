---
name: Background servers and ShellExec invocations
description: Detached processes do not survive shell invocations; how to run long servers and long test suites here.
---

# Background servers and ShellExec invocations

**Rule:** a server started in a ShellExec invocation — even with `nohup`,
`setsid`, `& disown`, and redirected stdio — is gone by the next invocation.
Its log file may not even appear. `pgrep -f` afterwards can *look* like the
process survived because the pattern matches the current invocation's own
wrapper shell; verify with `ps -p <pid>` or by actually connecting.

**Why:** the invocation's whole process tree is torn down when the call
returns or times out. Two sessions wasted long debugging loops on this.

**How to apply:**
- Long-lived servers belong in workflows (restart the managed workflow, then
  poll logs). /tmp *files* persist fine between invocations; processes do not.
- Long test suites: run them inside one bounded invocation with
  `timeout 280 ... > /tmp/x.log 2>&1; echo exit=$?; tail /tmp/x.log` so the
  shell cap never eats the output, or run the suite through a configured test
  workflow and poll its log file.
- Polling a workflow's run with `pgrep -f <pattern>` has the same self-match
  trap in loop form: every polling invocation's wrapper shell carries the
  pattern in its own cmdline, so it reports RUNNING forever. Bracket a
  character (`pgrep -f "playwright [t]est"`) or just refresh the workflow
  logs and look for the summary line. One session polled a finished suite
  for an hour because of this.
- Playwright suites that boot their own webServer work fine within a single
  invocation once bundler caches are warm; the first cold run may need the
  workflow route instead.
- A one-off Playwright script must live inside the package directory to
  resolve its imports (bare specifiers resolve from the script's location).
