# Venom browser regression suite

These Playwright specs back the **Kanban browser regression** check, which is a
required status check on `main` with no bypass actors. If the check fails, no
pull request that touches Venom can merge, so keep the contract below intact.

## What CI starts

`.github/workflows/venom-kanban-e2e.yml` starts exactly one server: Expo web on
`http://127.0.0.1:22167`. It exports `VENOM_E2E_BASE_URL`, which makes
`playwright.config.ts` skip its own `webServer` block and reuse that server.

Two consequences:

- The root `pnpm test:e2e:venom` script must stay scoped to `@workspace/venom`.
  If it ever also runs another package's Playwright suite, that suite has no
  server in this job and the required check fails. The Venom Desktop suite has
  its own workflow (`venom-desktop-e2e.yml`), where Playwright starts Vite
  itself.
- No API server runs in CI. Every spec must stub its backend calls with
  `page.route("**/api/venom/...")`; a spec that expects a live API will fail
  only in CI.

## Local runs

`pnpm --filter @workspace/venom run test:e2e` leaves `VENOM_E2E_BASE_URL` unset,
so Playwright starts Expo web itself on port 22167. Override the port with
`VENOM_E2E_PORT`, or point the suite at an already running server with
`VENOM_E2E_BASE_URL`.

## Verifying the guard

Temporary failing assertions must never be merged. To prove the required check
still blocks a broken board, add the failing assertion on a scratch branch,
confirm the check fails, then close the branch without merging it.
