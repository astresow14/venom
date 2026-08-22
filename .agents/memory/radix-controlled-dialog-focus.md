---
name: Radix controlled dialog focus return
description: A controlled Radix Dialog with no DialogTrigger drops focus to body on close; restore the opener yourself via onCloseAutoFocus.
---

# Radix controlled dialog focus return

**Rule:** when a Radix `Dialog` is fully controlled (`open`/`onOpenChange`) and rendered without a `DialogTrigger`, closing it strands keyboard focus on `<body>`. Radix's `DialogContent` default close handler is `event.preventDefault(); context.triggerRef.current?.focus()` — with no trigger registered, the ref is null, and the preventDefault also suppresses FocusScope's own "restore previous element" fallback. Nothing gets focus.

**Why:** hit while merging the model library into the composer's models & voices popup: the chip, gear, and Voices button all open one shared dialog with `setOpen(true)`, so there is no single Radix trigger. `expect(chip).toBeFocused()` after Escape failed steadily ("inactive") — not a timing race.

**How to apply:**
- Capture the opener at open time, where the click handler runs: `openerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null; setOpen(true)`.
- Pass `onCloseAutoFocus` on the `DialogContent`: if `openerRef.current?.isConnected`, call `event.preventDefault()` then `opener.focus()`. Because Radix composes handlers with `checkForDefaultPrevented`, your preventDefault also skips its internal trigger-focus handler.
- Don't try to read `document.activeElement` inside the dialog's own effect on open — Radix moves focus into the content in its own effect and the ordering is fragile.
- E2e: assert the round trip (`Escape` → `getByRole('dialog')` count 0 → opener `toBeFocused()`); it is the only signal that catches this regression.
