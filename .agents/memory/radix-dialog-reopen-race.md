---
name: Radix dialog reopen race
description: Why clicking a dialog trigger right after dismissing the same dialog does nothing, and how browser specs must wait it out.
---

Clicking a Radix `DialogTrigger` while the previous dialog instance is still
playing its exit animation gets swallowed: the closing content's dismissable
layer / overlay is still mounted, so the click never toggles the dialog open.
The click itself "succeeds" (no actionability failure), the dialog simply
never appears — in a spec this surfaces later as "element not found" on the
dialog's inner controls.

**Why:** Radix keeps the closing content mounted through its exit animation
(~200ms with the shared `animate-out` classes) and its dismiss guards eat
pointer events during that window. Humans rarely re-click within 200ms;
Playwright always does.

**How to apply:** In any spec that closes a dialog (Escape, cancel, submit)
and then reopens one, wait for the close to finish first:
`await expect(page.getByRole('dialog')).toHaveCount(0)` (or `alertdialog`)
before clicking the trigger again. Applies to Dialog and AlertDialog alike.
