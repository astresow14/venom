---
name: Venom mobile e2e harness
description: Run Expo web specs through the package Playwright config, never a hand-rolled expo start
---

Run the Expo package's browser specs through its own Playwright config; the config's `webServer` supplies the required `EXPO_PUBLIC_*` env and owns the server lifecycle.

**Why:** The app throws at module load when `EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY` is missing, so a manually started `expo start --web` yields a blank page, and orphaned expo children keep the shell hanging afterward.

**How to apply:** Invoke `playwright test` from inside the Expo package (point `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` at the system chromium). Only set the base-URL override when targeting a server already started with the package's dev script env. On failure, read the `error-context.md` accessibility snapshot before re-running.

UI-test mode has no Clerk session, so any account-gated query (`enabled: Boolean(user?.id)`) silently never fires and its stub never gets hit; gate on the UI-test placeholder id instead (`IS_UI_TEST ? UI_TEST_USER_ID : user?.id`), the same rule the desktop app follows. Deep links like `/settings?venomUiTest=true` or `/knowledge?venomUiTest=true&brainFixture=cited` work — module-scope flags and the brain fixture both read the initial URL's query.
