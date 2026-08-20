---
name: Expo Worklets under pnpm
description: Reliable Babel and cache handling for Expo apps using Worklets in pnpm-isolated workspaces.
---

An artifact-local Expo app using Worklets should directly own the `babel-preset-expo` version that matches its Expo SDK rather than relying on a transitive copy. After Babel preset or plugin changes, clear Metro's global cache and verify the bundle actually served by the running workflow contains compiled Worklets metadata.

**Why:** pnpm isolation can prevent an artifact-local Babel config from resolving a transitive preset. Separately, Metro can keep serving an older cached transform even when a one-off offline Babel transform looks correct, so offline success alone does not prove the browser or device received the repaired bundle.

**How to apply:** Keep the preset version aligned with Expo, load the Worklets plugin explicitly when required by the installed versions, restart with a cleared Metro cache, and inspect or exercise the live served bundle before declaring the runtime fixed.