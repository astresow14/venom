---
name: Browser-testing the desktop workspace
description: Constraints that make desktop browser tests pass or silently no-op, and the class of bug they cannot see.
---

**Account-gated features must recognise the test account.** The dev-only UI-test mode
signs nobody in, so anything that gates on a real account id quietly returns early: the
click "works" and nothing happens, which reads as a UI bug rather than a missing session.
Feature code should fall back to the same placeholder account the workspace provider
seeds when that mode is on.

**Why:** without it, whole flows (sending, retrying) are untestable in the browser and
failures surface as missing elements instead of a clear cause.

**Reload assertions need a persistence path of their own.** The UI-test build skips cloud
sync entirely, so workspace state is memory-only unless it is mirrored locally; any browser
test that reloads and expects a thread, task, or message to survive depends on that mirror
existing.

**The browser-test server has no API behind it.** Stub every endpoint the page calls.
Treat unexpected response shapes defensively in components that map over a response — an
HTML error page reaching code that expects an array takes down the whole page through the
error boundary.

**Sync-dependent UI has its own opt-in.** Regular UI-test mode pins the workspace to
`synced` and never touches cloud endpoints, which makes failed-save UI (device-only
notices, retry affordances) untestable. `?venomWorkspaceSyncTest=true` (same param as
mobile) lifts only that pin: the real hydrate → debounce → save machinery runs and the
spec stubs `/api/venom/workspace` GET/PUT with Playwright routes. Everything else about
UI-test mode (placeholder account, quiet org machinery) stays. Specs not using the param
are provably unaffected — the gate collapses back to plain `IS_UI_TEST`.

**Don't gate fetches off in UI-test mode; let them run and fail softly.** Ontology
search and concept-detail reads (both apps) now execute in UI-test mode so specs can stub
`**/api/venom/ontology/**` and exercise the remote-data UI; the mobile app signs requests
with its UI-test stand-in token. Unstubbed specs still pass because every such read
catches failure and degrades to on-device state — the same offline fallback real users
get. An early `IS_UI_TEST` return makes the remote path untestable and hides nothing.

**UI-test mode cannot see hooks-after-early-return crashes.** Shell (and other gated
screens) early-return a skeleton until hydration is ready. In UI-test mode hydration is
effectively synchronous, so the not-ready render may never happen and a React hook
mistakenly declared *below* that early return passes every UI-test spec — then crashes
real users ("Rendered more hooks than during the previous render") the moment async
hydration completes, taking the whole shell down to the error boundary.

**Why:** the real-credential auth e2e suite is the only browser check that renders the
loading gate before the ready state; it caught exactly this when UI-test specs were green.

**How to apply:** declare all hooks in the block at the top of the component, above any
`if (!isReady) return`; when an auth-suite failure shows "element not found" on a
workspace testid, read the error-context YAML — an error-boundary heading there means a
render crash, not a slow page.

## Toast assertions double-match

Shadcn toasts render the title twice: the visible ToastTitle plus an
aria-live "Notification <title>" echo. `getByText('<toast title>')` hits a
strict-mode violation — assert with `.first()` or scope to the toast region.
