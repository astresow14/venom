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

## 4. Styling helpers: `cx` on the critical path, `cn` behind it

**Rule:** entry-reachable modules never import `cn` from `src/lib/utils.ts` —
it pulls tailwind-merge (~102 KiB pre-minify, ~9 KiB gzip of the entry chunk
when it was there). They use the order-only `cx()` from `src/lib/cx.ts`,
which does not resolve conflicting Tailwind classes.

**Why:** none of the entry-reachable call sites (toast, tooltip) actually
produce conflicts, but components whose className API *relies* on overrides
must keep real merge semantics: Skeleton (bg-*/rounded-* overrides at ~38
call sites) and Card stay lazy instead — the 404 page is a lazy route and the
workspace route fallback uses plain divs precisely so neither re-enters the
entry graph. VenomMark supports exactly one override (its h-8/w-8 default)
by *withholding* the default when the caller sizes it (`src/lib/mark-size.ts`,
unit-tested for string parity with the old tailwind-merge cn()).

**How to apply:** before moving any component to `cx`, audit every call
site's `className` against the base classes with tailwind-merge itself — the
safety proof is "twMerge(base + caller) drops nothing". The budget gate fails
any build where tailwind-merge reaches the entry chunk again.

## 5. A `src/components/ui/*` primitive is not "already paid for"

**Rule:** before importing a ui/ primitive from Shell or anything else in the
workspace route group, check which chunk currently owns it. If it is only
reachable from deeper lazy routes (as dropdown-menu was — feed-thread only),
a static import promotes its whole Radix dependency tree into the workspace
group and fails the budget (~25 KiB gzip for dropdown-menu + roving-focus).

**Why:** the component file existing in the repo says nothing about which
route group carries its weight; chunk membership is decided by the closest
static importer.

**How to apply:** for rarely-used controls in workspace-group code, prefer an
inline disclosure built from plain buttons + `useState` (see the sidebar's
Unfiled "file into project" picker) over portal menus; it needs no new deps
and keeps keyboard focus in the list.

## Measuring and enforcement

Every production build writes `dist/bundle-composition.json` (per-chunk
module `renderedLength`, machine-independent ids) via a plugin in
`vite.config.ts` — no temporary config needed for a module-level breakdown.

Two groups are enforced by `scripts/check-bundle-budget.mjs` (runs after the
package build and in CI / local validation) against the committed
`bundle-budget.json` (measured gzip + 10% headroom):

1. **Landing critical path** — the entry chunk plus every `modulepreload`
   chunk in the built `index.html`.
2. **Workspace route group** — what signed-in users additionally download
   before their first screen: the `workspace-routes` chunk plus its static
   import closure, walked via the `imports` arrays in
   `dist/bundle-composition.json`, minus chunks already on the critical path.
   Because discovery depends on that report, a missing/stale report is now
   fatal to the check, not a degraded warning.

Failures name the package/file that grew by diffing composition against the
baseline. Accept deliberate growth with
`pnpm --filter @workspace/venom-desktop run update:bundle-budget` — never by
hand-widening a number you cannot explain. `bundle-budget.json` is generated
output: when a merge/rebase conflicts on it, do not hand-merge the numbers —
run update:bundle-budget on the merged tree so the baseline reflects both
sides' code (chunk membership can legitimately shift, e.g. a helper leaving
the entry chunk lands in the workspace group). Shrinking always passes; the check
suggests ratcheting the budget down. Dev-only plugins are gated on
`command === 'serve'` so build output is deterministic across environments —
keep it that way or local and CI measurements drift.

## 6. Lazy-splitting a panel does not remove shared-module weight

**Rule:** do not expect a dynamic import of one panel to shrink the eager
chunk when the overage comes from modules the eager chunk shares with it.

**Why:** a module shared between the eager chunk and a lazy chunk (above all
the generated API client, which grows with every merged feature) is emitted
whole in the eager chunk — chunk membership is per-module, and the union of
all importers' needs decides what the generated client contributes. The
panel's own code leaves, but its generated hooks stay behind.

**How to apply:** still lazy-load big owner-only panels (it removes their UI
code), but treat residual overage from generated-client growth as deliberate
and refresh the baseline with update:bundle-budget on the merged tree.
