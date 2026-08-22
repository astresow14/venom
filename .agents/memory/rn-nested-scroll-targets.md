---
name: RN nested scroll targets
description: Scrolling a ScrollView to a row nested inside cards requires summing parent-relative onLayout offsets, with a stale-id fallback.
---

React Native `onLayout` reports `layout.y` relative to the direct parent, not the scroll content. To scroll to a row nested inside a card (row → list container → card → scroll content), record each level's offset in refs and sum them; every `onLayout` at every level retries the pending scroll until all needed offsets exist.

**Why:** A single offset map keyed by the row cannot work — the row's y is measured inside its list container, so the scroll lands near the top of the wrong card. And if the requested id no longer exists (e.g. a refresh retired the citation), the pending scroll never resolves and the jump silently does nothing.

**How to apply:** When deepening a "jump to X" feature to a nested target: keep one offsets ref per nesting level, resolve the target as the sum, and validate the deep id against current data (via a render-updated ref) inside the resolver — falling back to the enclosing card's offset when the deep id is unknown, so the jump still lands somewhere sensible. Mark the deep target only when its enclosing card is also the highlighted one.
