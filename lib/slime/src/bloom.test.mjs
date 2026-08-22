import assert from "node:assert/strict";
import test from "node:test";

import { createSlimeBloom } from "./bloom.ts";

const coreA = { id: "a", x: 100, y: 100, depth: 0, radius: 40 };
const satA = { id: "a#s0", x: 150, y: 130, depth: 6, radius: 8 };
const coreB = { id: "b", x: 320, y: 240, depth: 10, radius: 30 };
const satB = { id: "b#s0", x: 356, y: 276, depth: 16, radius: 7 };

/** The map as it looked when the session opened. */
const mounted = [coreA, satA];
/** The same map after a new concept (and its satellite) was absorbed. */
const grown = [coreA, satA, coreB, satB];

const byId = (frame, id) => frame.find((node) => node.id === id);

/**
 * Advance the bloom at 60 steps per simulated second, like a render loop
 * would. Returns the last frame; callers must read values immediately since
 * the output array is reused between steps.
 */
function run(bloom, nodes, seconds, { frozen = false, from = 0 } = {}) {
  let frame = nodes;
  const steps = Math.max(1, Math.round(seconds * 60));
  for (let i = 0; i <= steps; i += 1) {
    frame = bloom.step(nodes, from + (seconds * i) / steps, { frozen });
  }
  return frame;
}

test("the mount frame is exempt: nothing blooms at session start", () => {
  const bloom = createSlimeBloom();
  const first = bloom.step(mounted, 0);
  assert.equal(first, mounted, "expected the very same array back");

  // And the concepts stay settled on every later frame too.
  const later = run(bloom, mounted, 1, { from: 0.016 });
  assert.equal(later, mounted);
});

test("a concept absorbed later grows in from nothing", () => {
  const bloom = createSlimeBloom();
  bloom.step(mounted, 0);

  // The frame the newcomer arrives on, it has no size yet.
  const arrival = bloom.step(grown, 0.016);
  assert.equal(byId(arrival, "b").radius, 0, "starts from zero radius");
  assert.equal(
    byId(arrival, "a"),
    coreA,
    "an existing concept passes through untouched",
  );
  assert.equal(byId(arrival, "a#s0"), satA);

  // A few frames in, the bloom is visibly under way but not finished.
  const early = byId(bloom.step(grown, 0.066), "b").radius;
  assert.ok(early > 1, "eases upward instead of staying at zero");
  assert.ok(early < 30 - 0.5, "eases upward instead of snapping to full");

  // Settled: full size, and the module steps out of the way entirely.
  const settled = run(bloom, grown, 1.2, { from: 0.066 });
  assert.equal(settled, grown, "a finished bloom returns the input array");
  assert.equal(byId(settled, "b").radius, 30);
});

test("a new concept's satellites bloom out of its core", () => {
  const bloom = createSlimeBloom();
  bloom.step(mounted, 0);
  bloom.step(grown, 0.016);

  const restingOffset = Math.hypot(satB.x - coreB.x, satB.y - coreB.y);

  // Early on the satellite is small and sits well inside its resting orbit,
  // just off the core's skin.
  const early = byId(bloom.step(grown, 0.066), "b#s0");
  const earlyOffset = Math.hypot(early.x - coreB.x, early.y - coreB.y);
  assert.ok(early.radius > 0.3, "the satellite is growing");
  assert.ok(early.radius < 7 - 0.2, "but not grown yet");
  assert.ok(
    earlyOffset < restingOffset * 0.75,
    "it emerges from inside the mass",
  );
  assert.ok(earlyOffset > restingOffset * 0.3, "not from the core's centre");

  // Settled: full size, back at its resting offset.
  const settled = run(bloom, grown, 1.2, { from: 0.066 });
  const satellite = byId(settled, "b#s0");
  assert.equal(satellite, satB, "the settled satellite is the input node");
});

test("empty frames before data arrives do not spend the exemption", () => {
  const bloom = createSlimeBloom();

  // The host mounted before its workspace hydrated.
  assert.equal(bloom.step([], 0).length, 0);
  assert.equal(bloom.step([], 0.5).length, 0);

  // Hydration is the baseline, not a mass bloom.
  const hydrated = bloom.step(mounted, 1);
  assert.equal(hydrated, mounted, "hydrated concepts appear settled");

  // A concept absorbed after that still blooms.
  const arrival = bloom.step(grown, 1.016);
  assert.equal(byId(arrival, "b").radius, 0);
});

test("frozen shows a newcomer at full size immediately", () => {
  const bloom = createSlimeBloom();
  bloom.step(mounted, 0, { frozen: true });

  const arrival = bloom.step(grown, 0.5, { frozen: true });
  assert.equal(
    arrival,
    grown,
    "reduced motion passes the newcomer through untouched",
  );
});

test("frozen completes a bloom already in flight instantly", () => {
  const bloom = createSlimeBloom();
  bloom.step(mounted, 0);
  bloom.step(grown, 0.016);

  const frame = bloom.step(grown, 0.032, { frozen: true });
  assert.equal(frame, grown, "the in-flight bloom lands at full size");
});

test("a concept that leaves and returns does not bloom again", () => {
  const bloom = createSlimeBloom();
  bloom.step(mounted, 0);
  run(bloom, grown, 1.2, { from: 0.016 });

  // "b" is filtered away (a narrowing search), then comes back.
  bloom.step(mounted, 1.3);
  const back = bloom.step(grown, 1.4);
  assert.equal(back, grown, "a returning concept is already full size");
});
