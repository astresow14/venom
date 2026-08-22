---
name: Venom desktop responsive collapse
description: How to collapse desktop chrome on phone widths without breaking Playwright strict-mode specs.
---

**Rule:** When a desktop surface collapses into a compact bar + menu below `md`, render the two variants conditionally from JS (the shared `useIsMobile` hook, which tracks `(min-width: 48rem)` — Tailwind v4 default `md`), never CSS hide/show. Move the existing controls into the menu as one shared render function so every `data-testid` and aria-label exists exactly once in the DOM at any width.

**Why:** Desktop e2e suites assert header test ids with strict-mode locators; a CSS-hidden duplicate makes those locators ambiguous and fails the suite. A shared fragment also keeps the phone menu from drifting apart from the desktop card.

**How to apply:** Bar-only affordances get new `-collapsed` test ids. Use the existing Radix Popover for the menu (focus return, Esc, `data-state` animations come free); pass an `afterSelect` callback into the shared fragment so selection closes the menu. Width via `--radix-popover-trigger-width`, height cap via `--radix-popover-content-available-height`. The Brain map header is the reference implementation.
