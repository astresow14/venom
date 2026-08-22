import type {
  ProvisioningRun,
  ProvisioningRunEvent,
  ProvisioningRunSummary,
  VenomBuildPackage,
  VenomBuildPackageRevision,
  VenomBuildRun,
  VenomBuildRunEvent,
  VenomBuildRunSummary,
} from '@workspace/api-client-react';

import { isProvisioningRelease } from './appPortfolio.ts';

/**
 * The build-run endpoints are expected to answer with a run record (and the
 * provisioning endpoints with a run list / run record), but the generated
 * client resolves a failed request — a 401, a 5xx, an unavailable API — to
 * the JSON error body as data. The Build run page used to read
 * `run.revisions.map` and `provRun.events.map` straight off such a payload
 * and crash the route, so it resolves its queries into these explicit
 * states instead — the same contract as ./sopLibrary and ./appPortfolio.
 */
export type BuildRunDetailState =
  | { status: 'loading' }
  | { status: 'error'; reason: 'request-failed' | 'malformed-response' }
  | { status: 'ready'; run: VenomBuildRun };

export type ProvisioningRunsState =
  | { status: 'loading' }
  | { status: 'error'; reason: 'request-failed' | 'malformed-response' }
  | { status: 'empty' }
  | { status: 'ready'; runs: ProvisioningRunSummary[] };

export type ProvisioningRunDetailState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'error'; reason: 'request-failed' | 'malformed-response' }
  | { status: 'ready'; run: ProvisioningRun };

type RecordQuery = { data: unknown; isLoading: boolean; isError: boolean };

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
 * The package inspection renders every one of these fields: the product
 * brief lists are mapped, the eight scope lists are mapped and diffed with
 * `.includes`, and the reference rows call `checksumSha256.substring`.
 */
function isBuildPackage(value: unknown): value is VenomBuildPackage {
  if (!isRecord(value)) {
    return false;
  }
  const brief = value.productBrief;
  if (
    !isRecord(brief) ||
    typeof brief.summary !== 'string' ||
    !isStringArray(brief.audience) ||
    !isStringArray(brief.outcomes)
  ) {
    return false;
  }
  if (
    !isStringArray(value.functionalScope) ||
    !isStringArray(value.brandDirection) ||
    !isStringArray(value.contentRequirements) ||
    !isStringArray(value.serviceFlowRequirements) ||
    !isStringArray(value.dataNeeds) ||
    !isStringArray(value.integrationNeeds) ||
    !isStringArray(value.acceptanceChecks) ||
    !isStringArray(value.launchConstraints)
  ) {
    return false;
  }
  return (
    Array.isArray(value.sourceReferences) &&
    value.sourceReferences.every(
      (row) =>
        isRecord(row) &&
        typeof row.appName === 'string' &&
        typeof row.versionNumber === 'number' &&
        typeof row.checksumSha256 === 'string',
    ) &&
    Array.isArray(value.sopReferences) &&
    value.sopReferences.every(
      (row) =>
        isRecord(row) &&
        typeof row.title === 'string' &&
        typeof row.revisionNumber === 'number' &&
        typeof row.checksumSha256 === 'string',
    ) &&
    Array.isArray(value.permissionRequests) &&
    value.permissionRequests.every(
      (row) =>
        isRecord(row) &&
        typeof row.capability === 'string' &&
        typeof row.reason === 'string' &&
        typeof row.required === 'boolean',
    )
  );
}

function isBuildPackageRevision(
  value: unknown,
): value is VenomBuildPackageRevision {
  if (!isRecord(value)) {
    return false;
  }
  return (
    typeof value.id === 'string' &&
    value.id.length > 0 &&
    typeof value.revisionNumber === 'number' &&
    isBuildPackage(value.package)
  );
}

/** The activity log renders these three fields per event. */
function isBuildRunEvent(value: unknown): value is VenomBuildRunEvent {
  if (!isRecord(value)) {
    return false;
  }
  return (
    typeof value.id === 'string' &&
    value.id.length > 0 &&
    typeof value.eventType === 'string' &&
    typeof value.message === 'string' &&
    typeof value.createdAt === 'string'
  );
}

/**
 * The Build runs sidebar on the App detail page renders these fields per
 * row; a row missing them is dropped rather than crashing the card.
 */
export function isVenomBuildRunListRow(
  value: unknown,
): value is VenomBuildRunSummary {
  if (!isRecord(value)) {
    return false;
  }
  return (
    typeof value.id === 'string' &&
    value.id.length > 0 &&
    typeof value.status === 'string' &&
    typeof value.createdAt === 'string'
  );
}

/**
 * Returns a run record shaped the way the page reads it, or null.
 *
 * Revisions carry approval identity: approving always targets
 * `revisions[0]`, so silently dropping an unreadable row could re-point the
 * approval at an older revision. A run whose revision list cannot be fully
 * read is therefore unreadable as a whole. Events are display-only, so
 * unreadable event rows are dropped instead.
 */
