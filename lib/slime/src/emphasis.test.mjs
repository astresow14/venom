import assert from "node:assert/strict";
import test from "node:test";

import {
  HOVERED_EMPHASIS_WEIGHT,
  LINKED_EMPHASIS_SHARE,
  SLIME_EMPHASIS_SWELL,
  createSlimeEmphasis,
} from "./emphasis.ts";

const nodes = [
  { id: "a", x: 100, y: 100, depth: 0, radius: 40 },
  { id: "b", x: 300, y: 120, depth: 10, radius: 30 },
  { id: "c", x: 500, y: 400, depth: -10, radius: 24 },
  // Satellite clump derived from "a" (density.ts id contract).
  { id: "a#s0", x: 150, y: 130, depth: 6, radius: 8 },
];

const edges = [{ sourceId: "a", targetId: "b" }];

const byId = (frame, id) => frame.find((node) => node.id === id);

/**
 * Advance the emphasis at 60 steps per simulated second, like a render loop
 * would. Returns the last frame; callers must read values immediately since
 * the output array is reused between steps.
 */
function run(emphasis, targets, seconds, { frozen = false, from = 0 } = {}) {
  let frame = nodes;
  const steps = Math.max(1, Math.round(seconds * 60));
  for (let i = 0; i <= steps; i += 1) {
    frame = emphasis.step(nodes, edges, targets, from + (seconds * i) / steps, {
      frozen,
    });
  }
  return frame;
}

test("no touch means the input passes through untouched", () => {
  const emphasis = createSlimeEmphasis();
  const frame = emphasis.step(nodes, edges, {}, 0);
  assert.equal(frame, nodes, "expected the very same array back");
});

test("selection swells the concept and its satellites, easing in and out", () => {
  const emphasis = createSlimeEmphasis();

  // First frame: the weight starts from rest, so nothing has moved yet.
  const first = byId(
    emphasis.step(nodes, edges, { selectedId: "a" }, 0),
    "a",
  ).radius;
  assert.ok(Math.abs(first - 40) < 1e-9, "reaction starts from the base radius");

  // A few frames in the swell is visibly under way but not finished.
  const early = byId(
    emphasis.step(nodes, edges, { selectedId: "a" }, 0.05),
    "a",
  ).radius;
  const full = 40 * (1 + SLIME_EMPHASIS_SWELL);
  assert.ok(early > 40 + 0.5, "eases upward instead of staying put");
  assert.ok(early < full - 0.5, "eases upward instead of snapping");

  // Settled: core and satellite both carry the full swell. Values are
  // captured immediately — the frame array is reused by later steps.
  const settled = run(emphasis, { selectedId: "a" }, 1.2, { from: 0.05 });
  const settledCore = byId(settled, "a").radius;
  const settledSatellite = byId(settled, "a#s0").radius;
  assert.ok(Math.abs(settledCore - full) < full * 0.01);
  assert.ok(
    Math.abs(settledSatellite - 8 * (1 + SLIME_EMPHASIS_SWELL)) < 0.1,
    "the satellite clump swells with its core",
  );
  assert.equal(
    byId(settled, "c"),
    nodes[2],
    "an unrelated concept is left untouched",
  );

  // Releasing eases back down rather than snapping.
  const releasing = byId(emphasis.step(nodes, edges, {}, 1.3), "a").radius;
  assert.ok(releasing < settledCore, "starts easing out");
  assert.ok(releasing > 40 + 0.5, "does not snap back");

  const rested = run(emphasis, {}, 2, { from: 1.35 });
  assert.equal(rested, nodes, "fully released weights drop away entirely");
});

test("hover reacts more lightly than selection", () => {
  const hovered = run(createSlimeEmphasis(), { hoveredId: "a" }, 1.2);
  const expected = 40 * (1 + SLIME_EMPHASIS_SWELL * HOVERED_EMPHASIS_WEIGHT);
  assert.ok(Math.abs(byId(hovered, "a").radius - expected) < expected * 0.01);

  const selected = run(createSlimeEmphasis(), { selectedId: "a" }, 1.2);
  assert.ok(byId(selected, "a").radius > byId(hovered, "a").radius);
});

test("linked neighbours lean toward the active concept", () => {
  const frame = run(createSlimeEmphasis(), { selectedId: "a" }, 1.2);
  const expected =
    30 * (1 + SLIME_EMPHASIS_SWELL * LINKED_EMPHASIS_SHARE);
  assert.ok(
    Math.abs(byId(frame, "b").radius - expected) < expected * 0.01,
    "the linked neighbour swells by its share",
  );
  assert.equal(byId(frame, "c"), nodes[2], "unlinked concepts stay put");
});

test("satellites pull in toward their swollen core", () => {
  const frame = run(createSlimeEmphasis(), { selectedId: "a" }, 1.2);
  const satellite = byId(frame, "a#s0");
  const before = Math.hypot(150 - 100, 130 - 100);
  const after = Math.hypot(satellite.x - 100, satellite.y - 100);
  assert.ok(after < before, "the clump tightens against the core");
  assert.ok(after > before * 0.7, "but stays a distinct clump");
});

test("frozen applies the state change instantly, with no animation", () => {
  const emphasis = createSlimeEmphasis();

  const swollen = emphasis.step(nodes, edges, { selectedId: "a" }, 0, {
    frozen: true,
  });
  const full = 40 * (1 + SLIME_EMPHASIS_SWELL);
  assert.ok(
    Math.abs(byId(swollen, "a").radius - full) < 1e-9,
    "the very first frozen frame carries the full state",
  );

  const released = emphasis.step(nodes, edges, {}, 0.016, { frozen: true });
  assert.equal(released, nodes, "deselection lands just as instantly");
});

test("ids that match no node on the map do nothing", () => {
  const emphasis = createSlimeEmphasis();
  const frame = run(emphasis, { selectedId: "ghost", hoveredId: "gone" }, 0.5);
  assert.equal(frame, nodes);
});

test("a concept that leaves the map releases its weight", () => {
  const emphasis = createSlimeEmphasis();
  run(emphasis, { selectedId: "a" }, 1);

  // "a" disappears (filtered out) while still selected: its weight decays.
  const without = nodes.filter((node) => !node.id.startsWith("a"));
  let frame = without;
  for (let i = 1; i <= 120; i += 1) {
    frame = emphasis.step(without, edges, { selectedId: "a" }, 1 + i / 60);
  }
  assert.equal(frame, without, "the stale weight fully drains away");

  // When it returns it starts from rest instead of reappearing swollen
  // (dt 0 samples the weight before any new attack accrues).
  const back = emphasis.step(nodes, edges, { selectedId: "a" }, 3);
  assert.ok(Math.abs(byId(back, "a").radius - 40) < 1e-9);
});
