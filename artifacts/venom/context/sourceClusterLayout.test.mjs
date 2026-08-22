import assert from "node:assert/strict";
import test from "node:test";

import { spreadSourceClusters } from "./sourceClusterLayout.ts";

// Mirrors the knowledge screen's contract: logical units are doubled into map
// pixels, nodes render up to 40 map px (20 units) wide, and no pair of nodes
// may sit closer than 12 units (24 map px) so the smaller one stays tappable.
const OVERLAP_FLOOR = 12;

const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

const minPairwiseDistance = (points) => {
  let min = Infinity;
  for (let i = 0; i < points.length; i += 1) {
    for (let j = i + 1; j < points.length; j += 1) {
      min = Math.min(min, distance(points[i], points[j]));
    }
  }
  return min;
};

const minDistanceToAny = (points, others) =>
  points.reduce(
    (min, point) =>
      others.reduce((inner, other) => Math.min(inner, distance(point, other)), min),
    Infinity,
  );

/** The wrapped modulo grid the spiral replaced, kept here as the regression baseline. */
const legacyModuloPoints = (sourceCount, clustersPerSource) => {
  const points = [];
  for (let sourceIndex = 0; sourceIndex < sourceCount; sourceIndex += 1) {
    for (let clusterIndex = 0; clusterIndex < clustersPerSource; clusterIndex += 1) {
      points.push({
        x: ((sourceIndex * 149 + clusterIndex * 83) % 440) - 220,
        y: ((sourceIndex * 97 + clusterIndex * 131) % 300) - 150,
      });
    }
  }
  return points;
};

// The five chat-derived clusters a fresh workspace starts with; the layout
// treats their stored positions as immovable and routes around them.
const defaultClusterPositions = [
  { x: 50, y: 50 },
  { x: 120, y: -30 },
  { x: -80, y: 60 },
  { x: 200, y: 10 },
  { x: -40, y: -90 },
];

test("the legacy modulo grid stacked nodes; the spiral never drops below the tap floor", () => {
  // Six sources with three clusters each already packed two nodes within
  // 11.4 units — under a single node's 20-unit width, so one buried the
  // other. At scale the wrap produced exact duplicates.
  assert.ok(minPairwiseDistance(legacyModuloPoints(6, 3)) < OVERLAP_FLOOR);
  const stacked = legacyModuloPoints(116, 6);
  assert.ok(
    stacked.some(
      (point, index) =>
        stacked.findIndex(
          (other) => other.x === point.x && other.y === point.y,
        ) !== index,
    ),
    "expected the legacy formula to produce an exact duplicate",
  );

  // The same 18-cluster workspace keeps nodes almost a full node width clear
  // of each other now, and no workspace size ever dips below the floor.
  assert.ok(minPairwiseDistance(spreadSourceClusters(18)) >= 24);
  for (let count = 2; count <= 64; count += 1) {
    assert.ok(
      minPairwiseDistance(spreadSourceClusters(count)) >= OVERLAP_FLOOR,
      `count ${count} fell below the overlap floor`,
    );
  }
  for (const count of [90, 150, 300, 696]) {
    assert.ok(
      minPairwiseDistance(spreadSourceClusters(count)) >= OVERLAP_FLOOR,
      `count ${count} fell below the overlap floor`,
    );
  }
});

test("placement is a pure function of the workspace, so re-renders cannot jitter", () => {
  const first = spreadSourceClusters(24, defaultClusterPositions);
  const second = spreadSourceClusters(24, defaultClusterPositions);
  assert.deepEqual(first, second);
  for (const point of first) {
    assert.ok(Number.isInteger(point.x) && Number.isInteger(point.y));
  }
});

test("source clusters keep clear of the chat clusters already on the map", () => {
  const placed = spreadSourceClusters(24, defaultClusterPositions);
  assert.ok(minDistanceToAny(placed, defaultClusterPositions) >= 26);
  assert.ok(minPairwiseDistance(placed) >= OVERLAP_FLOOR);

  // Even when the avoid list sits exactly on the spiral's own slots, the
  // walk skips past them instead of stacking on top.
  const adversarial = spreadSourceClusters(10);
  const rerouted = spreadSourceClusters(10, adversarial);
  assert.ok(minDistanceToAny(rerouted, adversarial) >= 26);
  assert.ok(minPairwiseDistance(rerouted) >= OVERLAP_FLOOR);
});

test("realistic workspaces stay on the rendered canvas", () => {
  for (const count of [12, 48, 96, 150]) {
    const points = spreadSourceClusters(count, defaultClusterPositions);
    for (const point of points) {
      // 220 logical units render 440 map px from the centre of the 1000px
      // canvas, leaving room for the node itself and its label.
      assert.ok(
        Math.abs(point.x) <= 220 && Math.abs(point.y) <= 220,
        `count ${count} placed a node off the canvas at ${point.x},${point.y}`,
      );
    }
  }
});

test("the layout floor is the shared map spacing floor from the merge lib", async () => {
  // sourceClusterLayout enforces the map-wide tappability floor. That floor
  // is owned by @workspace/venom-workspace-merge so chat-cluster placement
  // and the stacked-dot repair keep the exact same distance; if either side
  // changed independently, source dots and chat dots could overlap again.
  const { CLUSTER_SPACING_FLOOR } = await import(
    "@workspace/venom-workspace-merge"
  );
  assert.equal(CLUSTER_SPACING_FLOOR, OVERLAP_FLOOR);
  assert.equal(CLUSTER_SPACING_FLOOR, 12);
});

