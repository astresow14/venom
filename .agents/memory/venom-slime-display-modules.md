---
name: Slime display-time modules
description: Conventions for lib/slime per-frame adjustment modules (momentum, emphasis, life) and their host pipeline order.
---

# Slime display-time modules

Rule: display-time slime adjustments compose in a fixed order in every host — **momentum (camera trail) → emphasis (touch) → pointer (cursor attractor) → life (droplets) → pack**. Each module takes the node stream and returns it adjusted, keyed by node id. Hosts skip modules they don't need (the map hosts don't use pointer; the landing host doesn't use momentum/emphasis).

Conventions every module in this family follows (momentum.ts and emphasis.ts are the references):

- **Pass-through at rest**: return the *input array itself* when idle; hosts and tests rely on identity comparison.
- **Infer motion from the stream**: momentum takes no camera input — the per-frame projected positions *are* the camera signal. This covers drag, orbit, pinch, and camera reset uniformly and keeps hosts one-line integrations.
- **Absent ids are forgotten immediately** so a returning concept (released search filter, restored project) appears in place instead of flying in.
- **`frozen` = reduced motion**: the state change applies instantly (emphasis) or motion stays rigid (momentum), and stale animation state must not survive a frozen spell.
- dt-clamped stepping (`clamp(now - last, 0, 0.1)`); runtime-dependency-free `.ts` with `.test.mjs` siblings run under node type stripping.
- **Pointer specifics**: the target is nullable (null = pointer gone → presence eases out); the smoothed position snaps on first sighting and lags viscously after; `reach()` *prepends* pseudopod tendril droplets, so hosts must reserve headroom (`maxDroplets = capacity.drops − SLIME_POINTER_TENDRIL_DROPS`) or the packer truncates the tendril at full colonies; frozen resets presence so a reduced-motion spell never leaves stale attraction behind.

**Why:** momentum-first ordering keeps the touch reaction tuned as designed (it operates on the trailed geometry rather than being double-smoothed), and stream-inferred motion avoided host-specific camera plumbing in two divergent projections.

**How to apply:** any new "alive" beat (bloom-in, shed, etc.) should be another module in this chain following the same contract, not host-side special cases. lib/slime is source-exported (`./src/index.ts`, no build step), so new exports are visible to app typechecks immediately — no dist rebuild involved.
