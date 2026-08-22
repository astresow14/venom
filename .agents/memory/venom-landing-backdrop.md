---
name: Venom landing living backdrop
description: Constraints for the desktop landing page's slime backdrop — hero-clearing contract, pane-vs-viewport breakpoints, stacking, and e2e gotchas.
---

# Venom landing living backdrop

- **The stage is the pane, not the viewport.** The landing canvas spans the right pane (the md+ sidebar eats ~200px of the window), so the canvas can be narrower than the page's breakpoint: an 800px-wide window renders the desktop hero layout on a ~593px stage. Any composition clearing keyed off stage width must **union both hero placements** (top-anchored md layout and phone-centered layout) on narrow stages.
- **The hero clearing is a tested contract**, not a runtime clamp: the landing-organism unit sweep (several stage shapes × ~5 minutes of clock) fails if any node or strand enters the ellipse. When it fails, tune the composition constants (or the zone), never loosen the sweep. The first draft genuinely intruded on mid-width (~820px) stages — hand-checking a few sizes is not enough.
- **Composition is a pure function of (size, time)**: reduced motion pins the clock to 0 and gets the identical sculpture held still, which is what makes the e2e field-checksum stillness assertion possible.
- **Stacking**: the pane is `relative isolate` and the canvas `-z-10` — above the root background, below the pane's in-flow header/main. Without `isolate`, a negative-z canvas falls behind ancestor div backgrounds and silently disappears.
- **Buffer coverage ≠ compositing.** readPixels coverage proves the GL layer drew, not that users see it — stacking/opacity bugs pass that check. The proof is a composited screenshot taken after the idle mount + fade-in (both of which outlast quick screenshot tools).
- **Landing e2e in the plain UI-test suite works signed-out** (Clerk resolves and `Show when="signed-out"` renders the hero). The composer has no testid — locate it with `getByLabel('Ask Venom')` (`#landing-prompt`). The canvas mounts on requestIdleCallback, so existence waits need generous timeouts.
- **Pointer host wiring**: window-level pointer listeners with a cached canvas-rect offset; touch (`pointerType !== 'mouse'`) clears the target on up/cancel so touches are momentary attractors; `documentElement` mouseleave + window blur clear it for mice. The canvas itself stays `pointer-events-none` — input inertness is part of the page contract.

**Why:** the clearing exists so the wordmark reveal and composer always sit on near-black; the pane/viewport mismatch and mid-width intrusions were real bugs caught only by the sweep + composited screenshots.

**How to apply:** any change to the landing composition, hero layout (breakpoints, hero position), or sidebar width must re-run the organism sweep and re-judge a composited screenshot at both a wide and a portrait-desktop size.
