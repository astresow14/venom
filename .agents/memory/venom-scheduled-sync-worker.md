---
name: Server-owned scheduled source sync
description: Design rules for the API-server worker that re-syncs scheduled Venom sources with no client open — claim-first CAS, scope limits, and test pitfalls.
---

# Server-owned scheduled source sync

The API server owns unattended source updates; the mobile app no longer runs
a scheduled-sync loop. The worker lives beside the connect routes and reuses
their extracted fetch builders, so scheduled refresh and interactive connect
cannot drift apart.

**Claim-first CAS is the dedup primitive.** The worker stamps
`schedule.lastAttemptAt` (preserving `lastError`) with a revision-checked
write *before* fetching anything. A claimed source is by definition no longer
due, so clients, other instances, and overlapping passes all skip it without
any coordination channel. Apply/failure writes are short CAS re-read loops;
losing every retry is safe to drop because the claim already re-paced the
source.
**Why:** any design that fetches first and reconciles later has a window
where a client refresh and the server both sync, and the workspace blob has
no row locks — revision CAS is the only fence.

**The worker only rewrites `state.sources` (+ a replacement tombstone when
the deterministic id moves).** It must not strip/absorb clusters or touch
ontology; legacy blobs migrate on the next client GET. Keeping the write
surface minimal is what makes the CAS loops safe to re-apply.

**Mirror, don't extract, when a concurrent task owns the client files.**
Pacing rules are duplicated server-side with cross-reference comments both
ways instead of a shared lib, because another in-flight task was editing the
client source-state module. Change the two sides together.

**How to apply:** any new unattended mutation of the workspace blob should
follow the same shape — claim via CAS, fetch outside the lock, re-read and
re-apply on conflict, bounded per-pass work (workspace scan cap, per-user
cap, per-pass sync cap, unref'd interval, overlap guard).

**Test pitfalls:**
- The connect builders stamp `syncedAt` with `new Date()` themselves; fixture
  clocks must be offsets from `Date.now()`, not a fixed date, or "fresh
  snapshot" assertions fail depending on wall time.
- GitHub URL → repository path parsing strips `.git` before trailing slashes,
  so `…/hello.git/` keeps its `.git` (client behavior, mirrored on purpose).
- Live smoke: insert a synthetic `venom_workspaces` row with a due source,
  wait one tick (60s), assert revision +2 and carried schedule, then delete
  the row. example.com works as a real fetch target.

**Client contract after the runner's retirement:** the mobile/desktop apps keep the claim + pacing code only to render cards and carry schedule bookkeeping through merges. An expired claim lease must read as "due now" (not "updating now"), the open app never re-syncs a due or abandoned source itself, and a device's own saves must round-trip a foreign claim untouched — the worker's CAS takeover depends on those exact fields surviving client merges. The claim e2e spec pins all three.

**Diagnostic:** when a spec asserts behavior a newer commit's architecture explicitly retired (e.g. client-run claim takeover after the runner moved server-side), `git log` the spec vs. the architecture commit before "fixing" the code back — a concurrent task branch can merge a spec that predates the retirement, and the suite stays contradictory until someone notices.
