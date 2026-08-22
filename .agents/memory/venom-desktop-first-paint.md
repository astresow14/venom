---
name: Venom desktop first paint
description: How to measure venom-desktop first-paint honestly, and why its fonts are self-hosted subsets instead of a Google Fonts @import.
---

**Rules:**
- Never reintroduce a remote CSS `@import` (e.g. Google Fonts) into the desktop stylesheet: it serializes a third-party round trip into the render-blocking chain, so nothing paints until that origin answers. Fonts are self-hosted as the exact per-script variable woff2 subsets Google serves, with `unicode-range` (browsers download only the scripts rendered, typically latin) and `font-display: swap` (no invisible-text period). Apple hardware resolves `-apple-system` first and never fetches them.
- On the landing page, first-contentful-paint is dominated by Clerk's remote accounts.dev bundles (~700ms+ even unthrottled, run-to-run noise of hundreds of ms). Judge CSS/font changes by `first-paint` and by the structure of the render-blocking request chain, not by FCP.

**Why:** Removing the fonts.googleapis.com @import cut the throttled (150ms RTT / 1.6Mbps) first paint from ~1136ms to ~948ms — one whole third-party RTT — while FCP stayed Clerk-noise-bound. A well-meaning "just use Google Fonts" edit would silently give that back.

**How to apply:** Measure with Playwright (resolve `@playwright/test` via `createRequire` from the venom-desktop package; system chromium via `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH`), fresh context per run, optional CDP `Network.emulateNetworkConditions`, then read `performance.getEntriesByType('paint'|'resource')` and `document.fonts`. Serve the production build with `PORT=<port> BASE_PATH=/ pnpm run serve`; dev mode behaves differently. Vite emits the woff2 URLs base-aware from the relative `url("./assets/fonts/…")` refs in src/index.css. For an honest paired A/B of a CSS-only change, serve one build and swap the stylesheet asset's bytes in place between runs (JS chunks are unaffected, so screenshots should byte-match).

**Stylesheet weight rules (the CSS file is the render-blocking chain):**
- Tailwind emits ONE global stylesheet from every file its scanner sees. A src component nothing imports still ships all its classes as CSS even though Rollup drops its JS — dead UI files' entire production cost is stylesheet bytes, so deleting them is a first-paint fix, not just hygiene (26 dead shadcn components were ~21% of the sheet).
- Vite already esbuild-minifies emitted CSS; the Tailwind plugin's build-time Lightning CSS pass (`tailwindcss()` default — never pass `optimize: false`) adds only ~2%. Real wins come from what the scanner sees, not from minification.
- `@import "tailwindcss" source("./")` in src/index.css scopes scanning to src/; without it, class-like strings in e2e specs and docs ship as CSS. Explicit `@source` directives (e.g. Clerk's) stay additive.
- The Clerk shadcn theme is not a CSS payload: `@clerk/themes/shadcn.css` is just `@source "./shadcn.js"`, a ~2 kB theme object contributing a handful of utility classes. Don't hunt it for bytes, and don't drop it — SignIn/SignUp render through it.
