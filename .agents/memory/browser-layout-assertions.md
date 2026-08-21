---
name: Browser layout assertions
description: How to assert safe areas, emulation modes, and internal scrolling reliably in Playwright against this workspace's UIs.
---

Layout contracts that only exist in a real browser (safe areas, internal
scrolling, reduced motion) need these precautions or the assertions quietly
pass while testing nothing.

## Safe-area insets must be emulated over CDP

Chromium resolves `env(safe-area-inset-*)` to `0` unless the emulated device
reports insets, so padding rules built on them have no observable effect by
default. Emulate them with the CDP command `Emulation.setSafeAreaInsetsOverride`
on a session from the page's context, and assert the *delta* between a run
without insets and a run with them — the shift should equal the inset exactly.

**Why:** Absolute padding assertions encode unrelated design padding and break
on any restyle; the delta only encodes the safe-area contract itself.

**How to apply:** Pair the emulation with a full-height notched viewport.
Short viewports plus notch insets describe a device that does not exist and
produce failures caused by the contrived combination, not by the code.

## Verify that an emulation mode actually applied

Some Playwright emulation options are silently ignored when passed through
`test.use` (reduced motion was, in 1.62); the test then re-runs the default
mode and reports a pass. Emulate on the page (`page.emulateMedia`) and assert
the mode from inside the browser (`matchMedia(...).matches`) before relying on
it.

**Why:** A silently ignored option turns a whole describe block into a
duplicate of the default-mode suite without any failure to reveal it.

## Finding the element that actually scrolls

`scrollHeight > clientHeight` is also true for `overflow: visible` elements, so
walking up the ancestors on that test alone finds an element whose `scrollTop`
can never move. Require a computed `overflow` of `auto` or `scroll` as well.

Scroll with `scrollTo({ behavior: 'instant' })`: containers styled
`scroll-smooth` animate the assignment, so reading the offset immediately after
`scrollTop += n` returns the pre-animation value.

**Why:** Both failure modes look like "the panel does not scroll" and send you
debugging the application instead of the test.

**How to apply:** Locating the scroll owner by observable layout keeps these
checks free of test ids and class names, which matters because the layout being
asserted is exactly what a restyle changes.
