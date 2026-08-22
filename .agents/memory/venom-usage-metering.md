---
name: Venom usage metering
description: How AI spend is metered — the onUsage seam, micro-dollar ledger, server-private pricing, and the trap that new AI call sites must wire metering themselves.
---

# Venom usage metering

**The rule:** every AI call site must explicitly wire usage recording — nothing enforces it. `streamVenomResponse` only *reports* usage through an optional `onUsage` callback; a new call site that omits it (or a new non-streaming completion that never calls `usageFromCompletion`) silently goes unmetered. When adding any AI feature, wire its usage event and extend the hermetic usage integration suite with a subtest proving the event lands.

**Why:** the ledger underpins subscription plans and admin spend controls; a silent gap corrupts billing-adjacent data with no error anywhere. The suite (one subtest per AI path) is the only guard.

**How to apply:**
- Server routes: build/reuse the `meterUsage(callKind, alias)` closure pattern after model-id resolution; call it from the stream's `onUsage` or after non-streaming completions. Deliberation/debate libs expose `onUsage` options — thread them through.
- Recording is fire-and-forget (`recordVenomUsage` never throws, logs only the call kind — never content, SKUs, or rates; the model-leak suite scans logs too).
- Money is integer micro-dollars end-to-end server-side; clients only ever see dollars + Venom-branded names. Pricing lives in a server-private table keyed by venom alias; unknown aliases price at zero rather than throwing.
- `onUsage` fires in `finally`, so aborted/interrupted streams still meter (as flagged char-based estimates when the provider frame never arrived). Native counts require BOTH prompt and completion token numbers — zero is a real report, not a fallback trigger.
- Voice audio legs (transcribe/speak) meter flat per-request estimates under the `venom-voice` alias; the LLM judge meters real tokens.
- The summary API emits date-only strings (`YYYY-MM-DD`, UTC calendar month); both UIs append `T00:00:00Z` before parsing — keep that shape.

Background fire-and-forget AI calls triggered by a user's activity (e.g. the bonded-persona profile refresh that chat absorption makes due) are still that user's personal spend — meter them at the point the completion returns, before any validation can bail. The deliberate exception is community-shared infrastructure (thread summaries), where charging whichever member bumped the revision would misattribute spend; document that boundary in code.