export function normalizeBuildRun(data: unknown): VenomBuildRun | null {
  if (!isRecord(data)) {
    return null;
  }
  if (
    typeof data.id !== 'string' ||
    data.id.length === 0 ||
    typeof data.status !== 'string' ||
    typeof data.runKind !== 'string' ||
    typeof data.targetType !== 'string' ||
    typeof data.targetName !== 'string' ||
    typeof data.progress !== 'number' ||
    !isNullableString(data.appId) ||
    !isNullableString(data.approvedRevisionId) ||
    !isNullableString(data.failureCode) ||
    !isNullableString(data.failureMessage) ||
    !isNullableString(data.cancelledReason)
  ) {
    return null;
  }
  const request = data.request;
  if (
    !isRecord(request) ||
    typeof request.requirements !== 'string' ||
    !isNullableString(request.constraints) ||
    !isNullableString(request.changesSummary)
  ) {
    return null;
  }
  const revisions = data.revisions;
  if (!Array.isArray(revisions) || !revisions.every(isBuildPackageRevision)) {
    return null;
  }
  const events = data.events;
  if (!Array.isArray(events)) {
    return null;
  }
  return {
    // The fields the page reads are validated above; the rest ride along
    // unchanged so exports and status-specific banners keep their data.
    ...(data as unknown as VenomBuildRun),
    revisions,
    events: events.filter(isBuildRunEvent),
  };
}

export function resolveBuildRunDetailState(
  query: RecordQuery,
): BuildRunDetailState {
  if (query.isError) {
    return { status: 'error', reason: 'request-failed' };
  }
  if (query.isLoading || query.data === undefined) {
    return { status: 'loading' };
  }

  const run = normalizeBuildRun(query.data);
  if (run === null) {
    return { status: 'error', reason: 'malformed-response' };
  }
  return { status: 'ready', run };
}

/**
 * The page only reads the newest run's id off this list before fetching the
 * full record, so a row is usable with just its identity.
 */
function isProvisioningRunRow(
  value: unknown,
): value is ProvisioningRunSummary {
  return isRecord(value) && typeof value.id === 'string' && value.id.length > 0;
}

export function resolveProvisioningRunsState(
  query: RecordQuery,
): ProvisioningRunsState {
  if (query.isError) {
    return { status: 'error', reason: 'request-failed' };
  }
  if (query.isLoading || query.data === undefined) {
    return { status: 'loading' };
  }
  if (!Array.isArray(query.data)) {
    return { status: 'error', reason: 'malformed-response' };
  }
  const runs = query.data.filter(isProvisioningRunRow);
  if (runs.length === 0) {
    // An empty list means "never provisioned"; a list we could not read a
    // single row out of must not — that is a broken response.
    return query.data.length > 0
      ? { status: 'error', reason: 'malformed-response' }
      : { status: 'empty' };
  }
  return { status: 'ready', runs };
}

/** The provisioning log renders these fields per event. */
function isProvisioningRunEvent(
  value: unknown,
): value is ProvisioningRunEvent {
  if (!isRecord(value)) {
    return false;
  }
  return (
    typeof value.id === 'string' &&
    value.id.length > 0 &&
    typeof value.eventType === 'string' &&
    typeof value.message === 'string' &&
    typeof value.createdAt === 'string'
  );
}

/**
 * Returns a provisioning run shaped the way the stage panel reads it, or
 * null. Event and release rows are display/action rows; unreadable ones are
 * dropped rather than failing the record.
 */
export function normalizeProvisioningRun(
  data: unknown,
): ProvisioningRun | null {
  if (!isRecord(data)) {
    return null;
  }
  if (
    typeof data.id !== 'string' ||
    data.id.length === 0 ||
    typeof data.status !== 'string' ||
    typeof data.progress !== 'number' ||
    !isNullableString(data.stage) ||
    !isNullableString(data.appId) ||
    !isNullableString(data.failureMessage) ||
    !isNullableString(data.blockedReason)
  ) {
    return null;
  }
  const events = data.events;
  const releases = data.releases;
  if (!Array.isArray(events) || !Array.isArray(releases)) {
    return null;
  }
  return {
    ...(data as unknown as ProvisioningRun),
    events: events.filter(isProvisioningRunEvent),
    releases: releases.filter(isProvisioningRelease),
  };
}

/**
 * This query only runs once a provisioning run id is known, so callers pass
 * `enabled` to tell "not asked yet" apart from "still loading".
 */
export function resolveProvisioningRunDetailState(
  query: RecordQuery & { enabled: boolean },
): ProvisioningRunDetailState {
  if (!query.enabled) {
    return { status: 'idle' };
  }
  if (query.isError) {
    return { status: 'error', reason: 'request-failed' };
  }
  if (query.isLoading || query.data === undefined) {
    return { status: 'loading' };
  }

  const run = normalizeProvisioningRun(query.data);
  if (run === null) {
    return { status: 'error', reason: 'malformed-response' };
  }
  return { status: 'ready', run };
}
