# Venom design language

The shared contract for Venom Desktop's visual language. Read this before adding
a screen or restyling one, so surfaces stay in one dialect instead of drifting
apart page by page.

## Feeling

Modern, quiet, confident. Monochrome black and white with organic motion — a
living material, not a terminal. Reference point is Apple's own marketing and
product surfaces: generous radius, hairline borders, soft depth, restrained
type.

Explicitly not: brutalist boxes, hard offset shadows, all-caps machine chrome,
sci-fi/hacker styling.

The one loud element is the brand itself: a hand-scrawled tag (see Brand
marks). Everything around it stays quiet — the contrast is the point.

## Brand marks

Venom's identity is a hand-scrawled marker tag: an original scrawled "VENOM"
wordmark (with drips) and a raw scrawled V. Both are original artwork drawn
for this product — never traced from or imitating any existing mark, and
nothing borrowed from Tesla/Cybertruck glyphs.

Sources of truth (keep the vector paths in sync):

- `src/components/venom-wordmark.tsx` — scrawl wordmark, `currentColor`
- `src/components/venom-mark.tsx` — scrawl V, `currentColor`
- `public/favicon.svg` — white V on the black tile
- Mobile siblings: `artifacts/venom/components/VenomWordmark.tsx`,
  `artifacts/venom/components/VenomMark.tsx`, and the rendered
  icon/splash PNGs in `artifacts/venom/assets/images/`

Rules:

- **Brand moments only.** The scrawl lives where the product signs its name:
  the sidebar lockup, landing hero, auth-page lockups, the route-fallback
  pulse, not-found lockups, icons, splash, favicon. That list is close to
  exhaustive — a new scrawl placement should feel like a brand decision, not
  a styling choice.
- **Never in chrome.** Buttons, form controls, navigation labels, headings,
  body copy, and every other piece of UI text stay clean Inter/system type.
  If it says anything other than "Venom", it is not the scrawl.
- **Monochrome only.** Pure white on black or black on white via
  `currentColor`. No tints, no gradients, and never a glow utility on a
  brand mark.
- **Accessible name.** Every lockup keeps the accessible name "Venom" — the
  components default to `aria-label="Venom"` (mobile:
  `accessibilityLabel="Venom"`). The scrawl is imagery, not readable text,
  so never drop the label.
- **Scale.** The wordmark holds down to roughly 24px tall; below that use
  the V mark alone (favicon-size surfaces). Don't letter-space, stretch,
  recolour, or redraw the marks per surface.

## Typography

Apple's system stack first, Inter as the fallback for non-Apple hardware:

```
-apple-system, BlinkMacSystemFont, "SF Pro Display", "SF Pro Text", "Inter",
system-ui, sans-serif
```

On Apple hardware this renders genuine SF Pro and fetches no web font at all.
Only Inter is loaded from Google Fonts, for everyone else.

Rules:

- **No `uppercase`.** Sentence case everywhere, including labels, badges, and
  section headers. This is the single biggest source of the old blocky feel.
- **No `tracking-widest` / `tracking-wider`.** Headings get tight tracking
  (`-0.02em` on h1–h3, applied in the base layer); body text stays default.
- **No `font-black`.** Headings top out at `font-semibold`; supporting labels
  use `font-medium`.
- **Monospace is reserved for genuine machine text** — ids, hashes, logs, code.
  Never for labels, headings, or chrome. It is a system stack
  (`ui-monospace, "SF Mono", …`), not a web font.

## Radius

Base radius is `0.875rem` with a concentric scale. Nested corners step down so
the curves stay parallel.

| Token       | Size | Used for                                  |
| ----------- | ---- | ----------------------------------------- |
| `xs`        | 6px  | Tiny inline chips                         |
| `sm`        | 10px | Inputs inside a group                     |
| `md`        | 12px | Inputs, small buttons, skeletons          |
| `lg`        | 14px | Cards, panels                             |
| `xl`        | 18px | Dialogs, large cards                      |
| `2xl`       | 24px | Sheets, detail panes                      |
| `3xl`       | 32px | Mobile bottom sheets                      |
| `full`      | —    | Badges, pills, icon buttons, node labels  |

`rounded-none` is a bug outside two intentional cases: date-range middle cells
in `calendar.tsx` and grouped inputs in `input-group.tsx`, where square edges are
what makes the group read as joined.

## Surface, border, depth

- Borders are hairline: `border` with `border-border/60`. Never `border-2`.
- `.surface` applies the subtle top-to-bottom gradient that keeps large panels
  from reading as flat fills.
- `.sheen` adds the faint specular highlight along a panel's top edge. Use
  sparingly — floating chrome, not every card.
- Depth is `shadow-soft` (resting) and `shadow-lift` (floating: dialogs, detail
  panes, overlay chrome). No hard offset shadows.

## Colour

Monochrome by default. Colour is a highlight, never a fill.

- `--glow` (violet) and `--glow-2` (cyan) exist only through the gradient
  utilities `.glow-text`, `.glow-ring`, and `.glow-line`.
- **One glow per screen.** Spend it on the single most important thing on the
  page and leave everything else monochrome. Two glows on one screen means one
  of them is wrong.
- Destructive red is the only other colour, and only for destructive actions.

## Motion

Motion is organic — easing that settles rather than snaps. Transitions belong on
`opacity`, `transform`, and `filter`. Avoid animating layout properties.

## Layering

Any container whose children carry large z-indexes must establish its own
stacking context with `isolate`. Without it those values escape into the page
and paint over headers and overlays. The knowledge map is the worked example:
its nodes sort by depth in the thousands, and it is `isolate`d so they stay
under the header, the search field, and the detail pane.

## Before you ship

- No `uppercase`, `tracking-wide[r|st]`, `font-black`, `font-mono` on chrome.
- The scrawl brand marks appear only in brand moments; anything that reads as
  UI text is clean type, and every mark keeps its "Venom" accessible name.
- No `rounded-none` or `border-2` outside the two exceptions above.
- At most one glow on the screen.
- Check both themes — light mode is a cool neutral grey with pure-white cards,
  not warm bone.
- Check 390px wide as well as desktop.
