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

## Signed-out auth coverage

`auth-welcome.spec.ts` is the one spec that runs outside UI-test mode: it
navigates with `?venomUiTest=false`, which overrides the baked-in
`EXPO_PUBLIC_VENOM_UI_TEST=true` (see `context/VenomContext.tsx`) so the real
Clerk-gated welcome/sign-in flow renders. It needs no credentials and makes no
real sign-in attempts — every `POST /v1/client/sign_ins` is stubbed with a
deterministic 422. Clerk's script/environment/client loads stay live; the
whole suite already depends on those on every page load because `ClerkLoaded`
gates all rendering.

## Live credential-flow suite (`e2e/auth`)

`e2e/auth/auth-session.spec.ts` drives the REAL Clerk credential flow — no
UI-test mode, no stubbed sign-ins — through its own config,
`playwright.auth.config.ts`, whose web server does not bake
`EXPO_PUBLIC_VENOM_UI_TEST` into the bundle. It signs a server-created
`+clerk_test` account into the stepped forms, asserts arrival on the chat
screen, covers account creation and sign-out, and deletes its test users via
the Backend API afterwards.

It needs network access to Clerk plus `CLERK_PUBLISHABLE_KEY` and
`CLERK_SECRET_KEY` (workspace secrets), so it is excluded from this hermetic
suite (`testIgnore: "**/auth/**"`) and never runs in CI. The server listens on
port 22171 (`VENOM_AUTH_E2E_PORT`) so it cannot collide with the hermetic
suite's 22167. Run it with:

```
pnpm --filter @workspace/venom run test:e2e:auth
```

## Verifying the guard

Temporary failing assertions must never be merged. To prove the required check
still blocks a broken board, add the failing assertion on a scratch branch,
confirm the check fails, then close the branch without merging it.
