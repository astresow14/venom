import assert from "node:assert/strict";
import test from "node:test";

import { createSlimeLife } from "./life.ts";

const anchors = [
  { id: "a", x: 100, y: 100, depth: 0, radius: 40 },
  { id: "b", x: 300, y: 120, depth: 10, radius: 30 },
  { id: "c", x: 200, y: 300, depth: -10, radius: 24 },
];

function run(life, seconds, options, from = 0) {
  let frame = null;
  // 30 steps per simulated second keeps the dt clamp out of the way.
  const steps = Math.max(1, Math.round(seconds * 30));
  for (let i = 0; i <= steps; i += 1) {
    frame = life.step(anchors, from + (seconds * i) / steps, options);
  }
  return frame;
}

test("populates droplets up to the cap and never beyond", () => {
  const life = createSlimeLife();
  const frame = run(life, 1, { maxDroplets: 12 });

  assert.ok(frame.droplets.length > 0, "expected a living droplet field");
  assert.ok(frame.droplets.length <= 12);

  const bigger = createSlimeLife();
  const rich = run(bigger, 1, { maxDroplets: 64 });
  assert.ok(rich.droplets.length > frame.droplets.length);
  assert.ok(rich.droplets.length <= 64);
});

test("droplet geometry is finite and sized for the field", () => {
  const life = createSlimeLife();
  const frame = run(life, 3, { maxDroplets: 32 });

  for (const droplet of frame.droplets) {
    assert.ok(Number.isFinite(droplet.x));
    assert.ok(Number.isFinite(droplet.y));
    assert.ok(Number.isFinite(droplet.depth));
    assert.ok(droplet.radius > 0);
    assert.ok(droplet.radius < 40, "droplets stay micro");
  }
});

test("is deterministic for the same seed and step sequence", () => {
  const first = createSlimeLife({ seed: 7 });
  const second = createSlimeLife({ seed: 7 });

  const a = run(first, 5, { maxDroplets: 24 });
  const b = run(second, 5, { maxDroplets: 24 });

  assert.deepEqual(a.droplets, b.droplets);
  assert.deepEqual(a.nodes, b.nodes);
});

test("frozen fields are perfectly still but still populated", () => {
  const life = createSlimeLife();
  const first = life.step(anchors, 0, { maxDroplets: 24, frozen: true });
  const count = first.droplets.length;
  assert.ok(count > 0, "reduced motion keeps the density");

  const snapshot = first.droplets.map((droplet) => ({ ...droplet }));
  const later = life.step(anchors, 60, { maxDroplets: 24, frozen: true });

  assert.equal(later.droplets.length, count);
  assert.deepEqual(
    later.droplets.map((droplet) => ({ ...droplet })),
    snapshot,
  );
  // Anchors pass through untouched: no pulses under reduced motion.
  assert.deepEqual(later.nodes, anchors);
});

test("droplets ride along when the camera moves the anchors", () => {
  const life = createSlimeLife({ seed: 3 });
  const before = run(life, 2, { maxDroplets: 24 });
  const positions = before.droplets.map((droplet) => ({ ...droplet }));

  const panned = anchors.map((anchor) => ({
    ...anchor,
    x: anchor.x + 500,
    y: anchor.y - 120,
  }));
  // Same timestamp again: zero dt, so any position change comes from anchors.
  const after = life.step(panned, 2, { maxDroplets: 24 });

  assert.equal(after.droplets.length, positions.length);
  for (let i = 0; i < positions.length; i += 1) {
    assert.ok(
      Math.abs(after.droplets[i].x - (positions[i].x + 500)) < 1e-6,
      `droplet ${i} should pan with the field`,
    );
    assert.ok(
      Math.abs(after.droplets[i].y - (positions[i].y - 120)) < 1e-6,
      `droplet ${i} should pan with the field`,
    );
  }
});

test("life events eventually pulse the anchors and move droplets", () => {
  const life = createSlimeLife({ seed: 11 });

  let sawPulse = false;
  let sawTravel = false;
  let previous = null;

  for (let tick = 0; tick <= 40 * 30; tick += 1) {
    const now = tick / 30;
    const frame = life.step(anchors, now, { maxDroplets: 24 });

    for (let i = 0; i < frame.nodes.length; i += 1) {
      if (Math.abs(frame.nodes[i].radius - anchors[i].radius) > 0.5) {
        sawPulse = true;
      }
    }

    if (previous && frame.droplets.length === previous.length) {
      for (let i = 0; i < frame.droplets.length; i += 1) {
        const dx = frame.droplets[i].x - previous[i].x;
        const dy = frame.droplets[i].y - previous[i].y;
        // A leap covers far more ground per tick than an orbit wobble.
        if (Math.hypot(dx, dy) > 8) sawTravel = true;
      }
    }
    previous = frame.droplets.map((droplet) => ({ ...droplet }));

    if (sawPulse && sawTravel) break;
  }

  assert.ok(sawPulse, "anchors should deflate or swell as droplets pinch and fuse");
  assert.ok(sawTravel, "droplets should leap between clusters");
});

test("survives anchors vanishing between steps", () => {
  const life = createSlimeLife({ seed: 5 });
  run(life, 3, { maxDroplets: 24 });

  const remaining = [anchors[0]];
  const frame = run(life, 1, { maxDroplets: 24 }, 3);
  const reduced = life.step(remaining, 4.5, { maxDroplets: 24 });

  assert.ok(frame.droplets.length > 0);
  for (const droplet of reduced.droplets) {
    assert.ok(Number.isFinite(droplet.x));
    assert.ok(Number.isFinite(droplet.y));
    assert.ok(droplet.radius > 0);
  }
});

test("an empty map emits no droplets", () => {
  const life = createSlimeLife();
  const frame = life.step([], 0, { maxDroplets: 24 });
  assert.equal(frame.nodes.length, 0);
  assert.equal(frame.droplets.length, 0);
});

test("a zero droplet budget keeps the field bare without touching anchors", () => {
  const life = createSlimeLife({ seed: 5 });
  let frame = null;
  for (let step = 0; step <= 600; step += 1) {
    frame = life.step(anchors, step / 60, { maxDroplets: 0, frozen: false });
  }
  assert.equal(frame.droplets.length, 0);
  assert.equal(frame.nodes.length, anchors.length);
});
