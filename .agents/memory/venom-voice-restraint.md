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

## Decision overlap (latency)

- **A slow decide overlaps the reply instead of delaying it.** The client
  races decide against a short grace (250ms prod). If the grace elapses, the
  turn files the user's words and starts the respond stream *held*: text and
  sentences buffer on the turn, and every surfacing site (live-text set,
  speech pump, audio close) checks the turn's hold flag. Respond/fail-open →
  release (flush text, pump, close); quiet → discard (finalize, clear the
  speak queue, abort the stream, clear live text) — nothing was shown,
  spoken, or filed for the assistant, so semantics match the serialized
  paths exactly.
  **Why:** the pre-reply gap is where voice UX is most sensitive; the judge
  path used to cost up to ~3s right there.
  **How to apply:** any new surface a reply can reach (UI, audio, filing)
  must check the hold gate, or a quiet decision can leak a half-reply.
- **Stream failures park while held.** If the optimistic stream errors or
  truncates before the decision lands, the failure is stored on the turn
  instead of running the normal error path — that path files the partial
  reply and tears the session down, making a late quiet decision
  unenforceable (a completion review rejected exactly this). Release
  presents the parked failure with serialized semantics (keep-text notice /
  session failure); discard erases it wholesale, error and all.
- **Finalize is the discard choke point.** Every exit path (overlay close,
  interrupt, session failure) funnels into turn finalization, which files
  buffered assistant text — so finalization of a still-held turn must be
  discard-only (no message, no transcript, no extraction; user words are
  already filed). Release clears the hold flag *before* finalizing, which
  is what lets legitimized turns keep filing normally.
- **UI-test builds serialize by default.** The grace resolver returns 60s in
  UI-test bundles — stubbed decides are instant, and a CPU-stalled runner
  must not flip existing restraint specs onto the optimistic path. Overlap
  specs opt in with `window.__venomVoiceDecideGraceMs = 0`.
- **Held-turn e2e must also raise the decide abort.** The client fails open
  after a bounded decide round-trip (4s default,
  `window.__venomVoiceDecideTimeoutMs` override). A spec that holds /decide
  open past that watches the turn release itself mid-assertion — raise the
  override (e.g. 30s) alongside grace 0.
- **Playwright gotcha:** `expect(locator).not.toContainText()` FAILS on zero
  elements ("element(s) not found") — scope negative text assertions to an
  always-present ancestor (the voice overlay), not a conditionally rendered
  bubble.
- The decide route logs one info line per decision (source/decision/
  windDown/durable/totalMs/judgeMs — never transcript content), so p50/p95
  is measurable straight from server logs.

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
