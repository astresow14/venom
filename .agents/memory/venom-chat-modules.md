---
name: Venom mobile chat modules
description: The chat screen is composed modules; per-mode SSE handlers are the isolation seam and their dispatch order is a behavioral contract
---

The mobile chat screen is composed modules with per-mode SSE stream handlers as the isolation seam. Two durable contracts:

1. **Handler dispatch order and consume/fall-through behavior are load-bearing.** Some events must stop processing in their mode's handler while others must keep falling through so attribution or content riding the same event still lands. Treat the existing order as intentional — reordering handlers or adding an early return leaks one mode's text into another's UI or silently drops attribution.

2. **Talk requests stay byte-identical on the wire.** Talk mode deliberately omits optional keys; adding always-present keys is a wire-format change, not a cosmetic one.

**How to apply:** change a response mode inside its own handler; touch the shared send loop only when the shared envelope (errors, completion, persistence) changes, and keep code moves verbatim so semantic merges track across concurrent chat tasks.
