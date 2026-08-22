import assert from 'node:assert/strict';
import test from 'node:test';

import {
  normalizeSharedSopList,
  normalizeSopDetail,
  normalizeSopList,
  resolveSharedSopLibraryState,
  resolveSopDetailState,
  resolveSopLibraryState,
} from './sopLibrary.ts';

const content = {
  purpose: 'Standardize the rollback path.',
  prerequisites: ['Deploy dashboard access'],
  inputs: [],
  guidance: ['Revert to the previous release.'],
  requiredApprovals: [],
  acceptanceChecks: ['Health checks pass'],
};

const sop = {
  id: '11111111-1111-1111-1111-111111111111',
  title: 'Rollback a bad deploy',
  lifecycle: 'active',
  category: 'operations',
  tags: ['deploys'],
  provenance: 'manual',
  content,
  activeRevisionId: null,
  activeRevisionNumber: 1,
  appIds: [],
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  archivedAt: null,
};

// Shared workspace SOPs carry the same card fields but no appIds.
const { appIds: _ignored, ...workspaceSop } = sop;

const revision = {
  id: '22222222-2222-2222-2222-222222222222',
  versionNumber: 1,
  provenance: 'manual',
  checksumSha256: 'f'.repeat(64),
  title: sop.title,
  category: 'operations',
  tags: ['deploys'],
  content,
  publishedAt: '2026-01-02T00:00:00.000Z',
};

const assignment = {
  appId: '33333333-3333-3333-3333-333333333333',
  assignedAt: '2026-01-02T00:00:00.000Z',
};

const detail = { sop, revisions: [revision], assignments: [assignment] };

test('reads a healthy SOP list response', () => {
  assert.deepEqual(
    resolveSopLibraryState({ data: [sop], isLoading: false, isError: false }),
    { status: 'ready', sops: [sop] },
  );
});

test('an empty list is an empty library, not a failure', () => {
  assert.deepEqual(
    resolveSopLibraryState({ data: [], isLoading: false, isError: false }),
    { status: 'empty' },
  );
});

test('a non-array payload is reported as a broken response', () => {
  // An unavailable API, an error body, or an unauthenticated response all end
  // up here; none of them may reach the cards, which would crash the route.
  for (const payload of [
    { error: 'unauthorized' },
    { sops: [sop] },
    'Internal Server Error',
    42,
    null,
  ]) {
    assert.equal(normalizeSopList(payload), null);
    assert.deepEqual(
      resolveSopLibraryState({
        data: payload,
        isLoading: false,
        isError: false,
      }),
      { status: 'error', reason: 'malformed-response' },
    );
  }
});

test('drops unusable records but keeps the readable ones', () => {
  // The client-side filter calls tags.some and content.purpose.toLowerCase,
  // so records missing those cannot be rendered.
  const unreadable = { ...sop, tags: 'deploys' };
  assert.deepEqual(
    normalizeSopList([sop, null, 'nope', { id: '' }, unreadable]),
    [sop],
  );
  assert.deepEqual(
    resolveSopLibraryState({
      data: [sop, null, { title: 'no id' }],
      isLoading: false,
      isError: false,
    }),
    { status: 'ready', sops: [sop] },
  );
});

test('a list with no readable record is broken rather than empty', () => {
  assert.deepEqual(
    resolveSopLibraryState({
      data: [null, 'nope'],
      isLoading: false,
      isError: false,
    }),
    { status: 'error', reason: 'malformed-response' },
  );
});

test('a failed request is reported as a failed request', () => {
  assert.deepEqual(
    resolveSopLibraryState({
      data: undefined,
      isLoading: false,
      isError: true,
    }),
    { status: 'error', reason: 'request-failed' },
  );
});

test('stays in the loading state until a payload arrives', () => {
  assert.deepEqual(
    resolveSopLibraryState({ data: undefined, isLoading: true, isError: false }),
    { status: 'loading' },
  );
  assert.deepEqual(
    resolveSopLibraryState({
      data: undefined,
      isLoading: false,
      isError: false,
    }),
    { status: 'loading' },
  );
});

