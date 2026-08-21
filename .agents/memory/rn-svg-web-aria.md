---
name: react-native-svg web ARIA
description: Which accessibility props are safe on react-native-svg components when the app also runs on web.
---

Rule: on `Svg` elements, set `accessibilityRole="image"` and `accessibilityLabel`, but never the bare `accessible` prop.

**Why:** react-native-svg on web forwards `accessible` straight to the DOM, producing the React error "Received `true` for a non-boolean attribute `accessible`". The role/label props map cleanly to `role`/`aria-label`.

**How to apply:** any branded/informative SVG in the Expo app (marks, wordmarks, illustrations) gets role+label only; decorative ones get neither. Verify in the browser console after adding accessibility props to react-native-svg components.
