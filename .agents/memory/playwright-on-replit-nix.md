---
name: Playwright on Replit Nix
description: Why installing Playwright and downloading Chromium is insufficient for browser tests in this Replit environment, and how long suites must be run.
---

Playwright's downloaded Chromium binary still requires its native runtime libraries to be present in the Replit Nix environment.

**Why:** The browser package and binary installed successfully, but Chromium exited before startup because shared libraries such as GLib and GBM were unavailable.

**How to apply:** Preserve the project's explicit Nix browser-runtime dependencies when maintaining Playwright validation. After browser upgrades, verify the downloaded executable has no unresolved shared libraries before debugging the test itself.

**Long suites:** Detached (`setsid`/`nohup`) Playwright runs die silently here — no error, empty tail. Run long e2e suites foreground in chunks of spec files that fit a shell window; with the artifact dev workflows already up, warm runs are fast.