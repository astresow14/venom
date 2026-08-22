import type {
  SharedWorkspaceSop,
  VenomSop,
  VenomSopAppAssignment,
  VenomSopContent,
  VenomSopDetail,
  VenomSopRevision,
} from '@workspace/api-client-react';

/**
 * The SOP endpoints are expected to answer with lists (and the detail
 * endpoint with a `{ sop, revisions, assignments }` record), but a failing
 * backend, an error payload, or an unauthenticated response can hand these
 * pages anything at all. Reading such a payload directly used to crash the
 * whole workspace route ("map is not a function"), so the pages resolve
 * their queries into these explicit states instead — the same contract the
 * Apps page uses in ./appPortfolio.
 */
export type SopLibraryState<TSop> =
  | { status: 'loading' }
  | { status: 'error'; reason: 'request-failed' | 'malformed-response' }
  | { status: 'empty' }
  | { status: 'ready'; sops: TSop[] };

export type SopDetailState =
  | { status: 'loading' }
  | { status: 'error'; reason: 'request-failed' | 'malformed-response' }
  | { status: 'ready'; detail: VenomSopDetail };

type SopQuery = { data: unknown; isLoading: boolean; isError: boolean };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) && value.every((item) => typeof item === 'string')
  );
}

/**
 * A record is renderable when it carries everything the cards and the
 * client-side search filter read: `category.replace`, `tags.some`, and
 * `content.purpose.toLowerCase` all throw on a missing field.
 */
function isSopShaped(value: unknown): boolean {
  if (!isRecord(value)) {
    return false;
  }
  const content = value.content;
  return (
    typeof value.id === 'string' &&
    value.id.length > 0 &&
    typeof value.title === 'string' &&
    typeof value.category === 'string' &&
    typeof value.lifecycle === 'string' &&
    isStringArray(value.tags) &&
    isRecord(content) &&
    typeof content.purpose === 'string'
  );
}

export function isVenomSop(value: unknown): value is VenomSop {
  return isSopShaped(value);
}

export function isSharedWorkspaceSop(
  value: unknown,
): value is SharedWorkspaceSop {
  return isSopShaped(value);
}

/** Returns the usable records, or null when the payload is not a list. */
function normalizeRows<TSop>(
  data: unknown,
  isRow: (value: unknown) => value is TSop,
): TSop[] | null {
  if (!Array.isArray(data)) {
    return null;
  }
  return data.filter(isRow);
}

export function normalizeSopList(data: unknown): VenomSop[] | null {
  return normalizeRows(data, isVenomSop);
}

export function normalizeSharedSopList(
  data: unknown,
): SharedWorkspaceSop[] | null {
  return normalizeRows(data, isSharedWorkspaceSop);
}

function resolveListState<TSop>(
  query: SopQuery,
  isRow: (value: unknown) => value is TSop,
): SopLibraryState<TSop> {
  if (query.isError) {
    return { status: 'error', reason: 'request-failed' };
  }
  if (query.isLoading || query.data === undefined) {
    return { status: 'loading' };
  }

  const sops = normalizeRows(query.data, isRow);
  if (sops === null) {
    return { status: 'error', reason: 'malformed-response' };
  }
  if (sops.length === 0) {
    // An empty list is a real empty library; a list we could not read a
    // single record out of is a broken response, not an empty one.
    return Array.isArray(query.data) && query.data.length > 0
      ? { status: 'error', reason: 'malformed-response' }
      : { status: 'empty' };
  }
  return { status: 'ready', sops };
}

export function resolveSopLibraryState(
  query: SopQuery,
): SopLibraryState<VenomSop> {
  return resolveListState(query, isVenomSop);
}

export function resolveSharedSopLibraryState(
  query: SopQuery,
): SopLibraryState<SharedWorkspaceSop> {
  return resolveListState(query, isSharedWorkspaceSop);
}

/**
 * The editor seeds a local draft by spreading every content list, so a
 * detail record is only editable when each list really is an array of
 * strings; anything else would throw while seeding or saving the draft.
 */
function isEditableSopContent(value: unknown): value is VenomSopContent {
  if (!isRecord(value)) {
    return false;
  }
  return (
    typeof value.purpose === 'string' &&
    isStringArray(value.prerequisites) &&
    isStringArray(value.inputs) &&
    isStringArray(value.guidance) &&
    isStringArray(value.requiredApprovals) &&
    isStringArray(value.acceptanceChecks)
  );
}

export function isEditableVenomSop(value: unknown): value is VenomSop {
  return (
    isRecord(value) &&
    isSopShaped(value) &&
    typeof value.provenance === 'string' &&
    isEditableSopContent(value.content)
  );
}

/** The revision history renders these fields, so each must be present. */
export function isVenomSopRevision(
  value: unknown,
): value is VenomSopRevision {
  if (!isRecord(value)) {
    return false;
  }
  const content = value.content;
  return (
    typeof value.id === 'string' &&
    value.id.length > 0 &&
    typeof value.versionNumber === 'number' &&
    typeof value.title === 'string' &&
    typeof value.category === 'string' &&
    typeof value.checksumSha256 === 'string' &&
    Array.isArray(value.tags) &&
    isRecord(content) &&
    typeof content.purpose === 'string'
  );
}

export function isVenomSopAssignment(
  value: unknown,
): value is VenomSopAppAssignment {
  return (
    isRecord(value) && typeof value.appId === 'string' && value.appId.length > 0
  );
}

/**
 * Returns a detail record shaped the way the editor reads it, or null when
 * the payload is not one. Unreadable revisions and assignments are dropped
 * rather than failing the whole record.
 */
export function normalizeSopDetail(data: unknown): VenomSopDetail | null {
  if (!isRecord(data)) {
    return null;
  }
  const sop = data.sop;
  const revisions = data.revisions;
  const assignments = data.assignments;
  if (!isEditableVenomSop(sop)) {
    return null;
  }
  if (!Array.isArray(revisions) || !Array.isArray(assignments)) {
    return null;
  }
  return {
    sop,
    revisions: revisions.filter(isVenomSopRevision),
    assignments: assignments.filter(isVenomSopAssignment),
  };
}

export function resolveSopDetailState(query: SopQuery): SopDetailState {
  if (query.isError) {
    return { status: 'error', reason: 'request-failed' };
  }
  if (query.isLoading || query.data === undefined) {
    return { status: 'loading' };
  }

  const detail = normalizeSopDetail(query.data);
  if (detail === null) {
    return { status: 'error', reason: 'malformed-response' };
  }
  return { status: 'ready', detail };
}
