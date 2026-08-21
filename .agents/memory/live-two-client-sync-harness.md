---
name: Live two-client sync verification
description: How to prove cross-device sync claims with two real signed-in browser clients against the live API, and the Clerk/headless traps that break it.
---

# Live two-client sync verification

Pattern for proving "data written on device A renders on device B" claims that
UI-test modes cannot cover (mobile UI-test mode fakes the cloud in-page;
desktop UI-test mode skips cloud sync entirely): one headless chromium, two
browser contexts (Expo web at a phone viewport + desktop web), both signed
into the same real account, real API server and database, stubbing **only**
the AI endpoints for determinism. A checked-in harness of this shape lives
under `scripts/live/` (not part of any CI suite).

## Clerk auth from headless automation

- **Sign-up is CAPTCHA-blocked.** Programmatic `signUp.create` from headless
  chromium fails with `captcha_invalid` (invisible CAPTCHA). Bot protection
  applies to sign-ups only — so create the test user server-side via the
  Backend API (`POST https://api.clerk.com/v1/users` with the secret key,
  `+clerk_test@example.com` email, password), then only ever sign **in**.
- **Fresh headless clients are untrusted.** Password sign-in returns
  `needs_client_trust`; resolve it like the mobile app does — email_code
  second factor (`prepareSecondFactor`/`attemptSecondFactor`), code `424242`
  for `+clerk_test` accounts.
- `window.Clerk` is available on both the Expo web page and the desktop page;
  drive the classic clerk-js resource API via `page.evaluate`, then
  `Clerk.setActive({ session })`.

## Diagnostic signatures

- **A ~700ms loop of PUT 400s on the workspace endpoint** means the client
  state fails server schema validation and the debounced save retries
  forever. Usual culprit in fixtures: closed enums — `voiceId` and `modelId`
  accept only their canonical values, so invented ids poison every save.
  Consequence: deliberation fixtures on both devices share the same voice-id
  trio; scope assertions by unique take/collective text, never by voice id.
- **RN Web chat list DOM order is not oldest-first.** `.last()` on a
  duplicated testid may target the oldest message. Expand/assert via
  text-filtered locators (`getByTestId(...).filter({ hasText })`) instead of
  positional selection.
- Strongest citation-fallback assertion: page-level
  `getByText("[source:").count() === 0` on the receiving device, plus the
  archived label inside the specific take.
- **One PUT 500 followed by endless 409s** means the save committed and bumped
  the revision but the response hydration crashed afterwards — check the API
  server log for a failed ontology/knowledge query. Root cause so far: the dev
  database schema lagging behind freshly merged code; `drizzle-kit push` (db
  package `push` script) then an api-server restart fixes it. A long-running
  dev server can mask this — the breakage only appears once the workflow
  restarts onto the new code.

**Why:** schema contract tests cover shapes, but only a live two-client run
catches auth flows, save loops, and render-order traps; these three cost the
most wall-clock time to rediscover.

**How to apply:** reuse the harness pattern (and its Clerk helpers) whenever a
task demands live proof that synced state survives the trip between the phone
and desktop clients.
