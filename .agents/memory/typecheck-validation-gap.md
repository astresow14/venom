---
name: Typecheck validation gap
description: Type errors land silently because no validation workflow runs tsc and type-stripped test suites pass anyway.
---

None of the configured validation workflows (test, scripts-test, api-server-test, bundle budget) run `tsc`, and the apps' node:test suites execute TypeScript via type-stripping, so files with TS2304/TS2305 errors still run and their tests pass. Type breakage therefore lands silently until someone runs a package typecheck by hand.

**Why:** A symbol that was only re-exported (`export { x } from ...` does not bring `x` into local scope) was used inside the same desktop lib file; every suite stayed green while `pnpm --filter @workspace/venom-desktop run typecheck` was red for multiple merges.

**How to apply:** After touching desktop/mobile lib files or generated-client consumers, run the package typecheck yourself before completion — don't trust green unit tests. When a file both uses and re-exports a shared symbol, import it at the top in addition to listing it in the re-export block. Relative imports between app lib modules that node:test loads must carry an explicit `.ts` extension (`from './appPortfolio.ts'`): type-stripping resolves ESM paths literally and fails ERR_MODULE_NOT_FOUND on extensionless paths, while the bundler and `allowImportingTsExtensions` both accept the suffixed form.
