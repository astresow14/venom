---
name: Venom workspace AI controls
description: Admin spend caps and model locks for org-plan workspaces — precedence, transport, and cross-app contract.
---

Org-plan workspace admins get per-member workspace-billed usage, spend caps, and model locks. The rules both apps and the server must stay consistent with:

- **Precedence:** workspace allowance exhausted beats a member cap (`workspace_allowance_exhausted` vs `workspace_member_cap_reached` vs `personal_allowance_exhausted` — three distinct codes, and copy must keep naming the workspace vs the personal plan distinctly). Admin lock beats user policy; a manual out-of-tier pick clamps to the cheapest allowed model rather than erroring.
  **Why:** a member must never be told "your cap" when the whole workspace ran dry, and a lock must degrade picks gracefully instead of breaking sends.
- **Transport:** members learn cap/lock state (`memberCapState`, `modelLock`) from the billing context, and only when the workspace is actually the payer; the admin-only ai-controls/usage endpoints are for admins. Managed selection is announced per-turn via the SSE start event's `selection: { policy, managed: true }` (absent for unmanaged manual).
  **How to apply:** never have member-facing UI read admin endpoints; keyless (enforcement off) means no blocks and no lock states.
- **Normalization:** allowed-tier set equal to the full set stores as null (no lock); empty set is rejected; the tier filter fails open if it would empty the catalog. Caps: null = no cap, 0 = deliberate full block; an override row with null cap = explicitly uncapped (distinct from "no override").
- **Controls PUT is a full replace** (all three keys required); clients send unchanged fields back from the last-read document.
