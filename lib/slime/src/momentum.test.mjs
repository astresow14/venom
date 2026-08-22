import assert from "node:assert/strict";
import test from "node:test";

import {
  SLIME_MOMENTUM_MAX_LAG,
  createSlimeMomentum,
} from "./momentum.ts";

const nodes = [
  { id: "a", x: 100, y: 100, depth: 0, radius: 40 },
  { id: "b", x: 300, y: 120, depth: 10, radius: 30 },
  // Satellite clump derived from "a" (density.ts id contract) — momentum
  // treats it like any other blob, keyed by its own id.
  { id: "a#s0", x: 150, y: 130, depth: 6, radius: 8 },
];

const byId = (frame, id) => frame.find((node) => node.id === id);

/** A camera fling: every node translated by the same screen offset. */
const shifted = (frame, dx, dy = 0, dDepth = 0) =>
  frame.map((node) => ({
    ...node,
    x: node.x + dx,
    y: node.y + dy,
    depth: node.depth + dDepth,
  }));

/**
 * Drive the momentum at 60 steps per simulated second, like a render loop
 * would, holding the same target frame. Returns the last output; callers
 * must read values immediately since the output array is reused.
 */
function settle(momentum, target, seconds, { frozen = false, from = 0 } = {}) {
  let frame = target;
  const steps = Math.max(1, Math.round(seconds * 60));
  for (let i = 0; i <= steps; i += 1) {
    frame = momentum.step(target, from + (seconds * i) / steps, { frozen });
  }
  return frame;
}

test("a still map passes through untouched", () => {
  const momentum = createSlimeMomentum();
  const first = momentum.step(nodes, 0);
  assert.equal(first, nodes, "the seeding frame is already rigid");
  const second = momentum.step(nodes, 0.016);
  assert.equal(second, nodes, "a still camera keeps the very same array");
});

test("a fling makes the mass trail behind, then settle without snapping", () => {
  const momentum = createSlimeMomentum();
  momentum.step(nodes, 0);

  // Fling: the whole map slides at 600 px/s for 0.6 s.
  const speed = 600;
  const seconds = 0.6;
  const steps = Math.round(seconds * 60);
  let target = nodes;
  let gap = 0;
  let earlyGap = null;
  for (let i = 1; i <= steps; i += 1) {
    const t = i / 60;
    target = shifted(nodes, speed * t);
    const frame = momentum.step(target, t);
    gap = byId(target, "a").x - byId(frame, "a").x;
    if (i === 3) earlyGap = gap;
  }
  assert.ok(gap > 30, `the mass visibly lags the fling (gap ${gap}px)`);
  assert.ok(
    gap <= SLIME_MOMENTUM_MAX_LAG + 1e-6,
    "the trail never exceeds its cap",
  );
  assert.ok(earlyGap < gap, "the lag builds up rather than appearing at once");

  // The gesture ends: the map stops dead, the mass keeps moving and eases
  // in. Nothing snaps — the gap closes over many frames.
  const stopAt = seconds;
  const restingX = byId(target, "a").x;
  let previousGap = gap;
  let sawGradualClose = false;
  let overshoot = 0;
  let frame = target;
  for (let i = 1; i <= 120; i += 1) {
    frame = momentum.step(target, stopAt + i / 60);
    const offset = byId(frame, "a").x - restingX;
    if (offset < 0 && -offset > previousGap * 0.55 && i <= 3) {
      sawGradualClose = true;
    }
    overshoot = Math.max(overshoot, offset);
    previousGap = Math.max(-offset, 0);
  }
  assert.ok(
    sawGradualClose,
    "the first frames after release still carry most of the gap",
  );
  assert.ok(
    overshoot > 1,
    `the mass swings slightly past its resting pose (overshoot ${overshoot}px)`,
  );
  assert.ok(
    overshoot < SLIME_MOMENTUM_MAX_LAG / 2,
    "the follow-through stays a settle, not a bounce across the map",
  );

  // Fully settled: the input array itself comes back.
  const rested = settle(momentum, target, 2, { from: stopAt + 2 });
  assert.equal(rested, target, "a settled mass passes through untouched");
});

