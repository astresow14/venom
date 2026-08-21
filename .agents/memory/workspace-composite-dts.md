---
name: Composite lib dist types go stale
description: Missing-export typecheck errors in dependents while runtime works fine — stale composite declarations, not broken code.
---

# Composite lib dist types go stale

Runtime and typecheck disagree by design here: package `exports` point at `src`, so esbuild bundles and the running server always see fresh source, while a dependent's `tsc` resolves the referenced project's emitted `dist/*.d.ts`.

**Rule:** when a dependent typecheck reports `has no exported member` for something visibly exported in the lib's source — and tests/runtime use it fine — the lib's declarations are stale. Rebuild them with `--force`: plain `tsc -b <pkg>` can claim "up to date" off a stale `.tsbuildinfo` and rebuild nothing.

**Why:** this cost an investigation that pointed at correct code; runtime-vs-typecheck disagreement is the tell that distinguishes it from a real missing export.
