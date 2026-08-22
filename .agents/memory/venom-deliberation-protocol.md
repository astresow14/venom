---
name: Venom deliberation SSE protocol
description: The cross-client event contract for multi-voice deliberated chat turns and the rules that keep voice output out of the main answer.
---

A deliberated chat turn extends the ordinary respond stream with a fixed event vocabulary that server and both clients must agree on:

1. meta event carries `deliberation.voices` (roster: voiceId/name/tagline/modelId/modelName) alongside the usual modelId/modelName;
2. `{voice, content}` chunks stream each voice's take; `{voice, voiceStatus: "ok"|"failed"}` closes a voice;
3. `{stage: "synthesis"}` marks convergence; plain `{content}` chunks after it are the collective answer;
4. a final `{deliberation: {voices, disagreements}}` snapshot is what gets persisted; `{done: true}` ends the turn.

**Rules that must hold when editing any of the three sides:**
- Roster vs final snapshot are distinguished by the presence of the `disagreements` array, not by ordering — keep that invariant or old clients misparse.
- Client SSE handlers must consume `voice`-tagged chunks *before* the generic `content` branch and return early, or voice text leaks into the main answer.
- Transient deliberation state (roster, streaming takes, stage) stays separate from persisted messages; the persisted `deliberation` field comes from the final snapshot, with a client-side fallback built from accumulated takes — the fallback persists only when the stream ended cleanly (`done` arrived) without the snapshot. A hard drop with no `done` keeps the ordinary interrupted error treatment and deliberately discards the takes (mobile e2e pins both behaviors).
- Both clients' cross-device merges pass whole message objects by id, so new message fields like `deliberation` survive sync without merge changes — but verify this again if the merge ever becomes field-by-field.
- Deliberation availability is a separate GET endpoint; clients hide the composer control whenever that query errors (retry: false), which is what keeps older servers and old test stubs working.
- Every voice pass and the synthesis pass route through the same citation stream filter as ordinary turns; clients resolve `[source:id]` markers in takes/disagreements at render time, never strip them at write time.

**Debate turns reuse the same stream with a parallel vocabulary:** meta carries `debate.voices` + planned `turns`; each turn opens with `{debateTurn: {index, of, voiceId, name, modelId, modelName}}`, streams `{turn: index, content}` chunks, and closes with `{turn, turnStatus: "ok"|"failed"}` before `{done}`. The same consume-before-the-content-branch rule applies to `turn`-tagged chunks. Finished turns persist immediately as speaker-attributed assistant messages (speakerId/speakerName, model fields only when real), so old clients render them as plain replies. A user interjection or restart cancels the stream at a turn boundary and replays history with persisted turns as *plain* assistant messages (no name prefixes) plus interjections as user messages — the server re-attributes voices itself. Blend weights ride the request (`mode` + `blend`), never the stream; Talk requests must stay byte-identical (no `mode` key at all).

**Why:** the contract spans one server pipeline and two independently-shipped clients; each rule above failed (or nearly failed) once during implementation — voice chunks polluting `fullContent`, TS closure narrowing hiding accumulator writes, and old e2e suites breaking until availability became silently hideable.

**Timing budgets were validated against live providers with comfortable headroom — don't tune them from intuition.**
**Why:** the per-voice and per-turn caps were guesses until measured on real providers; measured runs showed real but bounded headroom, so shrinking or growing them without fresh measurements is churn.
**How to apply:** re-measure on live providers (wrap `emit` to timestamp events) before touching DELIBERATION_VOICE_TIMEOUT_MS or the route's RESPOND_TIMEOUT_MS.
