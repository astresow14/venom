import assert from 'node:assert/strict';
import test from 'node:test';

import {
  normalizeAppPortfolio,
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
