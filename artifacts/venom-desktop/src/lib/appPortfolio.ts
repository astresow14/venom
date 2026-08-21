import type { VenomApp } from '@workspace/api-client-react';

/**
 * The portfolio endpoint is expected to answer with an array of apps, but a
 * failing backend, an error payload, or an unauthenticated response can hand
 * the page anything at all. Rendering such a payload directly used to crash the
 * whole workspace route ("apps?.map is not a function"), so the page resolves
 * the query into one of these explicit states instead.
 */
export type AppPortfolioState =
  | { status: 'loading' }
  | { status: 'error'; reason: 'request-failed' | 'malformed-response' }
  | { status: 'empty' }
  | { status: 'ready'; apps: VenomApp[] };

/** A record is renderable when it carries the identity the cards read. */
export function isVenomApp(value: unknown): value is VenomApp {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const candidate = value as Partial<VenomApp>;
  return (
    typeof candidate.id === 'string' &&
    candidate.id.length > 0 &&
    typeof candidate.name === 'string'
  );
}

/** Returns the usable records, or null when the payload is not a list. */
export function normalizeAppPortfolio(data: unknown): VenomApp[] | null {
  if (!Array.isArray(data)) {
    return null;
  }
  return data.filter(isVenomApp);
}

export function resolveAppPortfolioState(query: {
  data: unknown;
  isLoading: boolean;
  isError: boolean;
}): AppPortfolioState {
  if (query.isError) {
    return { status: 'error', reason: 'request-failed' };
  }
  if (query.isLoading || query.data === undefined) {
    return { status: 'loading' };
  }

  const apps = normalizeAppPortfolio(query.data);
  if (apps === null) {
    return { status: 'error', reason: 'malformed-response' };
  }
  if (apps.length === 0) {
    // An empty list is a real empty portfolio; a list we could not read a
    // single record out of is a broken response, not an empty one.
    return Array.isArray(query.data) && query.data.length > 0
      ? { status: 'error', reason: 'malformed-response' }
      : { status: 'empty' };
  }
  return { status: 'ready', apps };
}
