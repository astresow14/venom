---
name: Scrawl brand vector pipeline
description: How to turn AI-generated marker/graffiti raster art into clean brand SVGs locally; Quiver limits that make it necessary.
---

Rule: to vectorize generated raster art (marker tags, scrawl wordmarks), trace locally with the npm `potrace` package instead of remote vectorization.

**Why:** QuiverAI `/svgs/generations` 504s on multi-letter wordmark prompts (single letters work), and `/svgs/vectorizations` rejects `data:` URLs (400) — retrying cannot help. Local potrace (threshold ~140, turdSize 60-80, optTolerance 0.4) produced faithful single-path SVGs from high-res black-on-white rasters.

**How to apply:**
- Generate the art black-on-white at high resolution, then trace: `potrace.trace(file, { threshold: 140, turdSize: 80 }, ...)`.
- Post-process: round path decimals to 1 place (regex on the `d` string) to halve size; potrace emits `fill-rule="evenodd"` — keep it when embedding.
- Tight viewBox: `magick -background none out.svg -trim info:` gives the content box in viewBox units (render is 1:1 at 1024).
- Verify legibility by rendering at target sizes (16px favicon, ~36px header) on black and white before wiring into components.
- Wide lockup compositions (aspect ≥3) are worth an extra generation pass: square-ish tags don't fit header/sidebar slots.
