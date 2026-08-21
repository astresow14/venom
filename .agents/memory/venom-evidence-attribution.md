---
name: Venom evidence attribution
description: How person attribution on Brain evidence stays trustworthy — server-assigned stamps, client-snapshot restriction, presentation-time legacy defaulting, bounded identity cache.
---

Evidence attribution (who captured a fact, when) is **server-assigned at filing** and never trusted from clients. The rules future work — especially shared workspaces — must stay consistent with:

- Filing requires the capture identity to equal the authenticated owner; the extract route re-reads the request's auth identity **after every async boundary** (model calls) and refuses to file on mismatch rather than stamping the newer session.
- Client-supplied concept snapshots (device absorb, blob import) get any stamp naming someone other than the owner nulled before merge — clients can sync content but never mint or launder attribution.
- A capture timestamp without a capture identity is collapsed to null at sanitize time; the pair travels together or not at all.
- Evidence from before attribution keeps null stamps in the store; the concept-detail route defaults them to the ontology owner **at presentation time**. No data migration — don't "backfill" stamps, that would fabricate history and break the shared-workspace story.
- Identity records (display name/email/provider from the auth provider) are a bounded server-side cache: created on first authenticated use, TTL refresh, lazy row deletion when the provider reports the user gone, stale-serving on provider outage, and **personal values never appear in logs or error messages**. Clients fall back server identity → auth client profile → generic label; an unresolvable non-self id renders a generic "Workspace member", never a guessed name.

**Why:** attribution is the trust anchor for the coming shared-workspace tier — a fact stamped with the wrong person is worse than an unattributed one, and once forged stamps enter the store they are indistinguishable from real ones.

**How to apply:** any new write path into the ontology store (new sync surface, import, background job) must route through the same filing guard and snapshot restriction; any new read surface showing people must use the same presentation-time defaulting and fallback chain.
