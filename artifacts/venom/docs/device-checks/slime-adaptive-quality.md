# Device check — adaptive goo resolution on the living map

The slime layer adapts its render resolution to the measured frame cadence
(`lib/slime/src/quality.ts`). On iOS/Android the adaptation resizes the
GLView's *layout fraction*, which reallocates the renderbuffer — a path no
browser test can exercise, because the web shim resizes a canvas buffer
instead. This note records what is already proven, what only hardware can
prove, and the findings from real devices.

## Already proven in browsers (both apps' Playwright suites)

- Under a software rasterizer (SwiftShader standing in for a slow GPU), the
  controller sheds the surface fraction instead of letting the map stutter,
  and frames keep advancing at the smaller surface
  (`artifacts/venom/e2e/slime-adaptive.spec.ts`).
- A pinned fraction (`?slimeScale=`) stays fixed — captures are
  deterministic.
- The shed fraction reaches the actual drawing buffer (the GLView lays out
  smaller and the buffer shrinks with it).

## What only a real phone can prove

1. **Seamless resize.** On native the layout resize recuts the renderbuffer.
   Is that visually seamless — no flash, blank frame, or flicker as the
   buffer is reallocated?
2. **Sharpening.** With real GPU headroom the fraction should climb from its
   0.5 start toward the pixel-ratio-derived ceiling `min(1, 1.6 / dpr)`
   (`surfaceBounds()` in `artifacts/venom/components/SymbioteSlime.tsx`).
3. **Stability.** A weak phone should settle at a reduced fraction (resize
   counter goes quiet) rather than oscillating. Slow, occasional probe-up
   cycles are by design (the failure ceiling relaxes ~2% per healthy
   window); continuous bouncing is not.

### Expected ceilings by device pixel ratio

| dpr | ceiling = min(1, 1.6/dpr) | start | what sharpening looks like |
| --- | --- | --- | --- |
| 2.0 | 0.800 | 0.500 | clear climb 0.5 → 0.8 |
| 2.6 | 0.615 | 0.500 | modest climb |
| 3.0 | 0.533 | 0.500 | small climb, then parked at ceiling |
| ≥3.2 | < 0.500 | clamped to ceiling | starts *at* ceiling; only shedding + recovery are observable |

On dpr ≥ 3.2 phones the fraction can never exceed 0.5 by design — "parked at
its ceiling" is the pass signal there, not "above 0.5".

## How to run the check (dev builds / Expo Go only)

1. Start the Venom Expo workflow and open the app on the phone via Expo Go
   (scan the QR from the Venom artifact preview) or a dev build.
2. Sign in, open the **Brain** tab. A denser map stresses the goo harder;
   any map works for the sharpen/flicker observations.
3. Tap **Goo stats** (bottom-left of the map, dev builds only). The panel
   shows, sampled ~2×/second of shaded time:
   - `surface` — live layout fraction, plus session `peak` and `pinned` flag
   - `floor` / `ceiling` — this device's adaptation bounds
   - `buffer` — drawing-buffer pixels and raw shaded-frame `fps`
   - `resizes` — how many times the surface was recut, and how long ago
4. Watch for ~60–90 seconds: the fraction settling, the goo during resize
   moments (any flash/flicker?), and whether the resize counter goes quiet.

The HUD exists only in dev builds (`__DEV__`); production builds never
include it. On web it appears only under `?slimeHud=1` in UI-test mode, so
browser captures stay clean (`artifacts/venom/e2e/slime-hud.spec.ts` proves
the readout and its absence).

## Findings

No real-device run was completed for this check. The requested phone
observation was offered through the app workflow but declined, so native
renderbuffer behavior remains unverified. In particular, this task does not
claim that layout-fraction changes are flicker-free, that a capable phone
reaches its ceiling, or that a weak phone settles without oscillation.

| Date | Device (dpr) | Peak vs ceiling | Resize flicker? | Settled? | Notes |
| --- | --- | --- | --- | --- | --- |
| 2026-08-21 | Not run | Not observed | Not observed | Not observed | Hardware check declined; browser coverage is green. |

## If the layout-resize path flickers on native

The fix direction (per the adaptive-quality plan): keep the GLView's layout
**fixed** at the maximum fraction and adapt only the *rendered* area —
`gl.viewport`/`gl.scissor` to a sub-rectangle of the persistent buffer, with
the raymarch's resolution uniforms tracking the sub-rect. The renderbuffer
is then never reallocated mid-animation; the upscale happens inside the
fragment shader's sampling instead of the view transform. Costs: the buffer
permanently holds max-fraction memory, and the shader must not shade the
dead margin (scissor handles that), so shed cost still falls quadratically.
