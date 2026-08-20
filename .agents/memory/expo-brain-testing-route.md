---
name: Expo Brain testing route
description: How to avoid accidentally exercising Venom Desktop while validating the mobile Expo artifact.
---

Test Venom mobile interactions at the Expo development domain root, not at a path-prefixed `/venom` URL. Confirm the mobile Brain by its mobile tab bar and “Living ontology” accessibility label before trusting gesture results.

**Why:** Path-prefixed Brain URLs can resolve to the desktop static artifact, producing plausible-looking but invalid “mobile” gesture results.

**How to apply:** For Expo browser checks, target the Expo artifact root and navigate with the mobile UI. Treat the desktop “Knowledge map. Drag to orbit…” label as a wrong-artifact signal.