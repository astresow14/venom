---
name: Venom master ontology (anonymous cross-tenant tier)
description: Privacy invariants for the opt-in cross-tenant knowledge tier.
---

# Venom master ontology

Anonymous aggregate tier built only from opted-in tenants (per user; per
company via its admins). Durable invariants:

- Only concept-level signals ever leave a tenant (labels, categories, link
  pairs). Evidence text, chat, and identity are structurally excluded — the
  cross-tenant tables have no columns for them.
- Tenant ids on signals exist only for distinct-tenant thresholding and
  revocation. Below the fixed minimum, every read surface behaves exactly
  like "does not exist".
- One server-side sanitize boundary screens identity independently of model
  output and user flags: categories are allowlisted (missing or unknown ones
  rejected — no default may vouch), and identifier- or person-name-shaped
  labels are blocked with retroactive retraction. Over-blocking is the
  accepted direction of error.
- Policy changes are versioned: a sweep re-sanitizes stored signals on each
  transition, and master reads fail closed until it has completed.
- Opt-out is retroactive: it purges the tenant's signals and rebuilds
  aggregates.
- Master content is reference data, never instructions: prompt vocabulary is
  serialized as escaped structured data so labels cannot inject, and the
  network layer's UI is read-only.
- Concurrency: consent is re-read inside the signal-writing transaction
  under the same lock the opt-out purge takes, and rebuilds/sweeps read
  signals inside one globally locked transaction — otherwise a stale
  snapshot can resurrect a revoked tenant.

**Why:** one leaked excerpt, identifier, or rare-concept fingerprint across
tenants is a privacy incident, not a bug.

**How to apply:** route every new write path through the sanitize boundary;
keep every new read surface behind the threshold and the read gate; bump the
policy version whenever screening tightens; extend the privacy suite with
each new path.

## Template learning tier

Template edit signals (per-template lessons from how builders edit
template-derived packages) are a second cross-tenant tier riding the same
machinery — never a parallel consent scheme:

- Consent, locking, purge, and rebuild are shared: the master contribution
  setting gates it, the tenant advisory lock re-checks consent inside the
  writing transaction, opting out deletes template signals in the same
  transaction as ontology signals, and the single global rebuild fence
  recomputes template guidance under the same distinct-tenant floor.
- De-identification is structural rather than sanitization: the only
  storable content is a key from a compiled-in closed vocabulary
  (deterministic package-section deltas + word-boundary theme regexes over
  instructions). Free text is only pattern-matched, never stored, and reads
  emit only compiled copy — a poisoned row cannot surface its own text.
- The closed vocabulary is also what makes aggregation work: free-form
  (LLM-extracted) labels would fragment below the threshold; identical keys
  across tenants are the point.
- Guidance reaches generation only inside the untrusted reference envelope,
  bounded to a fixed entry cap, with a run event recording exactly what each
  generation attempt saw (observability per attempt, and the review-surface
  note derives from that event).

**How to apply:** a new cross-tenant learning surface should extend the
master rebuild and the tenant purge helper instead of adding its own consent
or rebuild path; keep new vocabularies compiled-in and concept-shaped.
