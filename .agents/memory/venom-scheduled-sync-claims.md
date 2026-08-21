---
name: Venom scheduled-sync claims
description: Cross-device coordination protocol for unattended source updates — claim leases in the synced schedule, merge rules both apps must keep, and the server worker that now owns due syncs.
---

Unattended source updates are paced by a claim recorded on the source's synced schedule (`claimedAt`/`claimedBy`), because every signed-in device evaluates the same schedule.

**Current owner: the API server.** The in-app scheduled-sync runner was later removed — the server worker (see the server-owned scheduled source sync topic) stakes claims via revision-checked CAS and runs due syncs even with no client open. Clients now only *display* claim/schedule state ("updating now" for a live claim, "due now" once a lease expires) and must never fire a scheduled connect themselves — an in-app takeover would double what the server does. The claim-carry merge rules below still bind both apps: a device's saves must not drop another session's claim, spent or live. E2e specs asserting client-side takeover are stale leftovers of the retired runner (see the stale sibling specs topic).

**The rules:**
- A claim is live iff `claimedAt > (lastAttemptAt ?? -1)` and its ~10min lease has not expired. Any recorded attempt (success bumps `lastAttemptAt` via the schedule carry; failure writes `lastAttemptAt`+`lastError`) *spends* the claim implicitly — there is no explicit release on completion, so crash paths cannot strand a "locked" source; worst case is one lease of delay.
- While a claim is live, the source's due time reads as `claimedAt + lease` on every device, which is what holds the other devices back — and also what guarantees takeover after the lease.
- (Historical, still explains the schema:) the old in-app runner only fired the connect request after *its own cloud save containing the claim* was confirmed, checked against the exact saved-state object rather than a status flag. The server worker replaces this with claim-first CAS writes.
- Merge rule (same in both apps): claims staked within one lease of each other are a race — the side already in place (cloud is `current` in cross-device merges) wins, so the first save to land keeps the slot deterministically on every device. A claim a full lease newer is a takeover of an abandoned slot and wins regardless of side. The surviving claim is then re-checked against the merged `lastAttemptAt`.

**Why:** two devices with the same workspace open would otherwise each fire a real GitHub/website connect request per due source and overwrite each other's snapshots.

**How to apply:**
- The schedule merge lives in the mobile source state module *and* is mirrored in the desktop workspace-state module (desktop never runs scheduled syncs but its conflict saves must not drop a phone's claim). Any new schedule field or rule change must land in both, or desktop saves silently re-enable double syncs.
- Session identity is a fresh random token per app launch, deliberately not persisted: a prior session's claim must expire rather than be resumed.
- Plain UI-test mode never uploads, so the claim gate is bypassed there (claims would never confirm); the workspace-sync harness mode exercises the full protocol against the fake cloud.
- Accepted trade-off: a device that completes the connect call but dies before its completion save causes at most one repeat sync after the lease.
