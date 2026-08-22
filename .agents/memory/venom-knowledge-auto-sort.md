---
name: Venom knowledge auto-sort
description: How chat-extracted knowledge self-files (personal / workspace / unsorted) with moves, notices, time-boxed undo, and suggestions after the nav scope switcher was removed.
---

# Venom knowledge auto-sort

**Rule:** Clients never send a workspace choice at capture. The server classifies each extracted item inside the one extraction call: personal, a specific workspace (membership rechecked after the model call), or an author-private `unsorted: true` holding state in the personal store. No memberships ⇒ personal with zero classification work. Chats in a company-shared project keep deterministic org filing (`filedScope`, clients never mirror org work locally).

**Why:** Both apps' nav dropped the Personal/workspace switcher — the scope decision users used to make silently at chat time. That deliberately relaxed the earlier "nothing personal flows into a company store automatically" line, replaced by guardrails: high-confidence filing only, the Unsorted buffer, notices with undo, and EVERY personal-store exit — unsorted included — being suggestion-only (accepting widens visibility; server re-checks membership at accept → 403 possible). Undo cannot un-disclose content, so consent must come before the move, not after.

**How to apply:**
- Unsorted is personal-store state: it syncs to the author's devices, survives both apps' merge rules, and must never appear in any workspace read or export. Personal exports take `scope: 'sorted' | 'unsorted'`.
- Move machinery rides the shared tombstone/merge helpers; every automatic move records a notice (`auto_file` | `refile`; re-filing is fenced against ping-pong). Only workspace→personal (visibility-narrowing) moves automatically; anything leaving the personal store — clarified unsorted items too — surfaces as a suggestion and transfers solely through the membership-rechecked accept endpoint. Classifier prompts are role-aware: admin-only workspace topic labels never reach a member's digest or the model provider.
- Undo is one transaction end to end: status claim, destination-store restore, and source-side re-creation commit or roll back together — separate commits can strand knowledge in neither store when the second step fails. It is also time-boxed (24h, lazy terminal `expired`) and drift-guarded: post-move `lastUpdatedAt` fingerprints are checked under row locks inside that same transaction (a separate pre-check reopens the lost-update race); any later edit refuses with `changed` instead of overwriting, and rows without fingerprints refuse fail-safe.
- Clients must treat an undo refusal as terminal: generated clients resolve non-2xx to the error body, so guard success on the parsed body shape — otherwise a 409/410 shows a false success toast.
- Both apps' Brain pages carry the whole surface: scope filter (Personal / each workspace / Unsorted), move notices with undo, and the unsorted review. Chat surfaces workspace filings with an inline undo; voice stays silent (the notice waits on the Brain page).
- Keep-personal is a client-local "mark sorted" (flag clear synced via workspace state), not a server move.
- Chat/voice extraction handlers: org `filedScope` early-return first, then `filed` → apply locally, legacy insight apply only when neither is present.
