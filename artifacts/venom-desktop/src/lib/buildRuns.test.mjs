import assert from 'node:assert/strict';
import test from 'node:test';

import {
  isVenomBuildRunListRow,
  normalizeBuildRun,
  normalizeProvisioningRun,
  resolveBuildRunDetailState,
  resolveProvisioningRunDetailState,
  resolveProvisioningRunsState,
} from './buildRuns.ts';

const RUN_ID = '7a2b9c4d-1e5f-4a8b-9c3d-6e7f8a9b0c1d';

const buildPackage = {
  formatVersion: 1,
  targetType: 'app',
  targetName: 'Symbiote Portal',
  productBrief: {
    summary: 'A portal for tracking symbiote activity.',
    audience: ['Operations'],
    outcomes: ['Faster triage'],
  },
  functionalScope: ['Sign-in'],
  brandDirection: ['Monochrome'],
  contentRequirements: [],
  serviceFlowRequirements: [],
  dataNeeds: [],
  integrationNeeds: [],
  acceptanceChecks: ['Loads without errors'],
  launchConstraints: [],
  sourceReferences: [
    {
      appId: '11111111-1111-1111-1111-111111111111',
      appName: 'Venom',
      sourceVersionId: '22222222-2222-2222-2222-222222222222',
      versionNumber: 3,
      checksumSha256: 'ab'.repeat(32),
    },
  ],
  sopReferences: [
    {
      sopId: '55555555-5555-5555-5555-555555555555',
      sopRevisionId: '66666666-6666-6666-6666-666666666666',
      title: 'Deploy checklist',
      revisionNumber: 2,
      checksumSha256: 'cd'.repeat(32),
    },
  ],
  permissionRequests: [
    { capability: 'send_email', reason: 'Notify on launch', required: true },
  ],
};

const revision = {
  id: 'b1c2d3e4-f5a6-4b7c-8d9e-0f1a2b3c4d5e',
  buildRunId: RUN_ID,
  revisionNumber: 1,
  reason: 'initial_compile',
  package: buildPackage,
  checksumSha256: 'ef'.repeat(32),
  approvedAt: null,
  createdAt: '2026-01-03T00:04:00.000Z',
};

const runEvent = {
  id: 'e1f2a3b4-c5d6-4e7f-8a9b-0c1d2e3f4a5b',
  buildRunId: RUN_ID,
  eventType: 'compiled',
  status: 'review_required',
  progress: 100,
  message: 'Package compiled for review.',
  createdAt: '2026-01-03T00:04:30.000Z',
};

const run = {
  id: RUN_ID,
  correlationId: '0f9e8d7c-6b5a-4f3e-8d1c-0b9a8f7e6d5c',
  appId: null,
  runKind: 'standalone',
  targetType: 'app',
  targetName: 'Symbiote Portal',
  status: 'review_required',
  progress: 100,
  attempt: 1,
  currentRevisionNumber: 1,
  approvedRevisionId: null,
  failureCode: null,
  failureMessage: null,
  cancelledReason: null,
  request: {
    targetType: 'app',
    targetName: 'Symbiote Portal',
    requirements: 'Build a portal that tracks symbiote activity.',
    constraints: null,
    brandDirection: null,
    appId: null,
    sourceVersionId: null,
    projectId: null,
    sopRevisionIds: [],
    changesSummary: null,
  },
  revisions: [revision],
  events: [runEvent],
  startedAt: '2026-01-03T00:00:00.000Z',
  completedAt: null,
  createdAt: '2026-01-03T00:00:00.000Z',
  updatedAt: '2026-01-03T00:05:00.000Z',
};

test('reads a healthy build run response', () => {
  assert.deepEqual(normalizeBuildRun(run), run);
  assert.deepEqual(
    resolveBuildRunDetailState({ data: run, isLoading: false, isError: false }),
    { status: 'ready', run },
  );
});

