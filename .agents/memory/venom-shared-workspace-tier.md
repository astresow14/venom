---
name: Venom shared workspace tier
description: How the multi-user workspace tier stays revocable — server-checked membership, client cache eviction, and what must never enter the sync snapshot.
---

**Rule:** Shared-workspace content (knowledge, SOPs, members) is served only by membership-checked endpoints and cached only in react-query. The per-user sync snapshot must never carry workspace content or the workspace selection's data — only the selected id may persist locally (localStorage/AsyncStorage), because ids are harmless once the server refuses to serve the workspace.

**Why:** Anything embedded in the synced blob stays on a device forever, which turns revocation into a fiction. Removal must take effect on the removed person's next request.

**How to apply:**
- Server: every workspace-scoped route re-checks membership per request and answers non-members with `403 { error, code: "workspace_access_denied" }` (unknown/malformed ids use the same body, so probing cannot distinguish "not yours" from "does not exist"). Chat/extraction re-check at response and at filing time.
- Client: one dependency-free leaf module holds the denial predicate (`status === 403 && data.code === …`) plus a handler registry. QueryCache/MutationCache `onError` and any hand-rolled fetch (`!response.ok` on the streaming chat call) funnel into it. The registered handler evicts every query whose key starts with the workspace API prefix, invalidates the workspace list, resets the selection, and tells the user once. Retry logic must never retry a denial.
- Workspace-filed extraction returns `filedWorkspaceId` (never the personal `filed` list); the client invalidates the workspace knowledge query instead of mirroring records into local synced state.
- Cache keys for workspace lists are account-suffixed so switching accounts cannot reuse another account's list.

- Admin-only routes answer members-who-are-not-admins with a distinct 403 code (`workspace_admin_required`, safe to reveal — callers already know they are members). The client eviction predicate matches `workspace_access_denied` only, so a demotion never evicts; keep it that way when adding codes.
- Membership mutations that can shrink the admin set (role PATCH, member DELETE) open their transaction with `pg_advisory_xact_lock(hashtext(workspaceId))` — without it, two concurrent demotions/removals each read an admin count of two and strand the workspace with zero admins. The pre-transaction admin gate can go stale while a request is parked at that lock, so the actor's membership+role must be re-read inside the transaction and refused with the matching 403 body (gone → access-denied, demoted → admin-required).
**Admin-only restriction dimension (orthogonal to `sensitive`):**
- Two flags per concept/SOP: `sensitive` (any member toggles; governs exports leaving the workspace) and `adminOnly` (admins only; governs who inside the workspace sees it at all). Restricting a concept hides its whole cluster including evidence.
- Enforcement is server-side per request, same pattern as membership: member GETs filter restricted rows, chat context skips them **before** citation ids are minted (so the stream filter can never cite one), exports take an explicit required `includeRestricted` option (workspace passes `role === "admin"`, personal passes `true`) and report a separate withheld count.
- Member writes against a restricted item answer `404` as-if-nonexistent (never 403 — a member must not learn the item exists). Only the restriction PATCH itself is 403-gated by admin membership.
- Restriction/sensitivity PATCHes are direct UPDATEs that never bump `updatedAt`/`lastUpdatedAt` — flags must not cause merge wars or reshuffle recency-sorted lists.
- Payload contract: cluster payloads carry `sensitive`/`adminOnly` only when true (absent = false); SOP payloads always carry an explicit `adminOnly` boolean. `sanitizeConcept` strips `adminOnly` from client snapshots so sync can never set or clear it, and refiling (`applyInsightCandidates`) preserves it via spread.
