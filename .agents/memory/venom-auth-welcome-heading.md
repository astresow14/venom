---
name: Venom auth welcome heading
description: The sign-in welcome's heading is screen-reader-only (the scrawled wordmark is the visible hero); both auth e2e suites anchor on that invisible heading.
---

The mobile sign-in welcome renders the large scrawled-wordmark reveal as its only visible headline. The accessible heading ("Sign in to Venom") is a 1x1 clipped, transparent-color Text with accessibilityRole="header" — the wordmark-hero mode of the shared auth shell, which also drops the small brand row so the mark is never drawn twice on that step.

**Why:** The emblem + "Strike first" tagline was explicitly rejected; the welcome must stay a single brand moment mirroring the web landing hero. Screen readers and BOTH e2e suites still need a heading: the hermetic welcome spec and the rarely-run live credential suite (e2e/auth) use `getByRole("heading", { name: "Sign in to Venom" })` as the signed-out arrival signal, including after sign-out.

**How to apply:**
- Playwright treats 1x1 clipped elements as visible (non-empty bounding box, no visibility:hidden), so the invisible heading works as a wait/assert target — don't "fix" specs by making it visible or by swapping the anchor without updating e2e/auth too.
- When restyling auth steps whose visible headline is artwork, keep an SR heading equivalent; the welcome step asserts exactly one `role img "Venom"` (hero) and the form steps exactly one (brand row).
