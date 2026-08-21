---
name: Generated API client returns error bodies as data
description: Why list pages crash with "x.map is not a function" and where the guard belongs.
---

The generated API client resolves a failed request to the response body instead
of throwing. A 401 or 5xx therefore hands the caller `{ error: "..." }` while
the generated types still promise an array. Any `data.map(...)`,
`data.length`, or `data.items.map(...)` then takes the whole page down through
the error boundary.

This is not a test-mode artifact. It happens in production on session expiry,
and it is the single most common crash class in the desktop workspace.

**Why:** the types are generated from the success schema only, so TypeScript
gives no warning at all. The failure is invisible until the request actually
fails.

**How to apply:**

- Wrap every list query result at the point it is read. `asList` in
  `artifacts/venom-desktop/src/lib/as-list.ts` is the blunt tool; the richer
  `resolveAppPortfolioState` in `lib/appPortfolio.ts` is for pages that need to
  distinguish "empty" from "broken response" in the UI.
- Guard nested fields too, not just the top-level payload — a paged endpoint's
  `.community` / `.items` are absent on the error body.
- Do **not** blanket-default to `[]` where the code distinguishes "still
  loading" (`undefined`) from "empty". Effects that seed selection state from a
  response must keep checking `Array.isArray`, or an unreadable response silently
  clears the user's selection.
- Verifying this needs an *unauthenticated* page load. Signed-in manual clicking
  hides the entire bug class.

## Two distinct failure modes, and when defaulting to `[]` is destructive

A list read can fail in two different ways, and a guard that handles only one
still leaves the bug open:

1. The query **rejects** — `isError` true, `data` undefined.
2. The request **resolves to the error body** — `isError` false, `data` is a
   non-array object.

Any fail-closed check must cover both, or a network/parse failure walks straight
past a guard written only for the error-body case.

Defaulting to `[]` is fine for read-only rendering, but it is **destructive on
any surface that saves the list back**. An unreadable catalog renders as "nothing
is selected", and the save button then submits an empty set and wipes the user's
real selection. On those surfaces, render an explicit error and disable saving
instead of degrading to an empty state.

Prefer `isPending` over `isLoading` when deriving "settled": for a query that is
enabled but has not started fetching, `isLoading` is already false, so an
`isLoading`-based check flashes a spurious error before the request begins.
