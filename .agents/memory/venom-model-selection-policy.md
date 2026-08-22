---
name: Venom model selection policy
description: How the account-level Manual / Auto-cheapest / Auto-max-power policy behaves, and the product decisions future model/billing/admin tasks must stay consistent with.
---

The account-level model selection policy (`modelPreferences.selectionPolicy`) is resolved
**server-side on every respond request** — never on the client — so it holds on all devices and
lets a later admin task lock it centrally. Unknown/absent values resolve to `manual`.

Product decisions to stay consistent with:

- **Auto modes take over completely.** They plan from the whole healthy catalog
  (available && not unfunded), *not* the user's enabled list, and they set aside explicit
  per-voice picks and debate corner ids (suppressed as `undefined` toward the planners, so
  provider-distinctness and unfunded-skip rules keep working for free). Blend *weights* still
  apply in Verify because they ride the stable voice roles, not model ids; debate weights fall
  back to even when corner ids don't match the auto roster.
- **Manual stays byte-identical to the old behavior** — auto logic must never leak into the
  manual path (route tests assert no `selection` field on the SSE start event under manual).
- **Cost/capability ranks are server-private.** The public catalog exposes only the coarse
  `$`/`$$`/`$$$` `costTier`; numeric ranks or prices in any client payload are a secrecy
  regression (guarded by the model-leak suite).
- **No usable model under auto** falls back to the request's own model so the existing 502
  path speaks; it never invents availability.
- The SSE start event carries `selection: { policy }` only when an auto mode actually chose —
  clients use it for honest "Venom chose this" attribution.

**Why:** the takeover must be trustworthy (users hand over control, so half-applied manual
picks would be dishonest) and rank secrecy protects provider terms; both were explicit task
requirements and downstream tasks (admin locks, usage/billing) build on these exact seams.

**How to apply:** any new response mode or planner must consume the policy the same way
(ranked catalog in, explicit picks suppressed when auto); any new catalog model needs a
cost+capability rank entry (the Record type forces it) and a coarse tier only in public
payloads.
