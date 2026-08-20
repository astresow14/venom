---
name: accessibility-baseline
description: Ensures user-facing UI meets a practical WCAG accessibility baseline. Use when building or changing pages, forms, navigation, dialogs, or public-facing components.
---

# Meet an accessibility baseline

Build to this baseline by default for customer-facing or public apps.

- Use semantic controls for their purpose. On web, use real buttons, links, headings, navigation, and main content rather than clickable generic containers.
- Ensure every interactive control is keyboard reachable and usable, with a visible focus indicator.
- Give inputs associated labels or accessible names. Icon-only controls need accessible names. Meaningful images need alt text; decorative images need empty alt text.
- Meet WCAG AA contrast for key text and UI controls. Never communicate state by color alone.
- Associate form errors with their input and communicate them without relying solely on color.
- Provide captions/transcripts for relevant media and respect reduced-motion preferences.
- Use ARIA only to fill semantic gaps. Manage focus and Escape behavior for dialogs.

## Before delivery

Verify primary flows with keyboard-only navigation where applicable, check focus order and visibility, and verify key text contrast. Report which checks were covered; do not claim complete WCAG compliance without a formal audit.