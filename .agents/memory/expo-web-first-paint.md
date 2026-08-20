---
name: Expo web first paint
description: Which Expo HTML surface controls the browser paint before React mounts.
---

For an Expo Router app using the default single web output, set any required pre-React document background in the project’s public HTML template rather than relying on the Router custom HTML route.

**Why:** The development server can serve its SPA template before Router code runs, so a custom Router HTML component does not prevent an initial browser paint from using the template’s default background.

**How to apply:** When eliminating a cold-start color flash, inspect the HTML actually returned by the Expo dev server. If it is the single-output SPA template, customize the public HTML template and verify the computed `html`, `body`, and root backgrounds immediately after navigation commits.