test('a non-record run payload is reported as a broken response', () => {
  // The generated client resolves a 401 or a 5xx to the error body as data;
  // the page used to read `run.revisions.map` off it and crash the route.
  for (const payload of [
    { error: 'unauthorized' },
    'Internal Server Error',
    42,
    null,
    [run],
  ]) {
    assert.equal(normalizeBuildRun(payload), null);
    assert.deepEqual(
      resolveBuildRunDetailState({
        data: payload,
        isLoading: false,
        isError: false,
      }),
      { status: 'error', reason: 'malformed-response' },
    );
  }
});

test('a run needs its identity and request snapshot to be readable', () => {
  assert.equal(normalizeBuildRun({ ...run, id: '' }), null);
  assert.equal(normalizeBuildRun({ ...run, status: 7 }), null);
  assert.equal(normalizeBuildRun({ ...run, targetName: undefined }), null);
  assert.equal(normalizeBuildRun({ ...run, request: null }), null);
  assert.equal(
    normalizeBuildRun({ ...run, request: { ...run.request, requirements: 9 } }),
    null,
  );
});

test('an unreadable revision row fails the whole record', () => {
  // Approval always targets revisions[0]; silently dropping an unreadable
  // row could re-point the approval at an older revision, so the run is
  // unreadable as a whole instead.
  assert.equal(normalizeBuildRun({ ...run, revisions: 'gone' }), null);
  assert.equal(
    normalizeBuildRun({ ...run, revisions: [revision, null] }),
    null,
  );
  assert.equal(
    normalizeBuildRun({
      ...run,
      revisions: [{ ...revision, package: { formatVersion: 1 } }],
    }),
    null,
  );
  assert.equal(
    normalizeBuildRun({
      ...run,
      revisions: [
        {
          ...revision,
          package: {
            ...buildPackage,
            productBrief: { summary: 'ok', audience: 'everyone', outcomes: [] },
          },
        },
      ],
    }),
    null,
  );
});

test('an empty revision list is a readable run', () => {
  const queued = { ...run, status: 'queued', revisions: [], events: [] };
  assert.deepEqual(normalizeBuildRun(queued), queued);
});

test('drops unreadable event rows instead of failing the run', () => {
  const normalized = normalizeBuildRun({
    ...run,
    events: [runEvent, null, { id: 'partial' }, { ...runEvent, message: 4 }],
  });
  assert.deepEqual(normalized.events, [runEvent]);
  // But a non-list events section means the record shape is wrong.
  assert.equal(normalizeBuildRun({ ...run, events: 'gone' }), null);
});

test('run resolver reports failed requests and loading distinctly', () => {
  assert.deepEqual(
    resolveBuildRunDetailState({
      data: undefined,
      isLoading: false,
      isError: true,
    }),
    { status: 'error', reason: 'request-failed' },
  );
  assert.deepEqual(
    resolveBuildRunDetailState({
      data: undefined,
      isLoading: true,
      isError: false,
    }),
    { status: 'loading' },
  );
  assert.deepEqual(
    resolveBuildRunDetailState({
      data: undefined,
      isLoading: false,
      isError: false,
    }),
    { status: 'loading' },
  );
});

test('build run list rows need the fields the sidebar renders', () => {
  assert.equal(isVenomBuildRunListRow(run), true);
  assert.equal(isVenomBuildRunListRow({ id: RUN_ID }), false);
  assert.equal(isVenomBuildRunListRow({ error: 'unauthorized' }), false);
  assert.equal(isVenomBuildRunListRow(null), false);
});

// ---------------------------------------------------------------------------
// Provisioning runs
// ---------------------------------------------------------------------------

const provEvent = {
  id: 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d',
  provisioningRunId: 'c9d8e7f6-a5b4-4c3d-8e1f-2a3b4c5d6e7f',
  eventType: 'candidate_created',
  status: 'candidate_ready',
  progress: 100,
  message: 'Candidate ready for review.',
  createdAt: '2026-01-03T01:00:00.000Z',
};

