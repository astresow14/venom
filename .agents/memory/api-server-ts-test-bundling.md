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

## Pointing the eager OpenAI client at an in-test mock

The OpenAI integration client is constructed at import time from its two env vars — unlike the lazy Anthropic/Gemini/OpenRouter getters. A suite that needs provider traffic to hit a local mock must set the env first and only then dynamically import the route module: esbuild CJS bundles defer each module's evaluation until first require, so an `await import(...)` inside the test body makes the ordering real.

**Why:** with a static import the client binds whatever env the process started with, and the suite silently runs against the dead-end placeholders instead of the mock — provider paths error out instead of exercising the behavior under test.

**How to apply:** start the mock server on port 0, write its URL into the OpenAI env vars, delete the other providers' env so availability stays deterministic, then dynamically import the router. Before trusting any leak/regression guard suite, mutation-test it once: inject the forbidden output into the route, confirm the exact assertions fail, revert.

## The Gemini SDK cannot be inlined into script bundles

`@google/genai` pulls in google-auth-library, which dynamic-requires node built-ins at module init — an esbuild ESM bundle that inlines it dies with "Dynamic require of child_process is not supported" the moment the import executes. The server build already externalizes `@google/*`; any standalone script bundle that can reach Gemini must do the same **and** emit its outfile inside the package (externals resolve relative to the bundle location, so a /tmp outfile cannot find node_modules).

**Why:** the failure hides easily — code that only imports the Gemini lib lazily bundles fine and passes until the first run that actually executes the import.

**How to apply:** any script bundle that can reach the Gemini lib needs `--external:@google/genai` and an outfile inside the package. Keep integration libs init-safe: env validation belongs in lazy client getters, never at module scope, or every root import breaks in partially-configured environments.
