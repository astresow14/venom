---
name: Expo browser testing route
description: How to target and authenticate the mobile Expo artifact reliably in browser tests.
---

Test Venom mobile interactions at the direct Expo development-domain root, not a path-prefixed shared-preview URL. For protected screens, establish Clerk authentication at the root and navigate with the mobile UI only after the signed-in shell renders.

**Why:** Shared path prefixes can resolve to the desktop artifact. Injecting a Clerk test session on a protected Expo deep link can also preserve the temporary callback path while that screen is unregistered, producing a misleading Expo not-found result.

**How to apply:** Open the direct Expo root, inject or complete authentication there, wait for the signed-in mobile shell, then use its navigation to reach protected screens. Confirm mobile-specific controls before trusting results.

Shell-launched background processes do not survive between commands here, so a browser suite that boots its own Expo server must finish inside one blocking command. A workflow-managed dev server persists instead, and the UI-test query flag works against an ordinary development server, so pointing the suite at the running artifact is the cheaper path.

The interactive testing subagent's browser may render the DESKTOP shell even when given the literal Expo dev-domain URL — its environment routes through the shared preview proxy regardless of the hostname it is told. Repeated re-instruction does not fix it. **How to apply:** if a tester report about the mobile app mentions desktop-only markers (a left drawer, `text-account-drawer` testids, Chat/Feed/Brain sidebar links), it is on the wrong app; stop retrying. Verify the Expo origin yourself with the screenshot tool (artifact `venom`, path `/`), and cover mobile behavior through the mobile Playwright web suite instead of the interactive tester.