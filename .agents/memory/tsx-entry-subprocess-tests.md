---
name: Offline subprocess tests for tsx entry scripts
description: Durable gotchas when spawning a tsx-based CLI entry from a test with a scratch cwd.
---

Entry scripts that run main() on import are tested by spawning them, and three non-obvious failures recur:

- A bare `--import tsx` resolves from the child's cwd; a /tmp scratch dir has no node_modules, so resolve tsx from the test's own package via `import.meta.resolve("tsx")`.
- A scratch TS entry under /tmp without a nearby `"type": "module"` package.json compiles as CJS and top-level await fails; spawn the real entry inside its package regardless of cwd.
- Offline is enforced, not assumed: preload a fetch replacement that throws on any URL the test did not allow, isolate git with `GIT_CONFIG_GLOBAL=/dev/null` and `GIT_CONFIG_SYSTEM=/dev/null`, strip credential env vars, and scan raw written bytes for leaks (not parsed fields).

**How to apply:** any CLI whose main() runs at module top level; assert on the child's exit code, stdio, and files it writes. Token-shaped fixture values must be assembled at runtime or credential scans trip on the test source.
