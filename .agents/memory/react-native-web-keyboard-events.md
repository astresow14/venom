---
name: React Native Web keyboard events
description: How to handle raw browser keyboard events on React Native touchables when web-only JSX callbacks are filtered.
---

Do not assume a web-only raw keyboard callback passed to a React Native touchable will reach the rendered DOM. When a control needs keys beyond the component's built-in press handling, bind and clean up the browser event on the rendered host reference in a web-gated effect.

**Why:** In this Expo and React Native Web stack, tab index and ARIA props reached the DOM while an unsupported raw key callback was silently filtered, so arrow-key navigation looked correct in markup but never ran.

**How to apply:** Keep the native touchable behavior unchanged, isolate browser-only event binding behind the web platform check, remove listeners during cleanup, and verify focus movement plus activation in a real browser test.