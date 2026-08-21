import assert from "node:assert/strict";
import test from "node:test";

import {
  deriveSatelliteNodes,
  layoutIslands,
  satelliteCountFor,
} from "./density.ts";

function parent(id, overrides = {}) {
  return {
    id,
    x: 200,
    y: 200,
    depth: 0,
    radius: 40,
    sourceCount: 1,
    mentionCount: 1,
    ...overrides,
  };
}

test("satellite counts grow with real substance and stay capped", () => {
  assert.equal(satelliteCountFor(0, 0), 2);
  assert.equal(satelliteCountFor(1, 0), 3);
  assert.equal(satelliteCountFor(2, 6), 6);
  assert.equal(satelliteCountFor(40, 90), 6);
  assert.equal(satelliteCountFor(Number.NaN, Number.NaN), 2);
});

test("derives deterministic satellites that hug their parent", () => {
  const parents = [parent("alpha"), parent("beta", { x: 500 })];
  const first = deriveSatelliteNodes(parents);
  const second = deriveSatelliteNodes(parents);

  assert.deepEqual(first, second, "placement must be stable across renders");
  assert.equal(first.length, 3 + 3);

  for (const satellite of first) {
    const owner = satellite.id.startsWith("alpha") ? parents[0] : parents[1];
    const dist = Math.hypot(satellite.x - owner.x, satellite.y - owner.y);
    assert.ok(dist >= owner.radius * 1.1, "satellites sit outside the core");
    assert.ok(dist <= owner.radius * 1.7, "satellites stay in the clump");
    assert.ok(satellite.radius <= owner.radius * 0.3, "satellites stay tiny");
    assert.ok(satellite.radius >= 3);
    assert.ok(satellite.id.includes("#s"), "derived ids mark satellites");
  }
});

test("skips parents with broken geometry", () => {
  const satellites = deriveSatelliteNodes([
    parent("ok"),
    parent("nan", { x: Number.NaN }),
    parent("flat", { radius: 0 }),
  ]);
  assert.ok(satellites.every((satellite) => satellite.id.startsWith("ok")));
});

test("islands pull same-category concepts together without growing the map", () => {
  const items = [
    { id: "a", x: 0, y: 0, category: "core" },
    { id: "b", x: 400, y: 0, category: "core" },
    { id: "c", x: 0, y: 400, category: "data" },
    { id: "d", x: 400, y: 400, category: "data" },
  ];

  const laid = layoutIslands(items);

  assert.equal(laid.length, 4);
  assert.deepEqual(
    laid.map((item) => item.id),
    ["a", "b", "c", "d"],
    "order is preserved",
  );

  const dist = (p, q) => Math.hypot(p.x - q.x, p.y - q.y);
  const before = dist(items[0], items[1]);
  const after = dist(laid[0], laid[1]);
  assert.ok(after < before, "same-category concepts move closer");

  const reach = (list) => {
    const gx = list.reduce((sum, item) => sum + item.x, 0) / list.length;
    const gy = list.reduce((sum, item) => sum + item.y, 0) / list.length;
    return Math.max(...list.map((item) => Math.hypot(item.x - gx, item.y - gy)));
  };
  assert.ok(
    Math.abs(reach(laid) - reach(items)) < 1e-6,
    "overall footprint is preserved so nothing clips at screen edges",
  );
});

test("keeps other fields and leaves degenerate inputs alone", () => {
  const single = layoutIslands([{ id: "a", x: 10, y: 20, category: "x" }]);
  assert.deepEqual(single, [{ id: "a", x: 10, y: 20, category: "x" }]);

  const allDistinct = layoutIslands([
    { id: "a", x: 0, y: 0, category: "one", label: "A" },
    { id: "b", x: 100, y: 0, category: "two", label: "B" },
  ]);
  assert.equal(allDistinct[0].x, 0, "one island per concept changes nothing");
  assert.equal(allDistinct[0].label, "A", "extra fields survive the copy");

  const uncategorised = layoutIslands([
    { id: "a", x: 0, y: 0 },
    { id: "b", x: 200, y: 0 },
    { id: "c", x: 100, y: 300, category: "solo" },
  ]);
  const dist = Math.hypot(
    uncategorised[0].x - uncategorised[1].x,
    uncategorised[0].y - uncategorised[1].y,
  );
  assert.ok(dist < 200, "uncategorised concepts share an island");
});
