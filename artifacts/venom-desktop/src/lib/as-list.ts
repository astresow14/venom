/**
 * The generated API client resolves a failed request to the response body
 * rather than throwing, so a 401 or a 5xx hands back `{ error: "..." }` where
 * the caller's types promise an array. Mapping over that takes the whole page
 * down through the error boundary.
 *
 * Wrap every list query result in this so a failed request degrades to an
 * empty list and the surrounding page keeps rendering.
 *
 * This is the blunt version. Where a page needs to tell "empty" apart from
 * "broken response" and show different UI for each, use the richer
 * `resolveAppPortfolioState` in `./appPortfolio` instead.
 */
export function asList<T>(value: T[] | null | undefined): T[] {
  // The parameter type follows what the generated client *claims* to return, so
  // callers keep their element type; the check is here for what it actually
  // returns when the request fails.
  return Array.isArray(value) ? value : [];
}
