---
name: Playwright suite filtering
description: How to run a subset of the venom / venom-desktop Playwright suites without triggering the whole run.
---

Filtering spec files through the package scripts does not work: `pnpm run test:web -- e2e/foo.spec.ts` in these packages runs the ENTIRE suite (observed on venom-desktop: all 47 tests, ~4 min, despite file args). The positional filters are lost somewhere in the pnpm script + pre-hook chain.

**How to apply:** run targeted specs with `pnpm exec` from the package directory so the package's playwright config still applies:

```
cd artifacts/venom && PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=$(command -v chromium || true) pnpm exec playwright test e2e/brain-camera.spec.ts
```

This filters correctly (warmup/setup projects still run first, as configured). Same pattern works for venom-desktop.

**Why:** validation and smoke runs are frequent here; the difference is ~30s vs ~4min per iteration.
