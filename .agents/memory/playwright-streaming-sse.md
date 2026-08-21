---
name: Playwright streaming SSE stubs
description: How to assert in-progress streaming UI in browser tests when route.fulfill can only respond atomically.
---

`page.route(...).fulfill()` delivers the whole SSE body at once, so any transient streaming UI (typing panels, per-voice progress) collapses before an assertion can see it. To hold streaming states open, override `window.fetch` from `page.addInitScript` for the matching URL and return a `Response` wrapping a `ReadableStream` that enqueues `data: {...}\n\n` events with real `setTimeout` delays (~250 ms per event gives comfortable polling windows).

**Why:** Playwright has no progressive-fulfill API; the only place a stream can actually trickle is inside the page itself.

**How to apply:** pass the scripted events as the serializable `addInitScript` argument (delay/payload tuples), fall back to the original fetch for all other URLs, and keep end-state-only tests on plain `route.fulfill` — the override is only worth it when the in-progress UI itself is the assertion target. Works for clients using global `fetch`, and verified for `expo/fetch` on web: its `fetch.web.ts` re-exports `globalThis.fetch` at module evaluation, which happens after init scripts run, so the wrapper captures the override. When asserting reduced-motion behavior alongside, emulate via `page.emulateMedia` before `goto` (reanimated reads the media query once at bundle eval) and prove it applied with `matchMedia` inside the page.
