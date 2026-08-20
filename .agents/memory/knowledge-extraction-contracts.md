---
name: Knowledge extraction contracts
description: Why model-produced project knowledge is normalized before it reaches persisted state.
---

Treat JSON-only model output as untrusted and potentially incomplete even when the prompt explicitly names every required field. Normalize optional omissions, reject unknown source message IDs, bound every field, then validate the final response against the API schema.

**Why:** A live extraction response followed the requested JSON shape but omitted several required fields despite JSON-object mode and explicit prompting. Strictly rejecting the whole response made ordinary conversations fail to update the map.

**How to apply:** Any future AI-derived knowledge shape should preserve source integrity first, supply only safe deterministic defaults, discard candidates that cannot be traced to live input, and run contract validation after normalization.