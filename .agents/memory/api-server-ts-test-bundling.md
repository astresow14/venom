---
name: API server TypeScript test bundling
description: How to run node:test suites that import the api-server's TypeScript modules, and why plain type stripping fails.
---

Node's `--experimental-strip-types` runner can only load a `.ts` module whose
relative imports are fully specified (`./x.ts`). Production code in this repo
imports extensionless (`../lib/website-safety`), so a `.test.mjs` that imports
such a module fails with `ERR_MODULE_NOT_FOUND`. Any test that touches those
modules must be written as a `.test.ts` and bundled with esbuild first, the way
the existing `test:*` scripts do.

Bundle format matters: `--format=esm` turns Express' CommonJS dependency chain
into `Dynamic require of "tty" is not supported` at runtime. Use
`--format=cjs` with a `.cjs` outfile for any suite that pulls in Express (or
other CJS-heavy packages); the pure-library suites get away with ESM.

**Why:** the workspace mixes extensionless TS imports, workspace package
specifiers that resolve inside `node_modules` (which Node refuses to strip),
and CJS runtime dependencies — bundling sidesteps all three at once.

**How to apply:** new HTTP-level route tests go in `src/routes/*.test.ts`,
bundled to `/tmp/*.test.cjs` and run with `node --test`; register the command
as its own package script and append it to the aggregate security suite so it
is not orphaned. Only dependency-free suites belong in the auto-discovered
`src/**/*.test.mjs` glob.
