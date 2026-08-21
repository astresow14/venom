---
name: React Native Web modal focus handoff
description: Why an animated RN Web Modal strands keyboard focus when it closes, and how to hand focus back deterministically.
---

An animated `Modal` (`animationType="fade"`/`"slide"`) on React Native Web stays mounted for the
length of its exit animation, and its focus trap keeps a capturing `focus` listener on `document`
that whole time. Anything focused outside the dialog during that window is yanked back into the
closing dialog. When the trap finally unmounts it tries to restore focus to the element that was
active when it opened — if that element was unmounted meanwhile (for example a list row that moved
to another column while the dialog was open), focus falls to `<body>` and keyboard users lose their
place.

**Why:** This is invisible on a fast machine — the exit animation finishes before anything else
tries to take focus — so it shows up as a browser test that only fails on slow or throttled
machines. Emulating CPU throttling over CDP (`Emulation.setCPUThrottlingRate`) reproduces it
reliably; without throttling the same flow passes.

**How to apply:** When a dialog's result can move or replace the element that opened it, do not rely
on the trap's restore. Disable the modal's own animation on web so dismissal is immediate, keep
refs to the destination controls, and focus one explicitly from the modal's `onDismiss`. Choose the
target from current state (fall back when the preferred control is disabled) and make sure the
chosen control has a visible focus style. If the entrance animation mattered, animate the dialog's
own content instead of the modal container, and honour reduced motion.

When the dialog's action *deletes* the anchor element (e.g. "delete card" from an editor), compute
the focus destination from pre-mutation state — the next sibling, else the previous, else the
container's create control — and stash it before dispatching the delete; at `onDismiss` time the
deleted element and its refs are already gone, so nothing can be derived from it then.

Two more extensions of the pattern:

- If confirming the dialog unmounts its whole screen (e.g. it navigates back), `onDismiss` has
  nothing local to focus. Record the intent in a module-scoped single-slot handoff (with a short
  TTL so stale requests expire) and have the destination screen claim it in a `useFocusEffect`,
  focusing its landing control on the next animation frame.
- If the control that should receive focus is created by the dialog's own submit (e.g. a list card
  for a just-created record), keep the dialog open until the refetched list actually contains the
  new row, then close; otherwise the focus target does not exist at dismiss time. Guard the submit
  button with its own in-flight state so it stays disabled through the refetch.

Focus rings on this monochrome design need care: on filled (foreground-colored) controls a
`colors.primary` ring is invisible — use an inset ring in `colors.background` instead, which stays
visible in both themes.
