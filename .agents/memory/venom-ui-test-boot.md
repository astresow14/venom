---
name: Venom mobile UI-test boot contract
description: How UI-test mode boots fast — Clerk gate bypassed, GL deferred, slimeTier=off — and the invariants that keep that safe.
---

In UI-test mode (`venomUiTest=true`) the mobile app boots without waiting on
anything remote, which is what keeps the per-test floor near ~1.5–2s:

- **Clerk gate bypass:** `RootLayout` renders the app tree directly inside
  `ClerkProvider` instead of behind `ClerkLoading`/`ClerkLoaded`. clerk-js
  still loads live in the background so hooks resolve later; the UI-test auth
  layer supplies the placeholder user and a null token getter.
  **Why:** the loaded gate held every test's first paint on clerk-js network
  fetches — pure wait, no assertion value.
  **Invariant:** no component may gate rendering on Clerk `isLoaded` /
  `useAuth().isLoaded` — in UI-test mode that state can arrive seconds late or
  never; read user objects null-safely instead. Signed-out auth specs opt out
  with `venomUiTest=false` (they need the real gate), and the live-auth suite
  covers real credentials.

- **GL deferral (product behavior, not test-only):** `SymbioteSlime` mounts on
  the first Brain-tab activation (latched, stays mounted after), so app boot
  never creates a WebGL context. Brain specs pay context+compile at tab-click;
  their existing aria waits absorb it.

- **`slimeTier=off` (UI-test only):** skips mounting the slime entirely.
  WebGL-unavailable is a supported product state with an identical map
  contract, so any brain spec that never asserts the goo layer
  (camera/citations/search/panels/network) should carry it. Goo specs
  (slime-adaptive, slime-fallback, brain-slime-tiers, slime-shader) must not.

**How to apply:** new specs default to `venomUiTest=true&slimeTier=off` unless
they assert the goo; never add an `isLoaded` render gate; if a future feature
truly needs loaded Clerk before paint, gate it per-surface, not in the root
layout.
