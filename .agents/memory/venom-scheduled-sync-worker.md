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

**Unchanged snapshots skip the apply write.** After the claim, the freshly
built snapshot is compared deep-strict against the stored source with only
syncedAt and schedule stripped — the whole object, so an extra stored field
still forces the write. A skip is its own outcome but counts as a completed
sync in the pass budget (the fetch ran). Two guards: a pending
`schedule.lastError` must never skip, because the apply write is what clears
it (skipping would pin the card's failure and the hourly retry window
forever); and an id/projectId move is never "unchanged" — the tombstone
replacement path must run. The claim's lastAttemptAt doubles as the
user-visible "checked X ago" marker: the mobile card appends it whenever the
attempt outruns syncedAt by more than a minute, so a skipped write doesn't
read as a stalled schedule.
**Why:** every apply bumps the workspace revision, and every signed-in device
reacts by re-merging and re-uploading the blob — a daily cadence on a static
site is ~30 no-op full-blob churns a month per source.

**Measure before spending.** A pass first reads the whole scan window and
counts due sources per workspace, then drains due workspaces under a budget
that follows the measured backlog (base floor, surge ceiling, still one
source per user per pass). The summary line logs due/synced/deferred at warn
when work was deferred, info when busy, debug when idle — backlog growth must
show in the API logs before users feel it. Acting on a measurement that went
stale mid-pass is safe because the sync path re-reads and CAS-claims anyway.
**Why:** a budget derived only from what the pass attempted can never see the
queue behind it, so a same-hour burst of daily schedules silently runs late.
Two structural invariants: the scan window must exceed the surge ceiling or
the deferred signal can never fire, and cross-pass fairness rides on claim
writes bumping `updated_at` (serviced workspaces rotate behind waiters in the
updated_at-ASC scan).

**A count ceiling is not a time bound.** Slow-but-legal fetches (websites get
a 10s timeout each) times a serial surge can hold the single-flight worker
across several ticks — and the overlap guard then swallows those ticks
silently, killing the summary heartbeat exactly when upstreams degrade. Pair
any surge budget with a small parallel-claim pool (distinct users only; the
CAS fence already covers concurrency) plus a launch deadline under the tick
interval: in-flight syncs finish, the remainder defers loudly, and the
overlap-guard tick logs a warn with the running pass's age instead of
returning silently.

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

## A fixed scan window is a permanent shadow

The scan orders by updated_at ascending and claim writes bump updated_at — but only for rows that get attempted. Scheduled-but-not-yet-due rows are never rewritten, so a front page full of them (weeklies mid-cycle) camps the window forever, and an overdue row beyond it is unreachable no matter how many passes run. Fix shape: the first page always scans the front (keeps oldest-first priority and claim-bump rotation), later pages continue from an in-memory rotating keyset cursor with an (updated_at, user_id) tiebreak, bounded pages per pass, early-stop once the due count fills the budget, cursor reset on reaching table end. Corollary: a saturated scan must never log as an idle pass — "nothing due" is only certifiable when the scan reached the end of the order.
