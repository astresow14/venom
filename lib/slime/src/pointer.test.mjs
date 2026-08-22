import assert from "node:assert/strict";
import test from "node:test";

import {
  SLIME_POINTER_PRESSED_WEIGHT,
  SLIME_POINTER_RADIUS,
  SLIME_POINTER_SWELL,
  SLIME_POINTER_TENDRIL_DROPS,
  SLIME_POINTER_TENDRIL_REACH,
  createSlimePointer,
} from "./pointer.ts";

const nodes = [
  { id: "near", x: 100, y: 100, depth: 20, radius: 40 },
  { id: "mid", x: 340, y: 100, depth: -10, radius: 24 },
  { id: "far", x: 5000, y: 5000, depth: 0, radius: 30 },
];

const byId = (frame, id) => frame.find((node) => node.id === id);

/**
 * Advance the attractor at 60 steps per simulated second, like a render loop
 * would. Returns the last frame; callers must read values immediately since
 * the output array is reused between steps.
 */
function run(pointer, frame, target, seconds, { frozen = false, from = 0 } = {}) {
  let result = frame;
  const steps = Math.max(1, Math.round(seconds * 60));
  for (let i = 0; i <= steps; i += 1) {
    result = pointer.step(frame, target, from + (seconds * i) / steps, {
      frozen,
    });
  }
  return result;
}

/** The settled swell factor for a node at `dist` under weight `w`. */
function settledSwell(dist, radius, w = 1) {
  const q = dist / (SLIME_POINTER_RADIUS + radius);
  const falloff = (1 - q) ** 2;
  return 1 + SLIME_POINTER_SWELL * falloff * w;
}

test("no pointer means the input passes through untouched", () => {
  const pointer = createSlimePointer();
  const frame = pointer.step(nodes, null, 0);
  assert.equal(frame, nodes, "expected the very same array back");
  assert.equal(pointer.reach([]).length, 0);
});

test("the mass eases toward a hovering pointer instead of snapping", () => {
  const pointer = createSlimePointer();
  const target = { x: 140, y: 100 };

  // First frame: the weight starts from rest, so nothing has moved yet.
  const first = pointer.step(nodes, target, 0);
  assert.equal(first, nodes, "reaction starts from rest");

  // A few frames in the swell is under way but not finished.
  const early = byId(run(pointer, nodes, target, 0.08), "near");
  const full = 40 * settledSwell(40, 40);
  assert.ok(early.radius > 40 + 0.3, "eases upward instead of staying put");
  assert.ok(early.radius < full - 0.3, "eases upward instead of snapping");

  // Settled: swollen by the falloff-scaled amount, leaning toward the
  // pointer, lifted toward the viewer plane; far nodes untouched.
  const settled = run(pointer, nodes, target, 2.5, { from: 0.1 });
  const near = byId(settled, "near");
  assert.ok(Math.abs(near.radius - full) < full * 0.01, "settles at the swell");
  assert.ok(near.x > 100.5, "leans toward the pointer");
  assert.ok(Math.abs(near.y - 100) < 1e-6, "lean is aimed, not sideways");
  assert.ok(near.depth < 20 && near.depth > 20 * 0.6, "lifts toward the viewer");
  assert.equal(byId(settled, "far"), nodes[2], "distant mass stays asleep");
  assert.ok(pointer.snapshot().touched >= 2, "snapshot counts touched nodes");
});

test("the reach is strongest at mid distance", () => {
  const at = (dist) => {
    const pointer = createSlimePointer();
    const lone = [{ id: "a", x: 0, y: 0, depth: 0, radius: 40 }];
    const frame = run(pointer, lone, { x: dist, y: 0 }, 2.5);
    return byId(frame, "a").x;
  };
  const close = at(30);
  const mid = at(160);
  assert.ok(close > 0 && mid > 0, "both lean toward the pointer");
  assert.ok(mid > close, "a mid-distance blob stretches further than a near one");
});

test("release settles back to rest and the frame passes through again", () => {
  const pointer = createSlimePointer();
  const settled = byId(run(pointer, nodes, { x: 140, y: 100 }, 2), "near");
  const swollen = settled.radius;

  const releasing = byId(pointer.step(nodes, null, 2.1), "near");
  assert.ok(releasing.radius < swollen, "starts easing out");
  assert.ok(releasing.radius > 40 + 0.3, "does not snap back");

  const rested = run(pointer, nodes, null, 5, { from: 2.2 });
  assert.equal(rested, nodes, "a fully released pointer passes through");
  assert.equal(pointer.snapshot().weight, 0);
  assert.equal(pointer.reach([]).length, 0, "no tendril at rest");
});

