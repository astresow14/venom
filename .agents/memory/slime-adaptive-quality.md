---
name: Slime adaptive render quality
description: Frame-time adaptation owns the goo's render scale on both apps — what that means for captures, tests, and future rAF pacing work.
---

The slime's render scale is no longer a constant: a shared frame-time
controller (lib/slime quality module) sheds resolution on sustained misses and
sharpens on sustained headroom. Desktop resizes its canvas buffer; mobile
resizes the GLView's *layout fraction* (the expo-gl context survives a layout
resize; only the buffer is recut).

**Capture rule:** any screenshot or visual capture of the goo must pin
`?slimeScale=<v>` (alongside `?slimeTier=`) in UI-test mode. Unpinned,
SwiftShader legitimately sheds to the blur floor within seconds, so captures
come out low-res and "fixing" them by tuning constants is a trap.

**Measuring rAF pacing (applies to any future frame-budget work here):**

- rAF deltas are vsync-quantised: a 60 Hz display reports ~16.7 or ~33.3 and
  nothing between, so percentile metrics flip between "perfect" and
  "catastrophic" and a deadband is unreachable. A lightly trimmed mean turns
  miss *rate* into a smooth signal; isolated GC spikes get trimmed away.
- One giant delta is a pause (hidden tab), but a *run* of them is a real
  cadence — count it clamped, or the very slowest devices are the only ones
  adaptation ignores.
- Remember a failed scale as a recovery ceiling and probe past it slowly,
  or sharpening bounces straight back into the miss.
- On expo-gl web the 1x1 startup surface renders absurdly fast — never feed
  those frames to the controller or it "sharpens" before the surface exists.

**Test hooks:** in UI-test mode both apps publish `__venomSlime` (window /
globalThis) with `{scale, initialScale, minScale, changes, frames,
bufferWidth}`. The e2e proof pins `slimeTier=full` on the dense fixture so
SwiftShader must degrade, then asserts frames keep advancing — degrade *and*
liveness, not one or the other.
