---
name: Screen-space SDF overlay on an existing 2D layout
description: How to add a GPU raymarched layer under an existing laid-out UI without duplicating or touching its camera math.
---

# Screen-space SDF overlay on an existing 2D layout

To add a raymarched/GPU layer beneath UI that already computes its own layout
(an orbiting graph, a map, a chart), do **not** rebuild the camera in the
shader. Instead:

- March rays with an **orthographic** projection directly in the host's own
  pixel space.
- Have the host hand over positions it has **already projected**, plus a depth
  value and a radius.
- The shader converts nothing. One scalar — target pixels per host unit —
  covers the drawing-buffer conversion.

**Why:** the overlay then tracks orbit, zoom, and drag for free, because it is
consuming the same numbers the DOM/native nodes are positioned with. Any attempt
to re-derive a perspective camera in the shader has to be kept in sync with the
host's projection forever, and drifts the moment either side is tuned.

**How to apply:** when asked to make an existing visualization feel physical
(goo, fluid, glow, volumetrics) rather than to build a new 3D scene. It also
avoids pulling in three.js/R3F for what is one fullscreen triangle.

## Practical constraints that came out of it

- Size-like uniforms expressed in **drawing-buffer pixels** (fusion/smoothing
  distance, thickness) must be multiplied by the render scale, or a downscaled
  surface over-merges relative to a full-resolution one.
- GLSL ES 1.00 forbids dynamic indexing of uniform arrays. Precompute link
  endpoints into parallel arrays on the CPU rather than storing index pairs, so
  the shader only ever indexes by loop counter. One source then runs on WebGL1,
  WebGL2, and expo-gl.
- Downscale the surface and scale it back up for cost control; raymarching is
  per-pixel and a 3x pixel ratio costs 9x.
- Pure black goo on a near-black stage is invisible as mass. The form has to be
  carried by rim light and specular highlights, not by the body colour.
- Removing an older static "fake" version of the same effect matters — leaving
  both makes the real one look like clutter and hides whether it works.