test('shared workspace SOP lists resolve with the same contract', () => {
  assert.deepEqual(
    resolveSharedSopLibraryState({
      data: [workspaceSop],
      isLoading: false,
      isError: false,
    }),
    { status: 'ready', sops: [workspaceSop] },
  );
  assert.equal(normalizeSharedSopList({ error: 'forbidden' }), null);
  assert.deepEqual(
    resolveSharedSopLibraryState({
      data: { error: 'forbidden' },
      isLoading: false,
      isError: false,
    }),
    { status: 'error', reason: 'malformed-response' },
  );
});

test('recovers to the records once a later response is well formed', () => {
  const broken = resolveSopLibraryState({
    data: { error: 'unauthorized' },
    isLoading: false,
    isError: false,
  });
  assert.equal(broken.status, 'error');

  assert.deepEqual(
    resolveSopLibraryState({ data: [sop], isLoading: false, isError: false }),
    { status: 'ready', sops: [sop] },
  );
});

test('reads a healthy SOP detail response', () => {
  assert.deepEqual(
    resolveSopDetailState({ data: detail, isLoading: false, isError: false }),
    { status: 'ready', detail },
  );
});

test('a detail payload that is not the record is a broken response', () => {
  for (const payload of [
    { error: 'unauthorized' },
    'Internal Server Error',
    42,
    null,
    [],
    { sop },
    { sop, revisions: [revision] },
  ]) {
    assert.equal(normalizeSopDetail(payload), null);
    assert.deepEqual(
      resolveSopDetailState({
        data: payload,
        isLoading: false,
        isError: false,
      }),
      { status: 'error', reason: 'malformed-response' },
    );
  }
});

test('a detail record whose draft fields are unreadable is broken', () => {
  // The editor spreads every content list into local state; a non-array
  // there would throw during seeding, not rendering.
  const stringGuidance = { ...sop, content: { ...content, guidance: 'revert' } };
  assert.equal(
    normalizeSopDetail({ sop: stringGuidance, revisions: [], assignments: [] }),
    null,
  );
  const numericTags = { ...sop, tags: [1, 2] };
  assert.equal(
    normalizeSopDetail({ sop: numericTags, revisions: [], assignments: [] }),
    null,
  );
  assert.equal(
    normalizeSopDetail({ sop, revisions: {}, assignments: [] }),
    null,
  );
  assert.equal(
    normalizeSopDetail({ sop, revisions: [], assignments: 'none' }),
    null,
  );
});

test('drops unreadable revisions and assignments but keeps the record', () => {
  assert.deepEqual(
    normalizeSopDetail({
      sop,
      revisions: [revision, null, { id: 'r2' }],
      assignments: [assignment, 'nope', { appId: '' }],
    }),
    { sop, revisions: [revision], assignments: [assignment] },
  );
});

test('a failed detail request is reported as a failed request', () => {
  assert.deepEqual(
    resolveSopDetailState({ data: undefined, isLoading: false, isError: true }),
    { status: 'error', reason: 'request-failed' },
  );
});

test('the detail stays loading until a payload arrives, then recovers', () => {
  assert.deepEqual(
    resolveSopDetailState({ data: undefined, isLoading: true, isError: false }),
    { status: 'loading' },
  );
  assert.deepEqual(
    resolveSopDetailState({
      data: undefined,
      isLoading: false,
      isError: false,
    }),
    { status: 'loading' },
  );

  const broken = resolveSopDetailState({
    data: { error: 'unauthorized' },
    isLoading: false,
    isError: false,
  });
  assert.equal(broken.status, 'error');

  assert.deepEqual(
    resolveSopDetailState({ data: detail, isLoading: false, isError: false }),
    { status: 'ready', detail },
  );
});
