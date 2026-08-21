---
name: Headless Clerk credential-flow e2e
description: How to drive the real hosted Clerk sign-in/sign-up forms from headless Playwright — testing tokens, the client-side CAPTCHA pin, and instance policies.
---

Rule: to e2e the real Clerk forms headlessly, bypass bot protection on BOTH sides — mint a Backend API testing token (`POST https://api.clerk.com/v1/testing_tokens`) and append `__clerk_testing_token` to every FAPI `/v1/*` request via `page.route`, AND pin `Clerk.client.captchaBypass` to true (defineProperty getter, after `Clerk.loaded`) before submitting sign-up.

**Why:** the testing token only disables server-side captcha *validation*. clerk-js still runs its Turnstile *widget* before POSTing unless the client resource carries `captcha_bypass` — and the managed dev instance does not set that flag from the token alone, so headless sign-up stalls forever on an interactive "Verify you are human" checkbox. (`getCaptchaToken` in clerk-js returns early on `clerk.client.captchaBypass`.) Without the network token, programmatic and form sign-ups fail `captcha_invalid`; without the client pin, the form never POSTs. Both were confirmed empirically — the programmatic probe with token got through to a *password policy* error instead of a captcha error.

**How to apply:**
- Decode the FAPI host from the publishable key (base64 payload after `pk_test_`, strip trailing `$`) and match routes by hostname + `/v1/` path prefix.
- Sign-in test accounts: create server-side (`POST /v1/users`) with a `+clerk_test@example.com` address; verification code is always `424242`. This instance's password policy requires **≥15 characters**.
- Handle one-/two-step form layouts adaptively (`input[name=identifier]`, then password if not already visible) and treat the OTP step as optional: wait for `input[autocomplete="one-time-code"]` OR the signed-in shell, whichever appears.
- Worker-scoped credentials (`Date.now()`-derived email+password at module scope) stay self-consistent because a Playwright retry always gets a fresh worker; clean up users in afterAll via the Backend API.
- Serve the app under a NON-root BASE_PATH in the auth suite so redirect assertions catch dropped artifact prefixes; keep the suite out of the hermetic config (`testIgnore`) since it needs network + secrets.
- Venom Desktop wiring: `artifacts/venom-desktop/playwright.auth.config.ts`, helpers in `e2e/support/clerk-backend.ts`, run via `pnpm --filter @workspace/venom-desktop run test:e2e:auth`.
