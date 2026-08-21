import assert from 'node:assert/strict';
import test from 'node:test';

import {
  BLEND_TRIANGLE,
  EVEN_BLEND,
  describeBlend,
  favoredBlend,
  isResponseMode,
  mergeConversationResponsePrefs,
  normalizeConversationBlend,
  normalizeConversationResponsePrefs,
  normalizeWeights,
  nudgeWeights,
  pinToWeights,
  weightsToPin,
} from './blend.ts';

const close = (a, b, eps = 1e-9) => Math.abs(a - b) < eps;

test('centered pin reads as an even blend', () => {
  const centroid = {
    x: (BLEND_TRIANGLE[0].x + BLEND_TRIANGLE[1].x + BLEND_TRIANGLE[2].x) / 3,
    y: (BLEND_TRIANGLE[0].y + BLEND_TRIANGLE[1].y + BLEND_TRIANGLE[2].y) / 3,
  };
  const weights = pinToWeights(centroid);
  for (const weight of weights) assert.ok(close(weight, 1 / 3, 1e-6));
});

test('a corner pin gives that voice all the weight', () => {
  for (let corner = 0; corner < 3; corner += 1) {
    const weights = pinToWeights(BLEND_TRIANGLE[corner]);
    assert.ok(close(weights[corner], 1, 1e-6));
  }
});

test('pinToWeights and weightsToPin round-trip', () => {
  const cases = [
    [0.5, 0.3, 0.2],
    [0.1, 0.1, 0.8],
    EVEN_BLEND,
  ];
  for (const original of cases) {
    const pin = weightsToPin(original);
    const back = pinToWeights(pin);
    for (let index = 0; index < 3; index += 1) {
      assert.ok(close(back[index], original[index], 1e-6), `case ${original}`);
    }
  }
});

test('points outside the triangle clamp to a valid blend', () => {
  const weights = pinToWeights({ x: -0.4, y: -0.4 });
  const total = weights[0] + weights[1] + weights[2];
  assert.ok(close(total, 1, 1e-9));
  for (const weight of weights) assert.ok(weight >= 0 && weight <= 1);
});

test('normalizeWeights clamps, fills junk, and sums to one', () => {
  assert.deepEqual(normalizeWeights([0, 0, 0]), EVEN_BLEND);
  const weights = normalizeWeights([2, -1, Number.NaN]);
  assert.ok(close(weights[0], 1));
  assert.ok(close(weights[1], 0));
  assert.ok(close(weights[2], 0));
});

test('favoredBlend favors without silencing', () => {
  const weights = favoredBlend(1);
  assert.ok(close(weights[1], 0.7));
  assert.ok(close(weights[0], 0.15));
  assert.ok(close(weights[2], 0.15));
});

test('nudgeWeights moves toward the pushed corner and stays valid', () => {
  // Nudging up from center should move weight toward corner 0 (top).
  const weights = nudgeWeights(EVEN_BLEND, 0, -0.06);
  assert.ok(weights[0] > 1 / 3);
  const total = weights[0] + weights[1] + weights[2];
  assert.ok(close(total, 1, 1e-9));
});

test('describeBlend announces even and favored states', () => {
  const names = ['GPT-5', 'Claude', 'Gemini'];
  assert.equal(
    describeBlend(EVEN_BLEND, names),
    'Even blend of GPT-5, Claude, Gemini',
  );
  const favored = describeBlend([0.7, 0.15, 0.15], names);
  assert.ok(favored.includes('GPT-5 70%'));
  assert.ok(favored.includes('Claude 15%'));
});

test('isResponseMode accepts only the three modes', () => {
  assert.equal(isResponseMode('talk'), true);
  assert.equal(isResponseMode('verify'), true);
  assert.equal(isResponseMode('debate'), true);
  assert.equal(isResponseMode('shout'), false);
  assert.equal(isResponseMode(undefined), false);
});

test('normalizeConversationBlend rejects malformed blocks', () => {
  assert.equal(normalizeConversationBlend(undefined), undefined);
  assert.equal(normalizeConversationBlend({ corners: ['a', 'b'], weights: [1, 0, 0] }), undefined);
  assert.equal(
    normalizeConversationBlend({ corners: ['a', 'a', 'b'], weights: [1, 0, 0] }),
    undefined,
  );
  assert.equal(
    normalizeConversationBlend({ corners: ['a', 'b', 'c'], weights: [1, 0] }),
    undefined,
  );
  assert.equal(
    normalizeConversationBlend({ corners: ['a', 'b', 'c'], weights: [1, 0, 'x'] }),
    undefined,
  );
});

test('normalizeConversationResponsePrefs strips junk and keeps valid blocks', () => {
  const junk = normalizeConversationResponsePrefs({
    id: 'c1',
    responseMode: 'loud',
    blend: { corners: [], weights: [] },
    modeUpdatedAt: Number.NaN,
  });
  assert.equal(junk.responseMode, undefined);
  assert.equal(junk.blend, undefined);
  assert.equal(junk.modeUpdatedAt, undefined);

  const valid = normalizeConversationResponsePrefs({
    id: 'c2',
    responseMode: 'verify',
    blend: { corners: ['a', 'b', 'c'], weights: [0.5, 0.25, 0.25] },
    modeUpdatedAt: 42.7,
  });
  assert.equal(valid.responseMode, 'verify');
  assert.equal(valid.modeUpdatedAt, 42);
});

test('mergeConversationResponsePrefs moves the whole block from the winner', () => {
  const base = { id: 'c', responseMode: 'talk', modeUpdatedAt: 10 };
  const cloud = {
    responseMode: 'debate',
    blend: { corners: ['a', 'b', 'c'], weights: [0.6, 0.2, 0.2] },
    modeUpdatedAt: 90,
  };
  const device = { responseMode: 'talk', modeUpdatedAt: 20 };
  const merged = mergeConversationResponsePrefs(base, cloud, device);
  assert.equal(merged.responseMode, 'debate');
  assert.deepEqual(merged.blend.corners, ['a', 'b', 'c']);
  assert.equal(merged.modeUpdatedAt, 90);

  // Tie goes to the device copy.
  const tied = mergeConversationResponsePrefs(base, { ...cloud, modeUpdatedAt: 20 }, device);
  assert.equal(tied.responseMode, 'talk');
  assert.equal(tied.blend, undefined);
});
