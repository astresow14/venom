---
name: API server TypeScript test bundling
description: Why api-server route tests must be esbuild-bundled CJS inside the package, not stripped or /tmp-bundled
---

Node's type stripping cannot load this repo's extensionless TS imports or workspace specifiers, so route-level suites must be `.test.ts` bundled with esbuild before `node --test`. Bundle as CJS (an ESM bundle breaks on Express' CommonJS dependency chain) and keep the outfile inside the package: pino's pretty transport resolves its worker relative to the bundle location, so a bundle outside the package crashes after the tests pass.

**Why:** Each of these three failure modes (module-not-found, dynamic-require, post-suite transport crash) looks like a broken test rather than a loader/bundler constraint, and each burned real debugging time before the pattern settled.

**How to apply:** New HTTP-level suites follow the existing `test:*` scripts: bundle to the package's own dist, run with `NODE_ENV=test` and a silent log level (module-level loggers otherwise spawn the transport), and append the script to the aggregate test chain so it cannot be orphaned. Only dependency-free suites belong in the auto-discovered `.test.mjs` glob.

## The aggregate suite is provider-hermetic

The whole api-server aggregate test chain runs with only `DATABASE_URL` plus dead-end OpenAI placeholders (`AI_INTEGRATIONS_OPENAI_BASE_URL`/`_API_KEY` pointing at an unroutable localhost port). The OpenAI integration lib asserts those two at import time but no suite actually calls a provider, and a fresh empty Postgres works after `drizzle-kit push --force` (some integration suites also self-create their tables).

**Why:** placeholders passing is a proof, not a hack — if a test ever reaches a real provider it fails instantly against the dead-end URL instead of silently spending money or flaking on network. This is what makes the suite runnable in hermetic CI with a service container.

**How to apply:** keep CI/validation environments to `DATABASE_URL` + the two placeholders; if a new suite starts requiring more env, treat that as a hermeticity regression to fix in the test, not new CI config. Verify locally with `env -i HOME PATH DATABASE_URL + placeholders` before touching CI.
