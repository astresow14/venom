---
name: Venom user-centric chat context
description: Chat context assembly spans the personal Brain plus every workspace membership; the on-screen selection only decides filing and SOPs.
---

# User-centric chat context

The rule: every chat turn's server-side knowledge context is assembled from
the caller's personal Brain **plus every shared workspace they belong to**,
membership-checked per request. The client's active-workspace selection no
longer gates what chat knows — it only decides (a) where extracted knowledge
files, (b) which workspace's SOPs join the prompt, and (c) how organizational
views are filtered.

**Why:** the workspace picker used to silently starve chat (personal chats got
zero business knowledge; business chats lost the personal Brain). Reverting to
selection-gated context would look like a "simplification" but breaks the
product promise that Venom answers from everything you can legitimately see.

**How to apply:**
- Memberships are listed fresh on every call, so removal revokes on the next
  turn; a stale or forged active membership must be deduped against (and never
  extend) the live membership list.
- Failure contract: the active scope fails hard (the whole request errors with
  a scope-appropriate message); any other scope fails soft into a logged
  dropped-scopes list.
- Citations carry their scope in both id and display label so saved notes
  attribute business knowledge to the workspace it came from.
- Restriction (admin-only) filtering applies per caller role at assembly time:
  restricted concepts must not even mint a citation id for members.
- Tests that assert scope-ranking bias must seed the favored concept weaker
  than its competition, or the bias proves nothing.
