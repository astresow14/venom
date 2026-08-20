---
name: Expo browser testing route
description: How to target and authenticate the mobile Expo artifact reliably in browser tests.
---

Test Venom mobile interactions at the direct Expo development-domain root, not a path-prefixed shared-preview URL. For protected screens, establish Clerk authentication at the root and navigate with the mobile UI only after the signed-in shell renders.

**Why:** Shared path prefixes can resolve to the desktop artifact. Injecting a Clerk test session on a protected Expo deep link can also preserve the temporary callback path while that screen is unregistered, producing a misleading Expo not-found result.

**How to apply:** Open the direct Expo root, inject or complete authentication there, wait for the signed-in mobile shell, then use its navigation to reach protected screens. Confirm mobile-specific controls before trusting results.