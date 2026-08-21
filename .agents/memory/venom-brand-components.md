---
name: Venom brand render points
description: All Venom surfaces render the brand only via shared mark/wordmark components so rebrands swap internals, not call sites.
---

Venom is mid-rebrand toward an original hand-scrawled tag identity (raw marker strokes, monochrome; inspired by, never copying, the Cybertruck graffiti wordmark). Screens must not draw the brand ad hoc.

**Why:** The rebrand lands as a separate task. Screens that render brand text/glyphs inline would each need edits (and merge conflicts) when the scrawl assets arrive; shared components make the swap a one-file change per glyph.

**How to apply:** Render the logo glyph via the shared VenomMark component and the wordmark via the shared VenomWordmark component (both in the mobile app's components directory; wordmark supports an optional hand-swiped underline). When adding brand presence to a new surface, extend those components rather than inlining `<Text>Venom</Text>` or new SVGs. Decorative "scrawl energy" (marker strokes, slight tilts) may live in screen-level visuals, but the brand lockup itself comes only from these components.