test("pressed pulls harder than hovering", () => {
  const hover = byId(
    run(createSlimePointer(), nodes, { x: 140, y: 100 }, 3),
    "near",
  );
  const pressed = byId(
    run(createSlimePointer(), nodes, { x: 140, y: 100, pressed: true }, 3),
    "near",
  );
  assert.ok(pressed.radius > hover.radius, "pressed swells harder");
  assert.ok(pressed.x > hover.x, "pressed leans harder");
  const expected = 40 * settledSwell(40, 40, SLIME_POINTER_PRESSED_WEIGHT);
  assert.ok(Math.abs(pressed.radius - expected) < expected * 0.01);
});

test("frozen keeps the sculpt perfectly still and drops eased state", () => {
  const pointer = createSlimePointer();

  // Reduced motion from the start: an active pointer changes nothing.
  const still = pointer.step(nodes, { x: 140, y: 100 }, 0, { frozen: true });
  assert.equal(still, nodes, "no chasing under reduced motion");

  // Mid-reaction freeze: the frame passes through and the state is dropped.
  run(pointer, nodes, { x: 140, y: 100 }, 1, { from: 0.1 });
  const frozen = pointer.step(nodes, { x: 140, y: 100 }, 1.2, { frozen: true });
  assert.equal(frozen, nodes, "freezing releases the mass instantly");
  assert.equal(pointer.snapshot().weight, 0);
  assert.equal(pointer.reach([]).length, 0, "no tendril while frozen");

  // Leaving reduced motion starts from rest instead of mid-reaction.
  const back = pointer.step(nodes, { x: 140, y: 100 }, 1.25);
  assert.equal(back, nodes, "the first unfrozen frame starts from rest");
});

test("the smoothed position trails a teleporting pointer", () => {
  const pointer = createSlimePointer();
  const lone = [{ id: "a", x: 0, y: 0, depth: 0, radius: 40 }];

  run(pointer, lone, { x: 100, y: 0 }, 2);
  assert.ok(byId(pointer.step(lone, { x: 100, y: 0 }, 2.01), "a").x > 0);

  // The raw pointer jumps to the other side; the lean keeps pointing at the
  // trailing position for the first frames instead of snapping across.
  const justAfter = byId(pointer.step(lone, { x: -100, y: 0 }, 2.03), "a");
  assert.ok(justAfter.x > 0, "the mass is still reaching toward the old side");

  const later = byId(run(pointer, lone, { x: -100, y: 0 }, 2, { from: 2.05 }), "a");
  assert.ok(later.x < 0, "and eventually follows the pointer across");
});

test("droplets are drawn in and a tendril bridges toward the pointer", () => {
  const pointer = createSlimePointer();
  const lone = [{ id: "a", x: 100, y: 100, depth: 12, radius: 40 }];
  const target = { x: 220, y: 100 };
  run(pointer, lone, target, 2.5);

  const droplets = [
    { x: 150, y: 100, depth: 0, radius: 5 },
    { x: 9000, y: 9000, depth: 0, radius: 5 },
  ];
  const reached = pointer.reach(droplets);

  assert.equal(
    reached.length,
    droplets.length + SLIME_POINTER_TENDRIL_DROPS,
    "the tendril adds its droplets to the frame",
  );

  // Tendril droplets are prepended and lie between the surface and pointer.
  for (let i = 0; i < SLIME_POINTER_TENDRIL_DROPS; i += 1) {
    const drop = reached[i];
    assert.ok(drop.x > 100 && drop.x <= 220, "tendril spans toward the pointer");
    assert.ok(Math.abs(drop.y - 100) < 1e-6);
    assert.ok(drop.radius > 0);
  }

  const pulled = reached[SLIME_POINTER_TENDRIL_DROPS];
  assert.ok(pulled.x > 150, "a droplet in the field is drawn in");
  assert.ok(pulled.radius > 5, "and swells slightly as it goes");
  assert.equal(droplets[0].x, 150, "the input droplet is never mutated");

  const untouched = reached[SLIME_POINTER_TENDRIL_DROPS + 1];
  assert.equal(untouched, droplets[1], "far droplets pass through by reference");
});

test("no tendril when the mass is out of reach", () => {
  const pointer = createSlimePointer();
  const lone = [{ id: "a", x: 0, y: 0, depth: 0, radius: 20 }];
  // Inside the influence radius (the node still swells) but the surface gap
  // stays beyond the tendril reach, so no pseudopod forms.
  const dist = SLIME_POINTER_TENDRIL_REACH + 20 + 40;
  run(pointer, lone, { x: dist, y: 0 }, 2.5);
  assert.equal(pointer.reach([]).length, 0);
});
