---
name: Software GL raster budget
description: Software rasterizers need their own sparse shader tier, detected by renderer label — uniform budget says nothing about raster speed.
---

Uniform budget (MAX_FRAGMENT_UNIFORM_VECTORS) does not predict raster
throughput. SwiftShader/llvmpipe report generous limits, then run a dense
per-pixel SDF shader at ~1fps — and headless Chromium (Playwright, CI,
screenshots) is always SwiftShader, so a shader that is fine on real GPUs can
freeze every browser test.

**Symptoms:** e2e clicks hang on "visible, enabled and stable", CDP sessions
die, pages stop answering evals. Looks like an app deadlock; it is a 1fps
render loop. Diagnose with a rAF counter sampled once a second.

**Rule:** any always-on shader density increase needs a rasterizer check, not
just a uniform-budget check. Detect software GL from the renderer label
(unmasked via WEBGL_debug_renderer_info, fall back to gl.RENDERER) and pin it
to a tier whose cost matches the last configuration that stayed responsive
under SwiftShader. Unknown/empty labels count as hardware — a false positive
strips the visual for capable machines.

**Compile is not the whale:** SwiftShader compiles+links all four slime tiers
cold in ~200ms (measured per-tier in fresh contexts). The seconds-long GL
specs are paying **per-frame rasterization** — cost scales with tier density ×
buffer area, and specs that wait for N frames pay N × frame cost. So budget
levers are: pin a cheaper rich tier when the assertion only needs "a rich tier
sheds/pins" (medium proves what full proves), keep frame-count waits minimal,
shrink pinned capture fractions, and skip mounting GL entirely for specs that
never assert the goo. Don't chase shader-cache warming — it saves ~nothing.

**Suite-wide boot cost:** creating a SwiftShader context + first compile per
page load is small but nonzero; mounting the GL layer lazily (first activation
of the hosting tab) removes it from every test that never opens that tab.

**Zero-capacity trap:** GLSL ES 1.00 forbids zero-sized arrays. A tier that
sets some population to 0 must omit that uniform array and its loop from the
generated source; emitting `uDrops[0]` fails compilation and the host's
fallback quietly replaces the goo with the plain map — for exactly the
devices the tier was built for. Render-agnostic e2e stays green through that
failure, so keep a browser test that compiles and links every tier's
generated source.
