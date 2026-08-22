---
name: Slime display-time modules
description: Conventions for lib/slime per-frame adjustment modules (momentum, emphasis, life) and their host pipeline order.
---

# Slime display-time modules

Rule: display-time slime adjustments compose in a fixed order in both hosts — **momentum (camera trail) → emphasis (touch) → life (droplets) → pack**. Each module takes the node stream and returns it adjusted, keyed by node id.

Conventions every module in this family follows (momentum.ts and emphasis.ts are the references):

- **Pass-through at rest**: return the *input array itself* when idle; hosts and tests rely on identity comparison.
- **Infer motion from the stream**: momentum takes no camera input — the per-frame projected positions *are* the camera signal. This covers drag, orbit, pinch, and camera reset uniformly and keeps hosts one-line integrations.
- **Absent ids are forgotten immediately** so a returning concept (released search filter, restored project) appears in place instead of flying in.
- **`frozen` = reduced motion**: the state change applies instantly (emphasis) or motion stays rigid (momentum), and stale animation state must not survive a frozen spell.
- dt-clamped stepping (`clamp(now - last, 0, 0.1)`); runtime-dependency-free `.ts` with `.test.mjs` siblings run under node type stripping.

**Why:** momentum-first ordering keeps the touch reaction tuned as designed (it operates on the trailed geometry rather than being double-smoothed), and stream-inferred motion avoided host-specific camera plumbing in two divergent projections.

**How to apply:** any new "alive" beat (bloom-in, shed, etc.) should be another module in this chain following the same contract, not host-side special cases. After adding lib/slime exports, rebuild the composite dist (`tsc -b lib/slime --force`) before typechecking the apps.