const release = {
  id: 'd4c3b2a1-f6e5-4b7a-9d8c-1f0e2b3a4d5c',
  provisioningRunId: 'c9d8e7f6-a5b4-4c3d-8e1f-2a3b4c5d6e7f',
  status: 'candidate',
  targetName: 'Symbiote Portal',
  providerCandidateId: 'cand_123',
  launchUrl: null,
  publishIdempotencyKey: null,
  rollbackIdempotencyKey: null,
  rollbackSupported: true,
  publishedAt: null,
  rolledBackAt: null,
  createdAt: '2026-01-03T01:00:00.000Z',
  updatedAt: '2026-01-03T01:00:00.000Z',
};

const provisioningRun = {
  id: 'c9d8e7f6-a5b4-4c3d-8e1f-2a3b4c5d6e7f',
  buildRunId: RUN_ID,
  appId: null,
  status: 'candidate_ready',
  stage: null,
  progress: 100,
  failureMessage: null,
  blockedReason: null,
  cancelRequested: false,
  events: [provEvent],
  releases: [release],
  createdAt: '2026-01-03T00:50:00.000Z',
  updatedAt: '2026-01-03T01:00:00.000Z',
};

test('reads a healthy provisioning run list', () => {
  assert.deepEqual(
    resolveProvisioningRunsState({
      data: [provisioningRun],
      isLoading: false,
      isError: false,
    }),
    { status: 'ready', runs: [provisioningRun] },
  );
});

test('an empty provisioning list means never provisioned', () => {
  assert.deepEqual(
    resolveProvisioningRunsState({ data: [], isLoading: false, isError: false }),
    { status: 'empty' },
  );
});

test('a broken provisioning list must not pose as never provisioned', () => {
  // Rendering the pristine "Provision" pitch off a broken read invites a
  // duplicate provision, so this must surface as an error state.
  for (const payload of [{ error: 'unauthorized' }, 'nope', 12]) {
    assert.deepEqual(
      resolveProvisioningRunsState({
        data: payload,
        isLoading: false,
        isError: false,
      }),
      { status: 'error', reason: 'malformed-response' },
    );
  }
  assert.deepEqual(
    resolveProvisioningRunsState({
      data: [null, { id: '' }],
      isLoading: false,
      isError: false,
    }),
    { status: 'error', reason: 'malformed-response' },
  );
  assert.deepEqual(
    resolveProvisioningRunsState({
      data: undefined,
      isLoading: false,
      isError: true,
    }),
    { status: 'error', reason: 'request-failed' },
  );
});

test('provisioning detail stays idle until a run id is known', () => {
  assert.deepEqual(
    resolveProvisioningRunDetailState({
      data: undefined,
      isLoading: false,
      isError: false,
      enabled: false,
    }),
    { status: 'idle' },
  );
});

test('reads a healthy provisioning run and drops garbage rows', () => {
  assert.deepEqual(normalizeProvisioningRun(provisioningRun), provisioningRun);
  const normalized = normalizeProvisioningRun({
    ...provisioningRun,
    events: [provEvent, null, { id: 'partial' }],
    releases: [release, 'nope', { id: '' }],
  });
  assert.deepEqual(normalized.events, [provEvent]);
  assert.deepEqual(normalized.releases, [release]);
  assert.deepEqual(
    resolveProvisioningRunDetailState({
      data: provisioningRun,
      isLoading: false,
      isError: false,
      enabled: true,
    }),
    { status: 'ready', run: provisioningRun },
  );
});

test('a broken provisioning run record surfaces as an error state', () => {
  for (const payload of [
    { error: 'unauthorized' },
    'Internal Server Error',
    null,
    { ...provisioningRun, id: '' },
    { ...provisioningRun, progress: 'lots' },
    { ...provisioningRun, events: 'gone' },
    { ...provisioningRun, releases: null },
  ]) {
    assert.equal(normalizeProvisioningRun(payload), null);
    assert.deepEqual(
      resolveProvisioningRunDetailState({
        data: payload,
        isLoading: false,
        isError: false,
        enabled: true,
      }),
      { status: 'error', reason: 'malformed-response' },
    );
  }
  assert.deepEqual(
    resolveProvisioningRunDetailState({
      data: undefined,
      isLoading: false,
      isError: true,
      enabled: true,
    }),
    { status: 'error', reason: 'request-failed' },
  );
});
