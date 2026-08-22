---
name: Venom debate settlement
description: What "settled" means for a debate round, how the Brain absorbs it, and why speaker-attributed turns are filtered from every extraction window.
---

## Rule
A debate contributes to the knowledge map only through its **settled conclusion**: the round's closing turn — the last planned turn (`index === plannedTurns - 1`), the one the server's plan hands the favored voice to "land the final word" — finishing `ok` with content, in a round that ended cleanly (`done` received, not user-stopped, not failed, no interjection-triggered restart pending). Extraction then runs like an ordinary answer: the closing turn is the assistant message, anchored to its persisted message id, alongside the initiating user message and interjections.

Additionally, **speaker-attributed messages (`speakerId` set) are filtered out of every knowledge-extraction context window in both clients** — the debate capture and ordinary Talk/Verify captures alike.

**Why:** Raw mid-debate sparring is argument, not settled knowledge; absorbing it pollutes the map. But leaving debates entirely invisible meant a debate that converged left no trace while a Talk answer with the same insight did. The closing turn is the plan's designated conclusion, so it is the safe "settled" signal; truncated rounds (budget ran out) never run it and thus never qualify. The context filter matters because persisted debate turns would otherwise leak into *later* turns' extraction windows and pollute the map anyway.

**How to apply:**
- Any new extraction call site (either client, any mode) must exclude `speakerId`-bearing messages from its context window.
- Settlement is decided client-side purely from the SSE contract (`of`, turn `index`, `turnStatus`, `done`) — no server signal exists or is needed.
- On mobile, the stop/pending-interjection flags are wiped by the shared `finally` cleanup **before** the extraction gate runs; capture them into consts first (same trap as the closure-snapshot casts TS needs there).
- On desktop, a restart hands settlement to the successor round; the recursive round invocation means only the last round's completion block may extract, and `abortController.signal.aborted` guards the stop-raced-with-done edge.
- Both clients cap the payload at the schema max (48 messages): build the tail (user message + interjections + conclusion) first, then fill with filtered context.
