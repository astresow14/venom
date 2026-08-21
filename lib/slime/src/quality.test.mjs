import test from "node:test";
import assert from "node:assert/strict";

import { createAdaptiveQuality } from "./quality.ts";

/**
 * Drive a controller with a synthetic cadence. Returns the timestamp after
 * the run and how many times the scale changed.
 */
function run(quality, startAt, deltas) {
  let at = startAt;
  let changes = 0;
  for (const delta of deltas) {
    at += delta;
    if (quality.frame(at)) changes += 1;
  }
  return { at, changes };
}

function repeat(delta, count) {
  return Array.from({ length: count }, () => delta);
}

test("sustained misses shed the scale toward the floor, never below it", () => {
  const quality = createAdaptiveQuality({
    initialScale: 1,
    minScale: 0.3,
    maxScale: 1.5,
  });

  quality.frame(0);
  let at = 0;
  let previous = quality.scale;
  const seen = [];

  // ~30fps sustained: every decision should move down (until the floor).
  for (let i = 0; i < 1200; i += 1) {
    at += 33.4;
    if (quality.frame(at)) {
      assert.ok(
        quality.scale < previous,
        `expected a degrade, got ${previous} -> ${quality.scale}`,
      );
      previous = quality.scale;
      seen.push(quality.scale);
    }
  }

  assert.ok(seen.length >= 2, "expected several degrade decisions");
  assert.ok(quality.scale <= 0.31, `expected the floor, got ${quality.scale}`);
  assert.ok(quality.scale >= 0.3, "must never undershoot minScale");
});

test("sustained headroom sharpens to the ceiling, never past it", () => {
  const quality = createAdaptiveQuality({
    initialScale: 0.62,
    minScale: 0.3,
    maxScale: 1.4,
  });

  quality.frame(0);
  const { changes } = run(quality, 0, repeat(16, 3000));

  assert.ok(changes >= 5, "expected repeated sharpening decisions");
  assert.ok(
    quality.scale > 1.39 && quality.scale <= 1.4,
    `expected to reach maxScale, got ${quality.scale}`,
  );
});

test("a cadence inside the deadband holds the scale still", () => {
  const quality = createAdaptiveQuality({
    initialScale: 0.8,
    minScale: 0.3,
    maxScale: 1.5,
  });

  quality.frame(0);
  const { changes } = run(quality, 0, repeat(20, 800));

  assert.equal(changes, 0);
  assert.equal(quality.scale, 0.8);
});

test("an isolated spike per window is trimmed away, not treated as a miss", () => {
  const quality = createAdaptiveQuality({
    initialScale: 0.8,
    minScale: 0.3,
    maxScale: 1.5,
  });

  quality.frame(0);
  // 23 deadband frames then one 400ms GC pause, repeated.
  const pattern = [];
  for (let block = 0; block < 30; block += 1) {
    pattern.push(...repeat(20, 23), 400);
  }
  const { changes } = run(quality, 0, pattern);

  assert.equal(changes, 0, "spikes alone must not move the scale");
  assert.equal(quality.scale, 0.8);
});

test("a single pause is discarded instead of measured", () => {
  const quality = createAdaptiveQuality({
    initialScale: 0.8,
    minScale: 0.3,
    maxScale: 1.5,
  });

  quality.frame(0);
  let minSeen = quality.scale;
  let at = 0;
  const deltas = [...repeat(20, 30), 5000, ...repeat(20, 30)];
  for (const delta of deltas) {
    at += delta;
    quality.frame(at);
    minSeen = Math.min(minSeen, quality.scale);
  }

  assert.ok(
    minSeen >= 0.8,
    `a lone pause must never degrade, got down to ${minSeen}`,
  );
});

test("a run of stalls is a real cadence and drives the scale to the floor", () => {
  const quality = createAdaptiveQuality({
    initialScale: 1.2,
    minScale: 0.3,
    maxScale: 1.5,
  });

  quality.frame(0);
  run(quality, 0, repeat(2000, 40));

  assert.ok(
    quality.scale <= 0.31,
    `persistent stalls should floor the scale, got ${quality.scale}`,
  );
});

test("recovery is capped just under the scale that failed, then probes past it", () => {
  const quality = createAdaptiveQuality({
    initialScale: 1,
    minScale: 0.3,
    maxScale: 1.5,
  });

  quality.frame(0);

  // Miss until the first degrade lands.
  let at = 0;
  while (quality.scale === 1) {
    at += 33.4;
    quality.frame(at);
  }
  const degraded = quality.scale;
  assert.ok(degraded < 1);

  // Now the device is suddenly healthy. The climb must pause just below the
  // failed scale instead of bouncing straight back over it...
  let capped = false;
  for (let i = 0; i < 12 * 24; i += 1) {
    at += 12;
    quality.frame(at);
    if (quality.scale > degraded && quality.scale <= 0.98) capped = true;
    assert.ok(
      quality.scale <= 1.001 || capped,
      "must not leap past the failed scale without pausing at the ceiling",
    );
  }
  assert.ok(capped, "expected the climb to pause under the failed scale");

  // ...but sustained health probes the ceiling upward and recovers fully.
  for (let i = 0; i < 60 * 24; i += 1) {
    at += 12;
    quality.frame(at);
  }
  assert.ok(
    quality.scale > 1,
    `expected recovery past the old failure, got ${quality.scale}`,
  );
});

test("reset forgets the cadence so the next frame is not a giant delta", () => {
  const quality = createAdaptiveQuality({
    initialScale: 0.8,
    minScale: 0.3,
    maxScale: 1.5,
  });

  quality.frame(0);
  run(quality, 0, repeat(20, 10));

  quality.reset();
  // Ten minutes later (visibility change): the first frames back must not
  // count the gap, and a healthy cadence afterwards must not degrade.
  let at = 600_000;
  quality.frame(at);
  let minSeen = quality.scale;
  for (let i = 0; i < 200; i += 1) {
    at += 20;
    quality.frame(at);
    minSeen = Math.min(minSeen, quality.scale);
  }
  assert.ok(minSeen >= 0.8, `reset leaked the pause into a degrade: ${minSeen}`);
});

test("initial scale is clamped into bounds", () => {
  const low = createAdaptiveQuality({
    initialScale: 0.05,
    minScale: 0.3,
    maxScale: 1.5,
  });
  assert.equal(low.scale, 0.3);

  const high = createAdaptiveQuality({
    initialScale: 9,
    minScale: 0.3,
    maxScale: 1.5,
  });
  assert.equal(high.scale, 1.5);
});

test("decisions come quickly when frames are extremely slow", () => {
  const quality = createAdaptiveQuality({
    initialScale: 1,
    minScale: 0.3,
    maxScale: 1.5,
  });

  quality.frame(0);
  // Four 250ms frames (1s of wall time) must be enough to react — a slow
  // device cannot be asked to produce a 24-frame window first.
  const { changes } = run(quality, 0, repeat(250, 5));
  assert.ok(changes >= 1, "expected an early degrade on a very slow cadence");
  assert.ok(quality.scale < 1);
});
