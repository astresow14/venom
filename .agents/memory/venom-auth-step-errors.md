---
name: Venom stepped auth errors
description: Clerk field errors persist across step switches in stepped auth screens; gate error display per step.
---

In the Venom mobile auth screens, a step-based flow (welcome → credentials → code) shares one Clerk sign-in attempt. Clerk's `errors.fields.*` state survives local step navigation, so a failed credentials attempt keeps its field error alive after the user backs out to a step that no longer shows those fields.

**Why:** A browser test caught "Couldn't find your account." still rendered on the welcome state after backing out of the credentials step — clearing local `formError` is not enough because the Clerk hook owns the field errors and only clears them on the next request or `reset()`.

**How to apply:** When rendering a shared error slot in a multi-step auth screen, surface field-level Clerk errors only on the step that owns those fields (e.g. `step === 'welcome' ? formError : formError ?? clerkError`). Local screen errors can show anywhere; borrowed hook state cannot.
