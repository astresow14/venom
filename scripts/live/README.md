# Live verification harnesses

Scripts in this directory drive the REAL dev servers, API, database, and Clerk
auth with disposable `+clerk_test` accounts. They are not part of any CI suite
— they exist for one-off end-to-end verification of flows that automated
layers cover only in pieces. Each script prints a PASS/FAIL step summary,
saves screenshots under `/tmp/…`, exits non-zero on failure, and deletes its
test accounts afterwards.

Run any of them with the three artifact dev workflows up:

```sh
PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=$(command -v chromium) node scripts/live/<script>.mjs
```

- `cross-device-deliberation.mjs` — one account on desktop + mobile web at
  once: deliberated turns sync across devices, thinking panels stay on the
  conversation that asked.
- `sign-in-device-verification.mjs` — fresh-device sign-in including the
  email-code client-trust step.
- `shared-workspace-two-accounts.mjs` — two accounts sharing a workspace end
  to end (details below).

## Documented pass: two real accounts share a workspace (task 164)

`shared-workspace-two-accounts.mjs`, last full pass **2026-08-21**, 22/22
steps, ~90 s. Two freshly created Clerk accounts, real API + database + sync
blob + **live GPT knowledge extraction** (only the chat AI endpoints
models/deliberation/respond are stubbed for determinism).

What the pass proved, in order:

1. **Owner (desktop web)** signs in, creates a shared workspace, and adds the
   second account by user id — the live Clerk directory lookup resolves and
   the member row renders immediately.
2. Owner sends a chat turn; the **live extraction** files 3 clusters into the
   workspace (`filedWorkspaceId` matches, `GET …/knowledge` returns them),
   the workspace Brain map renders the concept, and a workspace SOP is
   created.
3. **Member (Expo mobile web)** signs in, files *personal* knowledge from
   chat (live extraction + sync-blob PUT), then opens Shared Workspaces and
   sees the same members, knowledge clusters, and SOP.
4. **Member (desktop web)** signs in, selects the shared space, and sees the
   same Brain concept and SOP.
5. Owner **removes** the member. The member's next workspace-scoped request
   on each device returns the coded 403 and evicts:
   - Desktop: navigating to Brain remounts the workspace knowledge query →
     403 → "Shared workspace unavailable" toast, switcher back to Personal,
     workspace badge gone.
   - Mobile: tapping a cluster-sensitivity toggle → PATCH 403 → access-lost
     notice, workspace disappears from the space list, cached knowledge/SOP
     rows dropped without a reload.
6. The denial contract holds (`403` body carries
   `code: "workspace_access_denied"`; the workspace list no longer contains
   the workspace), the member's **personal Brain keeps working on both
   devices** (espresso concept still searchable/mapped), and the **owner
   retains full access**.

Screenshot evidence from the pass is written to `/tmp/task164/` (regenerated
on every run).

### Observations from the pass

- **Mobile fires a burst of 401s right after sign-in** (`/api/venom/workspaces`,
  `/api/venom/workspace`, `/api/venom/community/notifications/unread-count`)
  before the Clerk token is attached; the queries recover on retry. Already
  tracked as its own task ("Make the phone app's first request after sign-in
  carry your credentials").
- **The workspace members dialog did not close on Escape** (run 1); the
  harness closes it via its Close button instead. Worth an accessibility
  follow-up — Radix dialogs are expected to dismiss on Escape.
- Selector notes for future harness work live in
  `.agents/memory/live-two-client-sync-harness.md`.
