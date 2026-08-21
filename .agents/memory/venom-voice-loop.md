---
name: Venom hands-free voice loop
description: Session lifecycle, speech chunking, and transcript-handoff rules for the mobile voice conversation mode.
---

# Venom hands-free voice loop

Client orchestrates the whole turn: mic capture (platform adapter) → transcribe
endpoint → the same project-scoped respond SSE text chat uses → sentence-chunked
speak SSE (base64 pcm16) → gapless playback → auto-resume listening. Human-named
presets map to provider voice ids **server-side only**; provider ids never reach
the client. The synced voice preference rides the workspace state merge exactly
like model preferences (higher updatedAt wins, device wins ties).

## One session per open — reach begin/end through refs

**Rule:** the overlay effect that starts/stops the voice session must depend on
`visible` alone and call `begin`/`end` through refs updated every render.

**Why:** the session hook's callbacks re-derive from conversation context, so
their identities change on every filed message. With `begin`/`end` in the
dependency list, each voice turn tore the session down mid-conversation and
restarted it (transcript wiped, capture restarted, error panels flickering
into unclickability — buttons detached from the DOM faster than a click).

**How to apply:** any "start a long-lived process while mounted/open" effect in
the mobile app should key on the visibility boolean and reach live callbacks
via refs; never list context-derived callbacks as deps of a lifecycle effect.

## Sentence chunker must extend across short sentences

**Rule:** when the head sentence of the buffer is under the minimum segment
length, scan to the *next* boundary and ship a combined segment; never wait for
more text while a complete short sentence sits at the head.

**Why:** cutting only at the first boundary meant a short reply opener ("Ok.")
stalled every sentence queued behind it until the stream ended — speech went
silent mid-reply, then dumped everything at flush.

## Live bubbles hand off to the transcript

**Rule:** the "live" user/assistant text is a staging area; the moment words
are appended to the transcript (user: at turn start; assistant: at finalize),
clear the corresponding live text.

**Why:** both regions render identical bubbles, so overlap shows the same
utterance twice. Browser tests only caught this after asserting
`voice-live-user` has count 0 once the transcript entry exists — screenshots
found it first. When a UI has live + settled copies of the same data, always
assert the handoff, not just each region's content.

## Testing the loop

The deterministic audio harness is driven by window events
(`venom-voice:utterance`, `venom-voice:deny-mic`, `venom-voice:finish-playback`
with `__venomVoiceHoldPlayback`) and observed via `__venomVoicePlaybackLog` /
`__venomVoiceCaptureState`. Hold playback to keep the "speaking" state
observable; remember the assistant text stays in the live region until
playback finishes, so held playback means asserting `voice-live-assistant`,
not the transcript entry.
