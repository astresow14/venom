---
name: Venom signed-out auth e2e
description: How the mobile browser suite reaches the Clerk-gated welcome/sign-in screens, and the CI=1 Metro pitfall that fakes green mutation runs
---

The mobile e2e server bakes `EXPO_PUBLIC_VENOM_UI_TEST=true` into the bundle, which makes every `/(auth)` route redirect into the workspace. The signed-out welcome/sign-in flow is reachable only via the explicit query opt-out `?venomUiTest=false` (dev web bundles only; it beats both the env flag and `venomUiTest=true`).

**Why:** UI-test mode treats the placeholder user as signed in, so auth screens had zero persistent coverage until the opt-out existed; a stale credential error leaking onto the welcome state shipped unnoticed once.

**How to apply:**
- Clerk init (script/environment/client GETs) is a live suite-wide dependency — `ClerkLoaded` gates all rendering, every spec already waits on it. Do not try to stub the whole Clerk boot; stub only the mutation endpoints (`POST **/v1/client/sign_ins**` → deterministic 422) so no credentials are needed.
- A CI-parity server for iteration: scratch workflow running the package's `expo start --web` with the suite's env, plus `VENOM_E2E_BASE_URL` for short bounded Playwright calls. Remove it before completion validation or it holds port 22167 against the suite's own webServer.
- **`CI=1 expo start` disables Metro file watching.** Edits after boot are silently ignored, so a mutation test against such a server passes vacuously. Before trusting any deliberate-failure run, grep the served bundle for a marker string from the mutation; use a non-CI server (watching on) for mutate/restore cycles.
