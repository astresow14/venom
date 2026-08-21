---
name: expo-gl web GLView needs a support probe
description: Mounting GLView on web with WebGL unavailable throws in an effect and blanks the whole app; probe first, and instrument GL prototypes to prove fallback behavior in browser tests.
---

On web, expo-gl's `GLView` acquires its context inside the shim's canvas ref
effect via an `invariant(context, ...)` — when the browser refuses every
WebGL flavour (blocklisted GPU, locked-down profile), that throw escapes to
the nearest error boundary. Because the app keeps workspace screens mounted,
the crash lands at startup and the root boundary replaces the entire app with
"Something went wrong", not just the 3D layer.

**Rule:** never mount a `GLView` on web without first probing support on a
scratch canvas (`webgl2` → `webgl` → `experimental-webgl`); release the probe
context via `WEBGL_lose_context.loseContext()` and render nothing when the
probe fails. Native always has a GL context, so only web needs the probe.

**Proving GL fallbacks in browser tests** (both clients):
- Patch `WebGLRenderingContext.prototype` *and* `WebGL2RenderingContext.prototype`
  in an `addInitScript` (expo web picks webgl2 first; desktop uses webgl1).
- Count `drawArrays` only when `!this.isContextLost()` — draws against a lost
  context are silent no-ops, and the expo-web render loop keeps running
  through a loss (only desktop stops its loop), so unguarded counters never
  stall.
- Count `linkProgram` to prove a restored context actually rebuilt the
  program: after `WEBGL_lose_context.restoreContext()`, a stale loop can
  resume "drawing" with dead handles, so rising draw counts alone do not
  prove the layer came back.
- Simulate the program-rejected path by patching `getParameter` to return a
  tiny `MAX_FRAGMENT_UNIFORM_VECTORS` (0x8dfd); the renderer's budget check
  must throw before any compile/link happens (assert links stays 0).