// ---------------------------------------------------------------------------
// Pods: grouped input keeps each source's clusters together.
// ---------------------------------------------------------------------------

// A realistic mixed workspace: GitHub repositories (hub + issues + pull
// requests), websites (hub + keyword topics), and single-cluster sources.
const realisticPodSizes = [3, 1, 6, 2, 4, 1, 8, 5];

/** Splits the flat result back into per-source pods, hub first. */
const podsOf = (sizes, points) => {
  const pods = [];
  let cursor = 0;
  for (const size of sizes) {
    pods.push(points.slice(cursor, cursor + size));
    cursor += size;
  }
  assert.equal(cursor, points.length);
  return pods;
};

const maxHubToSatellite = (pod) =>
  pod.slice(1).reduce((max, satellite) => Math.max(max, distance(pod[0], satellite)), 0);

test("a source's satellites ring their hub instead of scattering down the spiral", () => {
  const points = spreadSourceClusters(realisticPodSizes, defaultClusterPositions);
  const pods = podsOf(realisticPodSizes, points);

  for (const pod of pods) {
    // Up to 7 satellites share the hub's first ring at 20 units; the eighth
    // steps one POD_RING_STEP further out. Integer rounding adds under a
    // unit. So even the largest realistic pod keeps every dashed link under
    // 35 units — the flattened spiral spread the same source across the map.
    assert.ok(
      maxHubToSatellite(pod) <= 35,
      `a satellite drifted ${maxHubToSatellite(pod)} units from its hub`,
    );
  }
  const smallPods = pods.filter((pod) => pod.length >= 2 && pod.length <= 8);
  assert.ok(smallPods.length >= 4, "expected pods that fit a single ring");
  for (const pod of smallPods) {
    assert.ok(
      maxHubToSatellite(pod) <= 21,
      `a single-ring satellite drifted ${maxHubToSatellite(pod)} units from its hub`,
    );
  }

  // The regression this layout fixes: the same workspace flattened onto the
  // plain spiral placed a source's dots wherever the shared order fell, so
  // its hub-to-satellite links stretched across the canvas.
  const total = realisticPodSizes.reduce((sum, size) => sum + size, 0);
  const flattened = podsOf(
    realisticPodSizes,
    spreadSourceClusters(total, defaultClusterPositions),
  );
  const worstFlattened = Math.max(...flattened.map(maxHubToSatellite));
  assert.ok(
    worstFlattened > 100,
    `expected the flat spiral to scatter a pod, got ${worstFlattened}`,
  );
});

test("the overlap floor holds inside pods, across pods, and against chat clusters", () => {
  const points = spreadSourceClusters(realisticPodSizes, defaultClusterPositions);
  assert.ok(minPairwiseDistance(points) >= OVERLAP_FLOOR);
  assert.ok(minDistanceToAny(points, defaultClusterPositions) >= 26);

  // Even an absurd pod (one source with 30 clusters) and a crowded map keep
  // every node its own tappable spot.
  const absurd = spreadSourceClusters([30, 3, 3, 3], defaultClusterPositions);
  assert.ok(minPairwiseDistance(absurd) >= OVERLAP_FLOOR);
  const crowded = spreadSourceClusters(Array.from({ length: 50 }, () => 6));
  assert.ok(minPairwiseDistance(crowded) >= OVERLAP_FLOOR);
});

test("pod placement stays a pure function of the workspace", () => {
  const first = spreadSourceClusters(realisticPodSizes, defaultClusterPositions);
  const second = spreadSourceClusters(realisticPodSizes, defaultClusterPositions);
  assert.deepEqual(first, second);
  for (const point of first) {
    assert.ok(Number.isInteger(point.x) && Number.isInteger(point.y));
  }

  // A flat count is shorthand for that many single-cluster pods, so the
  // spiral's original layout — and every caller passing a number — is
  // unchanged byte for byte.
  assert.deepEqual(
    spreadSourceClusters(18, defaultClusterPositions),
    spreadSourceClusters(Array.from({ length: 18 }, () => 1), defaultClusterPositions),
  );

  // Sources without clusters contribute nothing and shift nothing.
  assert.deepEqual(
    spreadSourceClusters([3, 0, 5], defaultClusterPositions),
    spreadSourceClusters([3, 5], defaultClusterPositions),
  );
});

test("realistic pod workspaces stay on the rendered canvas", () => {
  const workspaces = [
    realisticPodSizes,
    Array.from({ length: 12 }, () => 4),
    Array.from({ length: 24 }, () => 3),
    Array.from({ length: 8 }, (_, index) => index + 1),
  ];
  for (const sizes of workspaces) {
    const points = spreadSourceClusters(sizes, defaultClusterPositions);
    for (const point of points) {
      assert.ok(
        Math.abs(point.x) <= 220 && Math.abs(point.y) <= 220,
        `pods ${sizes.join(",")} placed a node off the canvas at ${point.x},${point.y}`,
      );
    }
  }
});
