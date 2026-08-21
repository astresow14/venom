---
name: Venom desktop code splitting
description: Rules that keep the venom-desktop first load small once routes are lazy-loaded; breaking any of them silently puts weight back on the critical path.
---

# Keeping the venom-desktop critical path small

Every route in the desktop web app is behind a dynamic `import()`. Three rules
keep that split from quietly undoing itself.

## 1. A loading placeholder on the critical path must be CSS-only

**Rule:** the fallback rendered by the top-level route boundary may not import
the Motion runtime (or any other large library).

**Why:** that placeholder is the one thing shown *before* any route chunk has
arrived. If it needs an animation library, the loading state is itself blocked
on a download, so the user stares at a blank page for exactly as long as the
thing the placeholder was meant to cover. It also drags the library back into
the entry chunk for every visitor, including ones who never see a page that
animates.

**How to apply:** entry-level placeholders use CSS keyframes declared in
`index.css`. Placeholders that only render *inside* an already-loaded route
(e.g. the workspace content area) may use Motion freely.

## 2. `manualChunks` may only name packages already reachable from the entry

**Rule:** the vendor grouping in `vite.config.ts` lists React, Clerk and Motion
only. Do not add a package used by a single route.

**Why:** `manualChunks` is stronger than Rollup's own analysis. Naming a
route-only dependency promotes it to a shared chunk that the entry pulls in,
which is the opposite of splitting. Validation and form libraries were the
largest thing removed from the first load; a well-meant `vendor-forms` group
would put all of it back.

**How to apply:** after touching the chunk function, rebuild and confirm the
`modulepreload` links in the emitted `index.html` still list only the vendor
chunks every route needs.

## 3. Small flags shared by the router live in their own module

**Rule:** a constant the router needs must not be re-exported from a module
that also contains heavy runtime code.

**Why:** ES module imports are all-or-nothing for chunk assignment. A one-line
boolean imported from the workspace context module pulls the whole workspace
state machine, its API client, and its query wiring into the entry chunk, even
though signed-out visitors never touch it.

**How to apply:** keep such flags in a leaf module under `src/lib/` and let the
heavy module import (and re-export) it, not the other way round.

## Measuring

`vite build` reports per-chunk sizes. For a module-level breakdown, add a
temporary config that spreads the real config and appends a `generateBundle`
plugin reading `chunk.modules[*].renderedLength`, grouped by the package name
parsed out of the module id. Delete the temporary config afterwards — it is
cheap to rewrite and stale copies drift from the real config.
