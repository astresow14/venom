---
name: expo-gl GLView surface sizing
description: On web, expo-gl hands over a 1x1 drawing buffer at context creation; read the buffer size every frame instead of once.
---

# expo-gl GLView surface sizing

`onContextCreate` on react-native-web fires **before** the canvas has been laid
out. `gl.drawingBufferWidth` / `drawingBufferHeight` are `1` at that moment and
only reach their real values a few frames later, once layout and device pixel
ratio have been applied.

**Rule:** never capture the drawing buffer size (or anything derived from it,
such as a world-units-to-pixel scale) once inside `onContextCreate`. Read it at
the top of every frame, and re-run `viewport` / resize work when it changes.
Skip drawing entirely while the surface is still 1x1.

**Why:** a size captured at context creation silently bakes in a 1x1 surface.
Nothing throws — the program compiles, uniforms upload, the loop runs — so it
looks identical to "the shader draws nothing," and the natural response is to
tune constants that were never the problem.

**How to apply:** any `GLView` / `onContextCreate` work that must run on both
native and web. Native reports the correct size immediately, so this stays
invisible until the web path is exercised.

**Lifecycle rule:** after a GL context becomes live (including resume), do one
real draw before deferring later work through animation frames.

**Why:** on the Expo web bridge, an extra first-frame delay can leave a context
attached to its pre-layout buffer while a responsive surface changes size. The
quality controller then adapts correctly, but the buffer does not follow.

**How to apply:** reset cadence on resume, make one immediate draw, then use
the normal frame scheduler for subsequent work. Keep pause responsible for
stopping the scheduled work.

When a GL layer renders nothing, force the output colour to something garish
before tuning anything else. It separates "not rendering at all" from
"rendering too subtly" in one pass.

Related: `gl.endFrameEXP` exists only on native; guard it with `?.()` so the web
shim does not throw.
