# Tuning Venom's voice restraint from decision evidence

Voice mode logs every speak/stay-quiet decision and what happened next into
`venom_voice_decisions`. This note maps that evidence onto the named
thresholds in `venom-voice-restraint.ts`: which number justifies moving which
knob, and in which direction.

## Where the evidence comes from

Two owner-scoped endpoints (each caller sees only their own rows):

- `GET /api/venom/voice/decisions/summary?windowDays=1..90` (default 30) —
  decisions × outcomes × talkativeness counts (`cells`), headline rates
  overall and per talkativeness, and a `thresholds` block echoing the values
  in force when the summary was generated.
- `GET /api/venom/voice/decisions/export?windowDays=1..90` (default 90) —
  JSONL training data, one decision per line: `signals` (the extracted turn
  features the decision was made from), the decision, which layer made it
  (`source`), and the labeled outcome with `outcomeLatencyMs`.

Rates distinguish **null** (nothing settled yet — no data) from **0** (a real
zero). Never read null as "0%".

## Ground rules before moving anything

1. **`outcomeCoverage` ≥ ~0.7.** Below that, the clients are failing to report
   outcomes (sessions killed early, follow-up window expiring unnoticed) and
   every rate is built on survivor bias. Fix reporting first.
2. **≥ 30 settled decisions** in a metric's slice before trusting its rate.
3. **`sourceCounts.fallback` share < ~10%.** Fallback fails open to `respond`,
   so a judge outage inflates spoken volume and drowns the heuristics you are
   trying to measure. Fix judge health first (see `JUDGE_TIMEOUT_MS` below).
4. Read **per talkativeness** — the whole point of the setting is different
   tolerances. `chatty` running hotter than `balanced` is by design.
5. `source` splits responsibility: `heuristic` cells indict these constants,
   `model` cells indict the judge prompt. Move **one knob at a time**, then
   re-measure a fresh window.

## Metric → threshold map

### `quietRegret` — silent (non-wind-down) decisions: re-ask vs stayed quiet

- **High (> ~0.30): silence is swallowing real requests.**
  - Lower `BACKCHANNEL_MAX_WORDS` (6 → 5): fewer mid-length turns read as
    ignorable filler.
  - If regretted silences in the export show the assistant's previous turn
    ended with a question but `signals.answeringBotQuestion` is false, the
    user's answer exceeded the cap — raise `BOT_ANSWER_MAX_WORDS` (8 → 10) so
    longer answers to the bot's own question force a reply.
  - If regret concentrates in `source: model` cells, the judge is
    over-silencing; adjust its prompt or inputs, not these constants.
- **Low (< ~0.10) while `spokenInterruption` is high:** silence is safer than
  we use it. Raise `BACKCHANNEL_MAX_WORDS` (6 → 7); consider
  `LONG_UTTERANCE_WORDS` (12 → 14) so mid-length musings stop auto-earning a
  full reply and reach the judge instead.

### `spokenInterruption` — respond/acknowledge (non-wind-down): interrupted vs completed

- **High (> ~0.25): replies are too eager.**
  - Interruptions clustering on `signals.wordCount` just above
    `BACKCHANNEL_MAX_WORDS` → those turns were filler we replied to; raise it.
  - Interruptions on gratitude turns longer than `SHORT_GRATITUDE_MAX_WORDS`
    (full reply to a long thank-you) → raise it (5 → 7) so they get the
    one-line acknowledgment instead.
  - Concentrated in `source: fallback` → an availability problem, not a
    threshold problem.
- **Low everywhere alongside low `quietRegret`:** the thresholds are sitting
  right. Leave them.

### `windDownClean` — wind-down-flagged decisions: eased closed vs pulled back open

- **Low (< ~0.6): goodbyes bounce back open — the wind-down read fires early.**
  - In the export, split the settled wind-down rows by `signals.farewell`:
    - `farewell: false` (momentum-only wind-downs) → raise
      `WIND_DOWN_TRAILING_SHORT_TURNS` (1 → 2): demand more evidence of dying
      momentum before arming the close timer.
    - `farewell: true` → the farewell lexicon is too greedy; trim
      `FAREWELL_PHRASES` (same file) rather than touching the counter.
- **High (≥ ~0.9) with a healthy sample:** wind-down is trustworthy; the
  client close delay could drop (16 s → 12 s) for a snappier goodbye.
- `session_closed` on wind-down rows is neutral (user closed manually before
  the timer); it deliberately settles neither bucket.

## Constants that live elsewhere

- **Client-owned timing** — `FOLLOW_UP_WINDOW_MS = 30_000` (what counts as a
  re-ask) and `WIND_DOWN_CLOSE_DELAY_MS = 16_000` (how long a goodbye waits
  before easing closed) live in
  `artifacts/venom-desktop/src/lib/voice/voiceRestraint.ts` and
  `artifacts/venom/hooks/voiceRestraint.ts` — mirror any change in both.
  Changing `FOLLOW_UP_WINDOW_MS` changes what `user_followed_up` *means*:
  rates from before and after the change are not comparable, so note the date
  in any dataset that spans it.
- **`JUDGE_TIMEOUT_MS = 3_000`** (`routes/venom-voice.ts`) — raise only when
  `fallback` share is high because the judge times out, not to "get more
  judge calls".
- **Log policy** — retention (90 days), per-user cap (500 rows), preview cap
  (280 chars) live in `venom-voice-decision-report.ts` and are echoed in the
  summary's `thresholds` block.

## Using the export as a training set

- `signals` is the feature vector, `decision` + `windDown` the policy output,
  `outcome` (+ `outcomeLatencyMs`) the label. `pending` rows are unlabeled —
  drop them for supervised training.
- Filter out `source: fallback` lines: they encode provider outages, not
  policy.
- The data is already minimal by construction: no audio exists anywhere,
  transcript previews are capped at 280 chars, and export lines carry no user
  identifier.
