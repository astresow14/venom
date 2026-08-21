---
name: Stale sibling specs after merges
description: When completion validation fails in a package your diff cannot touch, check whether a freshly merged task deliberately removed the behavior that spec asserts.
---

A merged task can change a product contract (e.g. move a client-side runner to the server) and adapt *its own* specs while leaving a sibling spec asserting the removed behavior. Main then fails deterministically for every task that validates afterward, and the failure looks like a mysterious regression in an unrelated package.

**Why:** validation runs the whole repo's suites on your branch after auto-merges; a red spec someone else left behind becomes your gate.

**How to apply:**
- First bound the blast radius: confirm the failing package has no dependency edge to your diff (imports, package.json), so you know it is baseline.
- Then `git log` the feature files the failing spec exercises. If a recent merge's message says the asserted behavior was deliberately removed/moved, the fix is aligning the stale spec with the new contract — mirror how that merge rewrote its own specs (same phrasing, same "give a regression a window to betray itself" waits), not debugging your change or skipping validation.
- Deterministic-in-isolation failure (not just under full-suite load) is the tell that it is contract drift, not flake.
