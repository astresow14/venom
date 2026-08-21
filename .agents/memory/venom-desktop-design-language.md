---
name: Venom Desktop design language
description: Where the shared visual contract lives, and why the "blocky" complaint was never about radius alone.
---

The written contract lives at `artifacts/venom-desktop/design-language.md`. Read
it before restyling anything; it is the single source of truth handed to every
subagent doing a visual sweep.

## Blockiness is four things, not one

A complaint that the UI looks "blocky" or "rigid" is almost never just square
corners. It is the combination of:

1. `uppercase`
2. monospace or display fonts used for chrome
3. wide letter-spacing (`tracking-widest`)
4. square corners and `border-2`

**Why:** fixing only the radius leaves the interface looking exactly as harsh,
because all-caps mono at wide tracking reads as machine chrome regardless of how
round the container is. Sweeping all four together is what actually changes the
feeling.

**How to apply:** grep for `rounded-none`, `uppercase`, `tracking-wide[r|st]`,
`font-mono`, `font-black`, and `border-2` together as one checklist.

## Centralize tokens before fanning out subagents

When the user gives explicit art direction, the main agent must land the token
foundation (fonts, radius scale, shadows, colour vars, shared utility classes)
*first*, then hand subagents a written contract for the mechanical sweep.

**Why:** the design skill normally lets a subagent invent the visual language.
With four subagents working in parallel and no shared contract, you get four
dialects that then have to be reconciled by hand.

**How to apply:** forbid subagents from changing literal JSX text, `data-testid`,
or `aria-label` — only CSS classes. Browser tests match DOM text, not
CSS-transformed text, so restyling `uppercase` away is safe but rewriting the
string is not.

## Subagent sweeps leave codemod scripts behind

Sweep subagents tend to write throwaway codemod scripts (`fix_*.js`,
`update_styles.py`) at the repo root and not clean them up. Check `git status`
for untracked junk at the root after any parallel sweep.
