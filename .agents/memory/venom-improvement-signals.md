---
name: Venom improvement signals
description: Semantics of the review-first "new data since last iteration" suggestions on portfolio apps, and how to write fixtures that test dismissal.
---

Improvement signals are computed on read (no cron, no stored suggestion rows):
a linked project's knowledge/source changes are counted since
`max(lastIterationAt, improvementSuggestionDismissedAt)`. Dismissal stores a
timestamp; it hides the current signal but genuinely newer data (later
timestamps) legitimately resurfaces the suggestion. Re-linking a project
resets the dismissal.

**Why:** review-first means the system may never auto-run anything, but it
also must not let a stale dismissal permanently mute a living data feed.

**How to apply:**
- Any new "changed since" input must be timestamped and compared against the
  same cutoff, or dismissal semantics silently diverge between data kinds.
- Test fixtures for "dismiss hides the suggestion" must place change
  timestamps AFTER the baseline iteration but BEFORE the dismissal moment.
  Future-dated fixtures (e.g. `syncedAt` ahead of now) are not a bug when they
  resurface post-dismissal — that is the intended resurface path; use them to
  test resurfacing, not hiding.
- Suggestion candidates require a linked project AND at least one registered
  iteration; apps without a baseline never signal.
