---
name: Desktop list payload trust
description: Venom Desktop pages must resolve list API responses into explicit states instead of mapping the payload directly.
---

Rule: a Venom Desktop page that renders a list from a generated react-query hook
must resolve the query into explicit loading / error / empty / ready states and
verify the payload is an array before mapping it. Never render `data?.map(...)`
straight from a query result.

**Why:** the generated client types promise an array, but a failing, proxied, or
unauthenticated backend answers with an object or a string. React only sees
`data.map is not a function`, which throws during render and hands the whole
workspace route to the top-level error boundary — a transient backend blip
becomes a full crash screen instead of a per-page error state.

**How to apply:** normalize in a small pure helper next to the page's lib code
so the malformed path is unit-testable without a browser, keep the failure state
recoverable with a refetch button (react-query re-renders the page in place, so
no reload is needed), and treat "array with no readable record" as broken rather
than empty so a shape change is visible instead of silently showing an empty
portfolio.
