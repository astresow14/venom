---
name: Venom voice restraint layer
description: The speak/stay-quiet decision contract between api-server and the mobile voice loop — fail-open rules, outcome settling, wind-down ownership.
---

# Voice restraint (speak / acknowledge / stay silent)

The server decides per finished voice turn (`POST /venom/voice/decide`); the
client executes the decision and reports what happened next
(`POST /venom/voice/decision-outcome`). Typed chat is untouched — restraint
exists only inside the hands-free voice loop.

## Rules that must survive refactors

- **Fail open to respond, everywhere.** Timeout, 4xx/5xx, malformed body,
  judge unavailable, store down — every failure resolves to a full reply
  (client treats `null` as respond and skips outcome tracking). Heuristics
  hard-bias respond for questions, direct address ("venom"), imperatives, and
  answers to a bot question; a judge verdict can never override that guard.
- **Silence has no UI.** A silent decision files the user's words into the
  conversation exactly like any turn, then just resumes listening. No
  "I chose not to respond" bubble.
- **The client owns the wind-down clock.** Server only flags `windDown`;
  the hook arms a timer (16s, `window.__venomVoiceWindDownMs` override for
  browser tests) that eases the session closed from the `listening` phase
  only. Any speech-start/utterance/interrupt disarms it.
- **A wind-down closer must stay pending.** finalize() normally settles
  respond/acknowledge decisions as `reply_completed` — but when
  `windDownAfterTurn` is set it must *skip* that and arm the timer instead,
  otherwise `wound_down` can never be recorded (the tracker is one-decision-
  at-a-time and settles exactly once).
  **Why:** the wound_down/user_followed_up split is the core training signal
  for whether goodbyes were read correctly.
- **Outcome tracker is timer-free.** Quiet decisions settle lazily against
  the clock on the *next* event (follow-up window 30s: re-engage inside it →
  `user_followed_up`, after it → `stayed_quiet`). This keeps the tracker
  pure and unit-testable with explicit `now` params.
- **Talkativeness** (chatty/balanced/reserved) lives inside the synced
  `voicePreferences` object — it rides the whole-object updatedAt merge, so
  never split it into its own top-level field.

## Logging

- **Retention is two-path by design.** A scheduled global sweep enforces the
  age cap for every user; prune-on-write only ever fires for users still
  active, so it alone can never bound a dormant user's rows. Transcript is
  stored as a ~280-char preview plus signals JSON; never raw audio.
  **Why:** "bounded retention" that depends on the owner's next visit is a
  privacy gap, and a completion review rejected exactly that.
- **A decisionId is issued only for a durable row.** The decide route awaits
  the insert under a small budget; if the row isn't provably stored in time
  (slow, hung, or failing store) the response simply omits `decisionId` and
  the client executes the decision untracked. Never hand out an id the
  client could race against its own insert — a lost race pins the outcome at
  `recorded: false` forever, and "eventually succeeded after the budget" is
  exactly the case that bites.

**Desktop surface:** the talkativeness dial and voice preset picker live in the
shell-footer "Voice mode" dialog on desktop, editing the same synced
`voicePreferences` block through the normal workspace save path — one context
setter normalizes and stamps a fresh `updatedAt` so the freshest device wins
the merge. The synced fields stay optional in the snapshot type, so UI reads
need the exported defaults as type guards.
