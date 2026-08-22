import assert from 'node:assert/strict';
import test from 'node:test';

import {
  PROJECT_ACCENT_PALETTE,
  nextProjectAccent,
} from './projectLifecycle.ts';

test('nextProjectAccent rotates through the monochrome palette by project count', () => {
  assert.equal(nextProjectAccent(0), PROJECT_ACCENT_PALETTE[0]);
  assert.equal(nextProjectAccent(1), PROJECT_ACCENT_PALETTE[1]);
  assert.equal(nextProjectAccent(2), PROJECT_ACCENT_PALETTE[2]);
  assert.equal(nextProjectAccent(3), PROJECT_ACCENT_PALETTE[3]);
  // Wraps around once the palette is exhausted, like the phone's create flow.
  assert.equal(
    nextProjectAccent(PROJECT_ACCENT_PALETTE.length),
    PROJECT_ACCENT_PALETTE[0],
  );
});

test('the palette holds distinct monochrome hex values', () => {
  assert.equal(
    new Set(PROJECT_ACCENT_PALETTE).size,
    PROJECT_ACCENT_PALETTE.length,
  );
  for (const accent of PROJECT_ACCENT_PALETTE) {
    assert.match(accent, /^#[0-9a-f]{6}$/);
  }
});

test('nextProjectAccent tolerates malformed counts instead of breaking creation', () => {
  assert.equal(nextProjectAccent(Number.NaN), PROJECT_ACCENT_PALETTE[0]);
  assert.equal(nextProjectAccent(-3), PROJECT_ACCENT_PALETTE[0]);
  assert.equal(nextProjectAccent(2.9), PROJECT_ACCENT_PALETTE[2]);
});
