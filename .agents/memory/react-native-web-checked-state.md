---
name: React Native Web ARIA state
description: Why checked/expanded control state needs explicit web ARIA props in addition to React Native accessibility state.
---

For cross-platform controls rendered by React Native Web, mirror stateful accessibility (`checked`, `expanded`) to the explicit web ARIA prop (`aria-checked`, `aria-expanded`) as well as `accessibilityState`.

**Why:** A control can update visually while the browser accessibility tree reports nothing: `accessibilityState={{ checked }}` can fail to update `aria-checked`, and `accessibilityState={{ expanded }}` never reaches the DOM at all on the RN Web version in use (the attribute is simply absent). This breaks assistive technology and accessibility-aware browser tests.

**How to apply:** Keep the native `accessibilityRole` and `accessibilityState` for iOS/Android, add the matching `aria-*` prop alongside (RN passes it through on web), and verify via the rendered DOM attribute in a browser test — not the RN props.