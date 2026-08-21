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
