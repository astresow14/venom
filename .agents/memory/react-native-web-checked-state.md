---
name: React Native Web checked state
description: Why checkbox and radio controls need explicit web ARIA state in addition to React Native accessibility state.
---

For cross-platform checkbox and radio controls rendered by React Native Web, mirror the control state to `aria-checked` as well as `accessibilityState`.

**Why:** A control can update visually while the browser accessibility tree continues to report it as unchecked when only React Native's `accessibilityState` is supplied. This breaks assistive technology and accessibility-aware browser tests.

**How to apply:** Keep the native `accessibilityRole` and `accessibilityState`, add the matching web ARIA state on shared controls, and verify the result through the browser accessibility tree plus keyboard interaction.