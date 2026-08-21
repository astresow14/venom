---
name: Project-references stale dist
description: Consumer artifacts typecheck against a workspace lib's built (gitignored) declarations; rebuild before believing "no exported member".
---

Desktop-style artifacts reference shared libs (e.g. the generated API client) through
TypeScript project references, so `tsc -p --noEmit` in the consumer resolves imports
against the lib's **built `dist/` declarations** — which are gitignored and not rebuilt
automatically by the consumer's typecheck.

**Why:** after the client source gained new exports, the desktop typecheck went red with
~35 "Module has no exported member" / "property does not exist" errors spread across
pages that had nothing wrong — including symbols that had compiled fine for months. The
stale dist made innocent files look broken, and a repair task was filed for what was
really a one-command rebuild.

**How to apply:** when a consumer reports a missing export that plainly exists in the
lib's `src/`, run `pnpm exec tsc -b lib/<package>` (from the repo root) and re-run the
consumer typecheck before treating any of its errors as real. Expect this whenever the
generated client is regenerated or a lib gains/loses exports. The mobile app is immune —
it resolves the same package via source, so a mobile-clean/desktop-red split is itself
the signature of a stale dist.

The durable fix for a consumer is a typecheck script that builds its referenced
projects before the `--noEmit` check; a consumer whose script skips that prebuild stays
exposed, and a prebuilt check that goes red is reporting real contract drift — trust it.
