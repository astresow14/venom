import type {
  ProvisioningCandidateRelease,
  VenomApp,
  VenomAppDetail,
  VenomAppTimelineEntry,
  VenomImportJob,
  VenomSourceVersion,
} from '@workspace/api-client-react';

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

/**
 * The detail endpoint is expected to answer with an
 * `{ app, versions, importJobs, ... }` record, but it fails the same way the
 * list does: the generated client resolves a 401 or a 5xx to the JSON error
 * body as data, and the page used to destructure and map straight over it.
 */
export type AppDetailState =
  | { status: 'loading' }
  | { status: 'error'; reason: 'request-failed' | 'malformed-response' }
  | { status: 'ready'; detail: VenomAppDetail };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) && value.every((item) => typeof item === 'string')
  );
}

function isNullableString(value: unknown): value is string | null | undefined {
  return value == null || typeof value === 'string';
}

/**
 * The detail page renders far more of the app than the cards do —
 * `app.id.split`, `app.detectedStack.join`, and the header fields all throw
 * on a missing value — so a detail record needs the full identity.
 */
function isDetailVenomApp(value: unknown): value is VenomApp {
  if (!isRecord(value)) {
    return false;
  }
  return (
    typeof value.id === 'string' &&
    value.id.length > 0 &&
    typeof value.name === 'string' &&
    typeof value.purpose === 'string' &&
    typeof value.brand === 'string' &&
    typeof value.status === 'string' &&
    isStringArray(value.detectedStack)
  );
}

/** The version cards read these (`checksumSha256.substring` throws). */
function isVenomSourceVersion(value: unknown): value is VenomSourceVersion {
  if (!isRecord(value)) {
    return false;
  }
  return (
    typeof value.id === 'string' &&
    value.id.length > 0 &&
    typeof value.versionNumber === 'number' &&
    typeof value.archiveFilename === 'string' &&
    typeof value.archiveBytes === 'number' &&
    typeof value.checksumSha256 === 'string' &&
    typeof value.createdAt === 'string'
  );
}

/** The job cards render these fields directly, so each must be readable. */
function isVenomImportJob(value: unknown): value is VenomImportJob {
  if (!isRecord(value)) {
    return false;
  }
  return (
    typeof value.id === 'string' &&
    value.id.length > 0 &&
    typeof value.status === 'string' &&
    typeof value.archiveFilename === 'string' &&
    typeof value.createdAt === 'string' &&
    isNullableString(value.failureCode) &&
    isNullableString(value.failureMessage)
  );
}

/** The evolution timeline renders every one of these per entry. */
function isVenomAppTimelineEntry(
  value: unknown,
): value is VenomAppTimelineEntry {
  if (!isRecord(value)) {
    return false;
  }
  return (
    typeof value.id === 'string' &&
    value.id.length > 0 &&
    typeof value.kind === 'string' &&
    typeof value.title === 'string' &&
    typeof value.status === 'string' &&
    typeof value.actor === 'string' &&
    typeof value.occurredAt === 'string' &&
    isNullableString(value.detail)
  );
}

/**
 * A release row is actionable when it carries the identity the release list
 * renders and the publish/rollback mutations post back (`provisioningRunId`,
 * confirm-by-`targetName`). Shared with the Build run page, which renders
 * the same rows out of the provisioning run record.
 */
export function isProvisioningRelease(
  value: unknown,
): value is ProvisioningCandidateRelease {
  if (!isRecord(value)) {
    return false;
  }
  return (
    typeof value.id === 'string' &&
    value.id.length > 0 &&
    typeof value.provisioningRunId === 'string' &&
    typeof value.status === 'string' &&
    typeof value.targetName === 'string' &&
    isNullableString(value.launchUrl) &&
    isNullableString(value.providerCandidateId) &&
    isNullableString(value.publishIdempotencyKey) &&
    isNullableString(value.rollbackIdempotencyKey)
  );
}

/**
 * Returns a detail record shaped the way the page reads it, or null when the
 * payload is not one. The app core and the lists the page maps over must be
 * present; unreadable child rows are dropped rather than failing the record.
 */
export function normalizeAppDetail(data: unknown): VenomAppDetail | null {
  if (!isRecord(data)) {
    return null;
  }
  const { app, versions, importJobs, provisioningReleases, timeline } = data;
  if (!isDetailVenomApp(app)) {
    return null;
  }
  if (
    !Array.isArray(versions) ||
    !Array.isArray(importJobs) ||
    !Array.isArray(timeline)
  ) {
    return null;
  }
  const readableTimeline = timeline.filter(isVenomAppTimelineEntry);
  return {
    app,
    versions: versions.filter(isVenomSourceVersion),
    importJobs: importJobs.filter(isVenomImportJob),
    // The resilient pages never read these two lists; carry them through
    // when they are lists so other readers keep their data, else default.
    deploymentLinks: (Array.isArray(data.deploymentLinks)
      ? data.deploymentLinks
      : []) as VenomAppDetail['deploymentLinks'],
    iterations: (Array.isArray(data.iterations)
      ? data.iterations
      : []) as VenomAppDetail['iterations'],
    provisioningReleases: Array.isArray(provisioningReleases)
      ? provisioningReleases.filter(isProvisioningRelease)
      : [],
    timeline: readableTimeline,
    timelineTotal:
      typeof data.timelineTotal === 'number' &&
      Number.isFinite(data.timelineTotal)
        ? data.timelineTotal
        : readableTimeline.length,
    timelineTruncated: data.timelineTruncated === true,
  };
}

export function resolveAppDetailState(query: {
  data: unknown;
  isLoading: boolean;
  isError: boolean;
}): AppDetailState {
  if (query.isError) {
    return { status: 'error', reason: 'request-failed' };
  }
  if (query.isLoading || query.data === undefined) {
    return { status: 'loading' };
  }

  const detail = normalizeAppDetail(query.data);
  if (detail === null) {
    return { status: 'error', reason: 'malformed-response' };
  }
  return { status: 'ready', detail };
}

/**
 * The detail query polls while an import job is active. The poll callback
 * sees the raw payload before any resolver runs, so it must read
 * defensively: an error body or a garbage row stops the poll, never throws.
 */
export function hasActiveImportJob(data: unknown): boolean {
  if (!isRecord(data) || !Array.isArray(data.importJobs)) {
    return false;
  }
  return data.importJobs.some(
    (job) =>
      isRecord(job) &&
      typeof job.status === 'string' &&
      !['complete', 'failed'].includes(job.status),
  );
}
