---
name: Browser-testing the desktop workspace
description: Two constraints that make desktop browser tests pass or silently no-op.
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

**Don't gate fetches off in UI-test mode; let them run and fail softly.** Ontology
search and concept-detail reads (both apps) now execute in UI-test mode so specs can stub
`**/api/venom/ontology/**` and exercise the remote-data UI; the mobile app signs requests
with its UI-test stand-in token. Unstubbed specs still pass because every such read
catches failure and degrades to on-device state — the same offline fallback real users
get. An early `IS_UI_TEST` return makes the remote path untestable and hides nothing.
