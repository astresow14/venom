---
name: Venom provider availability vs account health
description: How billing-dead provider keys surface — a passive account-health overlay on the catalog — and how to verify one.
---

Catalog availability stays env-presence-only (key/base-URL vars exist ⇒ configured) — except a direct Gemini key, which must pass a runtime capability check first. Any availability gate must mirror the client's credential precedence (direct key wins even when the managed pair is also set), or the catalog advertises a credential requests never use.

Account state is a separate, passive overlay: live calls report billing-class failures (HTTP 402; or 4xx with an `insufficient_quota` code or explicit billing text such as "credit balance" / "exceeded your current quota") into a per-process registry. The catalog then keeps the model `available` but flags `accountHealth: "unfunded"` ("Provider account issue" instead of "Ready"), deliberation/debate planning stop auto-seating it, and chat maps the failure to a non-retryable `provider_account` error with fixed safe copy — never provider error text. The next successful stream, or a restart, clears the verdict.

**Why:** presence-only availability promised replies a billing-dead account could never deliver — a dead alternate silently cost a deliberation voice on every turn. Passive detection adds zero startup token cost and self-heals on the first good call after the owner tops up; explicit user choices (active model, requested debate corners) stay honored with warnings, never silently rerouted, so retrying remains the recovery path.

**How to apply:**
- One provider failing instantly on every turn? Run the api-server's `smoke:venom-providers` script — safe per-model verdicts; billing-class failures print "Provider account cannot cover requests". The overlay is per process: a smoke run does not mark the separately running dev server, which learns from its own first failed call.
- Keep the classifier narrow (explicit billing signals on 4xx only) so transient per-minute rate limits stay retryable — and check billing before the 429 rate-limit branch, because exhausted prepaid quotas arrive as 429.
- Server-side planning filters are not enough: both clients build DEFAULT debate corners from the catalog and send them as an explicit roster the server honors. Any health rule must also gate the clients' corner candidates, or defaults smuggle a dead model back in.
- Fan-out runners (multi-voice passes) must aggregate normalized failure kinds: catching per-voice errors and rethrowing a fresh generic retryable error when all fail masks the account problem for explicitly selected models. All-billing → the fixed account error; mixed → generic.
- Funding the account is still the owner's action, not a code change — the code's job ends at honest presentation, planning, and error copy.
