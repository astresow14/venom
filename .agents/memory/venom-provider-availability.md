---
name: Venom provider availability vs account health
description: Why an env-available model can still fail every call, and how to tell a billing-dead key from a code bug.
---

Catalog availability is deliberately env-presence-only (key/base-URL vars exist ⇒ "Ready"). It cannot see account state: a direct provider key whose account has run out of credits keeps the model advertised as Ready while **every** call fails fast with a non-retryable HTTP 400 carrying a billing message in the error body. Nothing retries it (correct — 400 is non-retryable), so in deliberation that voice reports `failed` on every turn, and ordinary single-model chat on that model fails every time.

**Why:** availability was designed as a static capability check so the picker never promises a provider with no credentials; account-level health is a different failure class that only shows up on a real call. Confusing the two wastes debugging time on the adapter code, which is innocent.

**How to apply:**
- First move when one provider fails instantly on every turn: run the api-server's `smoke:venom-providers` script — it reports a safe per-model verdict with HTTP status. A 400 on a minimal request usually means account/billing state, not request shape; probe once with the SDK error body (it names billing explicitly and never contains the key).
- Fixing it is a user account action (add credits or replace the key), never a code change. Removing the dead key from secrets is the only way to make the catalog stop advertising the model, and that is the user's call.
