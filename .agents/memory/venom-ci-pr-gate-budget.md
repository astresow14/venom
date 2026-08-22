---
name: CI PR-gate budget
description: The mirror's required PR checks run under fixed 15-minute job budgets that cannot change without a workflow credential; the venom suite is CPU-bound, so CI runs the mobile project only.
---

The mirror's two required checks ("Kanban browser regression", "Desktop workspace browser regression") run in GitHub jobs with `timeout-minutes: 15`. Until a workflow-capable credential exists, `.github/workflows/` cannot be edited from this workspace, so that budget is **fixed** — but the package scripts and Playwright configs the jobs invoke ship in every sync, and that is the lever.

**Why the venom suite cannot brute-force it:** the specs are CPU-bound on hosted runners (SwiftShader GL rendering; Metro shares the vCPUs). Adding workers does not create capacity when the resource is CPU — measured gains were marginal and flaked timing-sensitive specs into retries. Running every spec across both viewport projects simply does not fit the budget.

**Current shape:**
- On CI (`process.env.CI`), the venom Playwright config runs **warmup + mobile-chromium only** with 2 workers, traces on-first-retry, `list` reporter so an overrun names the slow tests.
- The desktop-viewport pass of the same specs is **not lost**: the package `test` script (run by Replit task validation on every merge) executes both projects locally, plus the venom-desktop suite.
- Once a workflow credential lands, prefer raising the job budget or sharding jobs in the yml and restoring the desktop project on CI.

**How to apply:** when a mirror check times out (`conclusion: cancelled` at ~15m), do not iterate blind — pull the job log via the API, and remember only config/scripts are editable from here. When adding heavy specs, remember every CI-visible spec runs inside this fixed budget. Durable startup levers that keep the suite inside it: UI-test mode must not gate first render on `ClerkLoaded`; expensive GL layers mount lazily on first use, never at app boot; specs that don't assert GL content should pin the cheapest tier or disable it.
