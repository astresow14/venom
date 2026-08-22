---
name: CI PR-gate budget
description: The mirror's Kanban gate runs both viewport projects under a 45-minute budget; the suite is CPU-bound (2 workers max useful); phone-only specs skip desktop by design.
---

The mirror's two required checks ("Kanban browser regression", "Desktop workspace browser regression") are named in the repo ruleset — never rename the jobs or the ruleset stops matching. The Kanban job runs the venom Playwright suite at **both** viewport sizes under `timeout-minutes: 45` in `.github/workflows/venom-kanban-e2e.yml`; workflow files are editable from this workspace as long as a workflow-capable credential (currently a fine-grained PAT in `GITHUB_TOKEN`) stays valid.

**Measured (Aug 2026, 4-vCPU hosted runner, 2 workers):** warmup + mobile (138 executed) + desktop (39 executed, 99 skipped) took 12.4 min for the E2E step, 13.4 min for the whole job. Doubling the projects did **not** double wall time because most specs declare themselves phone-only.

**Why desktop executes far fewer tests than it lists:** many specs open with a per-spec guard (`test.skip(testInfo.project.name === "desktop-chromium", "…covered at the mobile viewport")`). These skips are project-name-based, never CI-based, so local full runs and CI behave identically. This is the intended lever for keeping the desktop pass lean — a spec whose flow adds no desktop-specific coverage should declare itself phone-only rather than shrinking the job budget's headroom.

**Why the suite cannot brute-force speed:** the specs are CPU-bound on hosted runners (SwiftShader GL rendering; Metro shares the vCPUs). A third worker measurably slowed individual tests and flaked the timing-sensitive swipe/keyboard specs into retries. Two workers on CI, one locally.

**How to apply:** when a mirror check nears or trips its budget, pull the job log via the API — the `list` reporter names each test's duration, so an overrun identifies its cause. Durable startup levers that keep the suite fast: UI-test mode must not gate first render on `ClerkLoaded`; expensive GL layers mount lazily on first use, never at app boot; specs that don't assert GL content should pin the cheapest tier or disable it.
