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

## Empty chat contract
The empty chat state is the full VENOM wordmark (shared `VenomWordmark`, not the V mark) and the composer, nothing else — no greeting heading, no subtitle, no starter-prompt chips (removed deliberately Aug 2026; the host wants that space reserved for future *algorithmic* recommendations, not canned prompts).
**Why:** the host asked for "venom logo and just a chat window" and later upgraded the mark to the full wordmark to match the Claude-style minimal composer; the old gradient greeting also violated the monochrome language.
**How to apply:** do not reintroduce starter chips or greeting copy in chat.tsx's empty state. The page heading is sr-only (`<h1>Chat</h1>`, pinned by a chat-shell spec assertion) because the visible page is deliberately chrome-light — same pattern as the auth welcome heading.

## Composer footer contract (Aug 2026)
The composer footer carries exactly two controls: one Select-model pill (opens the combined models & voices dialog) and a Debate switch. Verify is not a composer control — it lives inside the model dialog as a switch, gated on deliberation availability. No settings gear, no separate Voices button.
**Why:** the host wants a Claude-style minimal composer; three-way Talk/Verify/Debate chips read as clutter, and Verify is model configuration, not a per-message choice.
**How to apply:** mode stays the tri-state `ResponseMode` on the conversation (wire format untouched); the composer switch toggles debate↔talk, the dialog switch toggles verify↔talk, and both switches rest while a reply is in flight (the running turn already captured its mode). The old three-way mode chips and the separate Voices/gear entry points are retired.
