---
name: Venom billing model
description: The subscription/allowance contract — payer follows the space, who may see money, enforcement gating, and the traps new AI call sites and follow-up billing work must respect.
---

# Venom billing contract

Personal plans (free/plus) and a workspace Organization plan, all Stripe-hosted (checkout + portal only — the apps never render card forms). Plans are env-tunable config (`VENOM_PLAN_*`, warn ratio `VENOM_BILLING_WARN_RATIO`), with hardcoded fallbacks when env is absent or malformed.

**Payer follows the space, never the content.** A request bills the workspace only when the conversation lives in a workspace whose org plan currently keeps benefits; everything else bills the caller's personal plan. There is deliberately no content-based personal-vs-work classification — do not add one.

**Why:** the product line is "the room, not the sentence"; content classification was explicitly ruled out, and admin visibility of member spend is a separate follow-up concern.

**How to apply:**
- Every new AI call site must resolve the payer server-side and stamp the usage row's `billedWorkspaceId` (null = personal) *and* run the allowance check before spending. A call site that only meters usage silently bills the member's personal plan even inside a covered workspace.
- Admission is reservation-based, never read-then-act: a reserve-mode allowance check holds the request's priced worst case as a database row inside a payer-scoped advisory-lock transaction, so parallel requests and processes cannot split the last slice, and a sliver of balance refuses a request whose worst case would stream past the cap. Settlement (spend row in, hold out) must run under that SAME payer lock — admission sums durable spend and open holds in separate reads, and an unlocked settlement committing between them makes the cost vanish from both sums and over-admits. Every hold is claim-once: the request's first ledgered usage event claims it and settles it; close hooks free only an unclaimed hold. An unconditional close-release races the fire-and-forget usage insert into a moment where the cost is visible on neither side — this applies to *every* metered leg, including short request-scoped ones like voice. Age-based reaping mops up crashes; background-spending paths (build runs) carry the hold on their run row for the worker to settle or release.
- The reserved bound must price ceilings that dispatch *actually enforces* — the prompt-size and output-token caps at the priciest catalog rate — never a flat figure: any flat number below the enforceable worst case lets a single admitted request settle past the allowance. Routes that enforce tighter inputs themselves (voice legs, the judge call) pass their own smaller priced bound so they neither over-admit nor starve concurrency.
- Money visibility: personal usage/summary endpoints exclude workspace-billed rows entirely — members see only a "covered by <workspace>" note with **no dollar figures**; workspace spend figures are admin-only (the member shape of the workspace billing endpoint carries no money fields). Keep new endpoints on that line.
- Enforcement is active only when Stripe is configured or `VENOM_BILLING_ENFORCE=1`; otherwise allowance checks pass open and UIs show a "not set up" state. Blocks are 402 with distinct codes `personal_allowance_exhausted` / `workspace_allowance_exhausted` — clients key copy off the code (workspace copy must say the *workspace* limit is the problem).
- Status `past_due` keeps benefits (Stripe dunning decides); only subscription deletion/cancellation drops a scope to free/uncovered. `invoice.payment_failed` must never resurrect a canceled account. Billing periods come from the Stripe subscription only while benefits hold *and* the period contains now — otherwise fall back to the UTC calendar month.
- Tests: the Stripe client and webhook verifier are override seams (`overrideVenomStripeForTests`, `overrideStripeWebhookVerifierForTests`) so webhook lifecycle and checkout flows run hermetically; the webhook route must stay mounted on `express.raw` *before* the json body parser or signature verification breaks.