test("every blob trails its own motion, so depth parallax shears the mass", () => {
  const momentum = createSlimeMomentum();
  momentum.step(nodes, 0);

  // An orbit moves near and far nodes by different amounts (and pushes them
  // through depth). Give "b" three times the screen motion of "a".
  let frame = nodes;
  for (let i = 1; i <= 12; i += 1) {
    const target = nodes.map((node) => ({
      ...node,
      x: node.x + (node.id === "b" ? 30 : 10) * i,
      depth: node.depth + (node.id === "b" ? 6 : 2) * i,
    }));
    frame = momentum.step(target, i / 60);
    if (i === 12) {
      const gapA = 100 + 10 * 12 - byId(frame, "a").x;
      const gapB = 300 + 30 * 12 - byId(frame, "b").x;
      assert.ok(gapB > gapA * 1.5, "the faster blob lags further behind");
      const depthGapB = 10 + 6 * 12 - byId(frame, "b").depth;
      assert.ok(depthGapB > 1, "depth trails too, so orbits stretch in 3D");
    }
  }
});

test("frozen keeps the motion rigid, with no added animation", () => {
  const momentum = createSlimeMomentum();
  momentum.step(nodes, 0);

  // Mid-fling, reduced motion turns on: the very same frame comes back.
  const flungA = shifted(nodes, 80);
  momentum.step(flungA, 1 / 60);
  const flungB = shifted(nodes, 160);
  const rigid = momentum.step(flungB, 2 / 60, { frozen: true });
  assert.equal(rigid, flungB, "frozen returns the input array itself");

  // Leaving reduced motion starts from rest: the first full-motion frame is
  // still rigid instead of animating out of a stale trail.
  const flungC = shifted(nodes, 240);
  const resumed = momentum.step(flungC, 3 / 60);
  assert.equal(resumed, flungC, "no stale pose survives the frozen spell");
});

test("a concept new to the frame appears in place, not flying in", () => {
  const momentum = createSlimeMomentum();
  momentum.step(nodes, 0);
  const target = [
    ...shifted(nodes, 90),
    { id: "fresh", x: 640, y: 300, depth: -4, radius: 18 },
  ];
  const frame = momentum.step(target, 1 / 60);
  const fresh = byId(frame, "fresh");
  assert.equal(fresh.x, 640, "first sighting lands exactly on target");
  assert.equal(fresh.y, 300);
  assert.ok(
    byId(target, "a").x - byId(frame, "a").x > 0,
    "while existing blobs are mid-trail",
  );
});

test("a concept that leaves the frame is forgotten immediately", () => {
  const momentum = createSlimeMomentum();
  momentum.step(nodes, 0);
  // Build up a trail, then filter "a" (and its satellite) out.
  momentum.step(shifted(nodes, 100), 1 / 60);
  const without = shifted(nodes, 100).filter(
    (node) => !node.id.startsWith("a"),
  );
  momentum.step(without, 2 / 60);

  // It returns far from where it disappeared: it must appear in place.
  const back = shifted(nodes, 400);
  const frame = momentum.step(back, 3 / 60);
  assert.equal(
    byId(frame, "a").x,
    byId(back, "a").x,
    "the returning concept does not fly in from its old spot",
  );
});

test("a teleporting map stretches to the cap instead of tearing away", () => {
  const momentum = createSlimeMomentum();
  momentum.step(nodes, 0);
  const teleported = shifted(nodes, 1000, 700);
  const frame = momentum.step(teleported, 1 / 60);
  const node = byId(frame, "a");
  const gap = Math.hypot(
    byId(teleported, "a").x - node.x,
    byId(teleported, "a").y - node.y,
  );
  assert.ok(
    gap <= SLIME_MOMENTUM_MAX_LAG + 1e-6,
    `the trail is capped (gap ${gap}px)`,
  );
  assert.ok(gap > SLIME_MOMENTUM_MAX_LAG - 1, "and the cap is actually used");
});
