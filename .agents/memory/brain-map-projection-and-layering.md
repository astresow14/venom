---
name: Knowledge map projection and layering
description: Two recurring bugs in the brain map — escaped stacking context, and a projection that is neither centred nor fitted.
---

## Depth-sorted nodes need an isolated container

The map sorts nodes by depth by writing z-indexes in the thousands onto each
node button. If the scroll container is `relative` with `z-auto` it creates **no
stacking context**, so those values escape into the page's root context and the
nodes paint over the header, the search field, and the detail pane.

**Why:** `position: relative` alone does not open a stacking context; only an
explicit `z-index`, `isolation: isolate`, transforms, filters, etc. do.

**How to apply:** any container whose children carry large computed z-indexes
gets `isolate`. Chrome that must float above those nodes then needs a z-index
above the node ceiling *within that same container* — competing with the outer
page is the wrong fix. Also note an inline `style.zIndex` always beats a
Tailwind `z-*` class, so `hover:z-[9999]` next to an inline z-index is dead code.

## Project relative to the constellation's own centre, and fit it

Two independent geometry bugs produced clipped nodes and labels:

1. Cluster world coordinates are **not centred on the origin**. Orbiting around
   the origin therefore swings the whole map off to one side. Orbit the
   bounding-box midpoint of the visible clusters instead — the midpoint, not the
   mean, so one dense corner cannot drag the map sideways.
2. The world spread was a **fixed multiplier independent of viewport**, so on a
   narrow container the outer nodes and their labels landed past the edge and
   were cut off by `overflow-hidden`.

**How to apply:** scale the spread by the smaller of `width/reference` and
`height/reference`, clamped to a floor and to 1 so large viewports are
unaffected. Verify at 390px wide, not just desktop — and remember labels extend
well past their node, so a node inside the bounds is not proof its label is.
