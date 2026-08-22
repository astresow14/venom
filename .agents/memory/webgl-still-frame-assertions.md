---
name: WebGL still-frame assertions in e2e
description: How to read back a non-preserved WebGL drawing buffer from Playwright and assert "the layer rendered" without pixel diffing.
---

Browser tests can prove a WebGL layer actually put pixels on screen — cheaply,
even on SwiftShader — by reading the drawing buffer back and measuring alpha
coverage, instead of screenshot diffing.

**Readback timing (the non-obvious part):** buffers without
`preserveDrawingBuffer` are cleared after compositing, so `readPixels` from a
plain `evaluate` reads zeros. But rAF callbacks run in registration order, and
a self-re-arming render loop registers its next callback at the end of every
draw. A callback registered from `evaluate` between frames therefore lands
*after* the app's pending one: it runs in the next frame, right after that
frame's draw, while the pixels are still in the buffer. `readPixels` there is
reliable — no `preserveDrawingBuffer` shim, no screenshot.

Call `getContext` with each webgl flavour in turn to recover the existing
context (a mismatched type returns null, a matching one returns the live
context; attributes are ignored on repeat calls).

**Assertion shape:** count pixels with alpha above a small floor and assert
the covered fraction sits in a band — above ~1–2% (blank canvas reads 0) and
below ~98% (an opaque-everywhere buffer or a shader spraying the full surface
reads ~1; both are broken). Never assert exact pixels: SwiftShader, scale
pinning, and sim time all move them.

**Making the pin loud:** a silently ignored tier/quality override falls back
to device detection and the check proves nothing. Expose what was actually
compiled (capacity tier, packed droplet count) in the UI-test telemetry and
assert it equals the pinned request. On Venom both slime hosts publish this on
`__venomSlime`.

**Cost:** pin the render scale low (~0.3) — stills need pixels, not
resolution. Full/medium/compact tier stills on both apps run ~25s desktop,
~70s mobile, total, so tier coverage fits the ordinary suites.
