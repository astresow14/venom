import assert from "node:assert/strict";
import test from "node:test";

import {
  LANDING_ORGANISM_EDGES,
  createLandingOrganism,
  landingClearZone,
} from "./landing-organism.ts";

/**
 * Stage sizes the organism must compose cleanly on. These are canvas boxes
 * (the landing pane), not raw viewports: on md+ the sidebar eats ~207px of
 * the window, so both pane-shaped and phone-shaped boxes appear here.
 */
const STAGES = [
  [1233, 900],
  [1073, 720],
  [817, 768],
  [3233, 1440],
  [760, 600],
  [593, 1280],
  [390, 844],
  [360, 640],
];

/** Sweep long enough to cover every sway/drift period in the composition. */
const SWEEP_SECONDS = 320;
const SWEEP_STEP = 3.7;

/**
 * True when a point (padded by `margin`) stays outside the hero clearing.
 * Same ellipse test the composition is designed against.
 */
function outsideClearZone(zone, x, y, margin) {
  const dx = (x - zone.cx) / (zone.rx + margin);
  const dy = (y - zone.cy) / (zone.ry + margin);
  return dx * dx + dy * dy >= 1;
}

test("the hero clearing stays near-black at every instant and stage size", () => {
  const organism = createLandingOrganism();
  const offenders = [];

  for (const [width, height] of STAGES) {
    const zone = landingClearZone(width, height);
    for (let t = 0; t <= SWEEP_SECONDS; t += SWEEP_STEP) {
      const { nodes, edges } = organism.frame(width, height, t);

      for (const node of nodes) {
        if (!outsideClearZone(zone, node.x, node.y, node.radius)) {
          offenders.push(
            `${node.id} @ ${width}x${height} t=${t.toFixed(1)} ` +
              `(${node.x.toFixed(0)},${node.y.toFixed(0)} r=${node.radius.toFixed(0)})`,
          );
        }
      }

      // Strands are thin; sample along each and keep a smaller pad.
      for (const edge of edges) {
        const a = nodes.find((n) => n.id === edge.sourceId);
        const b = nodes.find((n) => n.id === edge.targetId);
        for (let step = 0; step <= 6; step += 1) {
          const f = step / 6;
          const x = a.x + (b.x - a.x) * f;
          const y = a.y + (b.y - a.y) * f;
          if (!outsideClearZone(zone, x, y, 14)) {
            offenders.push(
              `strand ${edge.sourceId}→${edge.targetId} @ ${width}x${height} ` +
                `t=${t.toFixed(1)} f=${f.toFixed(2)} (${x.toFixed(0)},${y.toFixed(0)})`,
            );
          }
        }
      }

      if (offenders.length > 12) break;
    }
    if (offenders.length > 12) break;
  }

  assert.deepEqual(offenders, [], "composition entered the hero clearing");
});

test("time zero is a deterministic sculpture — reduced motion holds one pose", () => {
  const organism = createLandingOrganism();
  const first = organism
    .frame(1233, 900, 0)
    .nodes.map((node) => ({ ...node }));
  const second = organism.frame(1233, 900, 0).nodes.map((node) => ({ ...node }));
  assert.deepEqual(second, first, "the same instant must be the same pose");

  const later = organism.frame(1233, 900, 8).nodes;
  const moved = later.some(
    (node, index) =>
      Math.hypot(node.x - first[index].x, node.y - first[index].y) > 0.5,
  );
  assert.ok(moved, "the organism roams once the clock actually advances");
});

test("the organism stays on (or just beyond) the stage", () => {
  const organism = createLandingOrganism();
  for (const [width, height] of STAGES) {
    for (let t = 0; t <= SWEEP_SECONDS; t += 11.3) {
      for (const node of organism.frame(width, height, t).nodes) {
        assert.ok(
          node.x > -0.25 * width && node.x < 1.25 * width,
          `${node.id} left the stage horizontally`,
        );
        assert.ok(
          node.y > -0.25 * height && node.y < 1.35 * height,
          `${node.id} left the stage vertically`,
        );
        assert.ok(node.radius > 0, `${node.id} lost its body`);
      }
    }
  }
});

test("the whole organism fits the compact renderer tier", () => {
  const { nodes, edges } = createLandingOrganism().frame(1233, 900, 0);
  // Compact tier capacity is 16 blobs / 12 links; the software tier prunes
  // further by radius, which the packer handles. Everything richer than
  // compact renders the full composition.
  assert.ok(nodes.length <= 16, "too many nodes for the compact tier");
  assert.ok(edges.length <= 12, "too many strands for the compact tier");
});

test("every strand ties two nodes that exist", () => {
  const { nodes } = createLandingOrganism().frame(1233, 900, 0);
  const ids = new Set(nodes.map((node) => node.id));
  for (const edge of LANDING_ORGANISM_EDGES) {
    assert.ok(ids.has(edge.sourceId), `${edge.sourceId} missing`);
    assert.ok(ids.has(edge.targetId), `${edge.targetId} missing`);
    assert.notEqual(edge.sourceId, edge.targetId, "self loops are not strands");
  }
});
