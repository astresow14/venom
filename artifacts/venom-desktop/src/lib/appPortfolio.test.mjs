import assert from 'node:assert/strict';
import test from 'node:test';

import {
  hasActiveImportJob,
  normalizeAppDetail,
  normalizeAppPortfolio,
  resolveAppDetailState,
  resolveAppPortfolioState,
} from './appPortfolio.ts';

const app = {
  id: '11111111-1111-1111-1111-111111111111',
  name: 'Venom',
  purpose: 'Track source history',
  brand: 'Venom',
  status: 'ready',
  detectedStack: [],
  sourceType: 'zip',
  sourceVersion: 3,
  deploymentUrl: null,
  importStatus: null,
  sourceUpdatedAt: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

test('reads a healthy portfolio response', () => {
  assert.deepEqual(
    resolveAppPortfolioState({
      data: [app],
      isLoading: false,
      isError: false,
    }),
    { status: 'ready', apps: [app] },
  );
});

test('an empty list is an empty portfolio, not a failure', () => {
  assert.deepEqual(
    resolveAppPortfolioState({ data: [], isLoading: false, isError: false }),
    { status: 'empty' },
  );
});

test('a non-array payload is reported as a broken response', () => {
  // An unavailable API, an error body, or an unauthenticated response all end
  // up here; none of them may reach the cards, which would crash the route.
  for (const payload of [
    { error: 'unauthorized' },
    { apps: [app] },
    'Internal Server Error',
    42,
    null,
  ]) {
    assert.equal(normalizeAppPortfolio(payload), null);
    assert.deepEqual(
      resolveAppPortfolioState({
        data: payload,
        isLoading: false,
        isError: false,
      }),
      { status: 'error', reason: 'malformed-response' },
    );
  }
});

test('drops unusable records but still renders the readable ones', () => {
  assert.deepEqual(normalizeAppPortfolio([app, null, 'nope', { id: '' }]), [
    app,
  ]);
  assert.deepEqual(
    resolveAppPortfolioState({
      data: [app, null, { name: 'no id' }],
      isLoading: false,
      isError: false,
    }),
    { status: 'ready', apps: [app] },
  );
});

test('a list with no readable record is broken rather than empty', () => {
  assert.deepEqual(
    resolveAppPortfolioState({
      data: [null, 'nope'],
      isLoading: false,
      isError: false,
    }),
    { status: 'error', reason: 'malformed-response' },
  );
});

test('a failed request is reported as a failed request', () => {
  assert.deepEqual(
    resolveAppPortfolioState({
      data: undefined,
      isLoading: false,
      isError: true,
    }),
    { status: 'error', reason: 'request-failed' },
  );
});

test('stays in the loading state until a payload arrives', () => {
  assert.deepEqual(
    resolveAppPortfolioState({
      data: undefined,
      isLoading: true,
      isError: false,
    }),
    { status: 'loading' },
  );
  assert.deepEqual(
    resolveAppPortfolioState({
      data: undefined,
      isLoading: false,
      isError: false,
    }),
    { status: 'loading' },
  );
});

test('recovers to the records once a later response is well formed', () => {
  const broken = resolveAppPortfolioState({
    data: { error: 'unauthorized' },
    isLoading: false,
    isError: false,
  });
  assert.equal(broken.status, 'error');

  const recovered = resolveAppPortfolioState({
    data: [app],
    isLoading: false,
    isError: false,
  });
  assert.deepEqual(recovered, { status: 'ready', apps: [app] });
});

// ---------------------------------------------------------------------------
// App detail record
// ---------------------------------------------------------------------------

const version = {
  id: '22222222-2222-2222-2222-222222222222',
  appId: app.id,
  versionNumber: 3,
  archiveFilename: 'venom-v3.zip',
  archiveBytes: 2048,
  checksumSha256: 'ab'.repeat(32),
  manifest: null,
  createdAt: '2026-01-02T00:00:00.000Z',
};

const importJob = {
  id: '33333333-3333-3333-3333-333333333333',
  appId: app.id,
  status: 'complete',
  archiveFilename: 'venom-v3.zip',
  progress: 100,
  failureCode: null,
  failureMessage: null,
  declaredBytes: 2048,
  createdAt: '2026-01-02T00:00:00.000Z',
  updatedAt: '2026-01-02T00:01:00.000Z',
};

const timelineEntry = {
  id: '44444444-4444-4444-4444-444444444444',
  kind: 'version_imported',
  title: 'Version 3 imported',
  status: 'complete',
  actor: 'user',
  occurredAt: '2026-01-02T00:01:00.000Z',
  detail: null,
};

const detail = {
  app,
  versions: [version],
  importJobs: [importJob],
  deploymentLinks: [],
  iterations: [],
  provisioningReleases: [],
  timeline: [timelineEntry],
  timelineTotal: 1,
  timelineTruncated: false,
};

test('reads a healthy detail response', () => {
  assert.deepEqual(normalizeAppDetail(detail), detail);
  assert.deepEqual(
    resolveAppDetailState({ data: detail, isLoading: false, isError: false }),
    { status: 'ready', detail },
  );
});

test('a non-record detail payload is reported as a broken response', () => {
  // The generated client resolves a 401 or a 5xx to the error body as data;
  // the page used to destructure it and crash on `versions.map`.
  for (const payload of [
    { error: 'unauthorized' },
    'Internal Server Error',
    42,
    null,
    [detail],
  ]) {
    assert.equal(normalizeAppDetail(payload), null);
    assert.deepEqual(
      resolveAppDetailState({
        data: payload,
        isLoading: false,
        isError: false,
      }),
      { status: 'error', reason: 'malformed-response' },
    );
  }
});

test('a detail record needs a readable app and list sections', () => {
  assert.equal(normalizeAppDetail({ ...detail, app: undefined }), null);
  assert.equal(normalizeAppDetail({ ...detail, app: { id: '' } }), null);
  assert.equal(
    normalizeAppDetail({ ...detail, app: { ...app, detectedStack: 'node' } }),
    null,
  );
  assert.equal(
    normalizeAppDetail({ ...detail, versions: { error: 'nope' } }),
    null,
  );
  assert.equal(normalizeAppDetail({ ...detail, importJobs: null }), null);
  assert.equal(normalizeAppDetail({ ...detail, timeline: 'gone' }), null);
});

test('drops unreadable child rows instead of failing the record', () => {
  const normalized = normalizeAppDetail({
    ...detail,
    versions: [version, null, { id: 'v', checksumSha256: 7 }],
    importJobs: [importJob, 'nope', { id: 'j' }],
    provisioningReleases: [{ id: '' }, 12],
    timeline: [timelineEntry, { id: 'partial' }],
  });
  assert.deepEqual(normalized.versions, [version]);
  assert.deepEqual(normalized.importJobs, [importJob]);
  assert.deepEqual(normalized.provisioningReleases, []);
  assert.deepEqual(normalized.timeline, [timelineEntry]);
});

test('repairs the timeline summary fields when they are unreadable', () => {
  const normalized = normalizeAppDetail({
    ...detail,
    timelineTotal: 'many',
    timelineTruncated: 'yes',
  });
  assert.equal(normalized.timelineTotal, 1);
  assert.equal(normalized.timelineTruncated, false);
});

test('detail resolver reports failed requests and loading distinctly', () => {
  assert.deepEqual(
    resolveAppDetailState({ data: undefined, isLoading: false, isError: true }),
    { status: 'error', reason: 'request-failed' },
  );
  assert.deepEqual(
    resolveAppDetailState({
      data: undefined,
      isLoading: true,
      isError: false,
    }),
    { status: 'loading' },
  );
  assert.deepEqual(
    resolveAppDetailState({
      data: undefined,
      isLoading: false,
      isError: false,
    }),
    { status: 'loading' },
  );
});

test('the import poll reads the raw payload without trusting it', () => {
  assert.equal(
    hasActiveImportJob({
      ...detail,
      importJobs: [{ ...importJob, status: 'extracting' }],
    }),
    true,
  );
  assert.equal(hasActiveImportJob(detail), false);
  // Error bodies and garbage rows stop the poll instead of throwing or
  // polling forever.
  assert.equal(hasActiveImportJob({ error: 'unauthorized' }), false);
  assert.equal(hasActiveImportJob(undefined), false);
  assert.equal(
    hasActiveImportJob({ importJobs: [null, { status: 42 }] }),
    false,
  );
});
