---
name: Venom voice desktop parity
description: How desktop voice mode mirrors mobile — duplicated pure modules, adapter seam, and deterministic e2e via the harness adapter.
---

# Venom voice desktop parity

Both apps run the same hands-free loop. The platform seam is a single audio
adapter interface (capture + PCM playback) resolved behind one getter; every
other voice module — sentence chunker, SSE line reader, speech detector,
restraint outcome tracker — is pure and **duplicated verbatim** in each app
(desktop `src/lib/voice/`, mobile `hooks/context`). Copy fixes to both until
the modules are extracted into a shared workspace lib (same story as the
merge-rules lib before extraction). The overlay picker and the settings
dialog share one copy module per app so preset/talkativeness labels cannot
fork within an app.

**Deterministic voice e2e** (both suites): UI-test mode swaps the audio
adapter for a window-driven harness — dispatch `venom-voice:utterance` /
`finish-playback` events, set `__venomVoiceDenyMic` / `__venomVoiceHoldPlayback`
/ `__venomVoiceWindDownMs` flags, poll `__venomVoiceCaptureState` and
`__venomVoicePlaybackLog`. Hold playback open to assert the speaking state,
or it self-finishes in ~120ms.

**Why:** voice behavior (restraint semantics, chunking, fallbacks) must feel
identical across devices; a fix applied to one copy silently regresses the
other, and real mic/audio APIs make un-harnessed browser tests flaky.

**Known asymmetry (deliberate):** the shared modules — detector ducking,
capture `setDucking`, the level-driven harness — carry hands-free barge-in
support in both apps, but only the *mobile* hook wires it (mic hot + ducked
during playback, speech-start cuts the reply). Desktop's hook still pauses
capture while speaking; interrupting there is click-only until its hook gets
the same wiring. Mirroring the modules is still mandatory; the hooks are the
place the apps may intentionally differ.

**How to apply:** touching any pure voice module → mirror the edit in the
sibling app and run both voice suites. Writing voice specs → stub *every*
voice endpoint (catalog/transcribe/respond/speak/decide/decision-outcome/
extract); UI-test fetches stay live and the dev server's HTML fallback breaks
JSON parsing. Desktop transport is cookie-auth relative URLs; mobile is
bearer-token absolute — keep request bodies identical anyway.
