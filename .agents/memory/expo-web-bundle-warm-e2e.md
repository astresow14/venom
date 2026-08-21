---
name: Expo web bundle warm-up for e2e
description: Playwright webServer readiness passes before Metro compiles the bundle; warm it in global setup or the first test absorbs the cold build.
---

Expo web dev servers answer `/` instantly with an HTML shell, but the script
tag behind it triggers a multi-minute Metro compile on first request. A
Playwright `webServer.url` readiness check therefore passes long before the
app is servable, and the first test eats the cold build — flaky timeouts
misread as regressions.

**Rule:** in global setup, fetch the shell, extract the bundle URL from its
script tag (never hardcode it — the path is version-pinned), and fetch that
until it returns 200. Cheap when already warm, decisive when cold.

**Cleanup rule:** never kill scratch dev servers by broad pattern match
(`pkill -f vite` and friends) — the same pattern matches workflow dev servers
and the webServer of a suite mid-run, and the suite's remaining tests all
fail on connection errors. Kill by recorded PID or exact port.
