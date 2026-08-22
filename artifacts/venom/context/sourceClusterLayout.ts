/**
 * Deterministic map placement for connected-source clusters.
 *
 * The knowledge screen used to scatter source clusters with a wrapped modulo
 * grid. Wrapping meant distinct clusters could land on identical coordinates
 * (or within a node's width of each other), and a buried node cannot be
 * tapped. Placement moved to a golden-angle spiral: every slot has a unique
 * radius and direction, so no two source clusters can ever share a point, and
 * neighbouring slots keep close to a full spacing apart — the same geometry
 * sunflower seeds use to pack without touching.
 *
 * The flat spiral treated every cluster as a stranger, though: a source's hub
 * dot and its satellite dots landed wherever the flattened order put them, so
 * the dashed hub-to-satellite links criss-crossed the whole map. Grouped
 * input now lays each source out as a pod — the hub rides the spiral and its
 * satellites ring it — so a source reads as one tight family while every
 * spacing guarantee below still holds, across pods included.
 */

import { CLUSTER_SPACING_FLOOR } from "@workspace/venom-workspace-merge";

export type MapPoint = { x: number; y: number };

// ~137.508°. Irrational turns mean consecutive slots never line up in the
// same direction, and radius ∝ √slot keeps the point density constant.
const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));

// All values below are in logical map units; the knowledge screen renders
// them at 2 map pixels per unit on its 1000px canvas, and nodes are drawn up
// to 40 map px (20 units) wide.

// Radius the spiral aims to stay inside so nodes and their labels keep clear
// of the canvas edge. Beyond ~300 clusters the outermost ring drifts past it
// rather than ever re-packing points on top of each other.
const MAX_RADIUS = 200;
// Neighbour gap the spiral holds while the map has room: 60 map px between
// centres, so even two maximum-size nodes keep daylight between them.
const TARGET_SPACING = 30;
// Once the comfortable gap cannot fit every cluster inside MAX_RADIUS the
// spiral tightens, but never below this: 28 map px between neighbours.
const MIN_SPACING = 14;
// Skipping the innermost slots starts the first cluster about two spacings
// out, ringing the chat-derived clusters that huddle near the centre.
const FIRST_SLOT = 4;
// Preferred distance from clusters that are already on the map (the
// chat-derived ones own their stored positions; sources yield to them).
const AVOID_CLEARANCE = 26;
// Absolute floor against everything, honoured no matter how crowded the map
// gets. This is the map's spacing floor — 12 logical units, i.e. 24 map px at
// the knowledge screen's 2 px/unit scale — the minimum centre distance that
// keeps the smaller of two nodes tappable. It is defined once in
// @workspace/venom-workspace-merge (CLUSTER_SPACING_FLOOR) because chat-cluster
// placement and the stacked-position repair on both apps reuse the exact same
// floor when they pick spots for new topics or separate stored stacks.
const OVERLAP_FLOOR = CLUSTER_SPACING_FLOOR;
// Generous-clearance skips are budgeted so a pathological avoid list can only
// nudge the spiral, not chase it off the canvas. The floor above still holds
// once the budget is spent.
const AVOID_SKIP_BUDGET = 240;
// Satellites ring their hub at this distance: 40 map px between centres keeps
// daylight even against a maximum-size hub while the dashed link between them
// stays about one node long.
const POD_RING_RADIUS = 20;
// A ring admits as many satellites as keep this arc between neighbours — the
// overlap floor plus a margin that absorbs integer rounding. Overflow steps
// outward to the next ring, this much further from the hub.
const POD_RING_STEP = 14;

const nearestDistance = (point: MapPoint, others: readonly MapPoint[]) =>
  others.reduce(
    (min, other) => Math.min(min, Math.hypot(other.x - point.x, other.y - point.y)),
    Infinity,
  );

const ringCapacity = (ringRadius: number) =>
  Math.floor((2 * Math.PI * ringRadius) / POD_RING_STEP);

/** Distance from a hub to its outermost satellite ring; 0 without satellites. */
const podReach = (satelliteCount: number): number => {
  let remaining = satelliteCount;
  let ring = 0;
  let reach = 0;
  while (remaining > 0) {
    const ringRadius = POD_RING_RADIUS + ring * POD_RING_STEP;
    remaining -= ringCapacity(ringRadius);
    reach = ringRadius;
    ring += 1;
  }
  return reach;
};

/**
 * Satellite positions relative to their hub: evenly spread rings, filled
 * inside-out. Each ring starts at the pod's own spiral angle (turned by a
 * golden angle per ring), so pods never share an orientation and stacked
 * rings never line up radially. Ring geometry keeps satellites at least
 * POD_RING_STEP apart from each other and POD_RING_RADIUS from the hub, both
 * clear of OVERLAP_FLOOR even after integer rounding.
 */
const satelliteOffsets = (satelliteCount: number, orientation: number): MapPoint[] => {
  const offsets: MapPoint[] = [];
  let remaining = satelliteCount;
  let ring = 0;
  while (remaining > 0) {
    const ringRadius = POD_RING_RADIUS + ring * POD_RING_STEP;
    const onRing = Math.min(remaining, ringCapacity(ringRadius));
    const start = orientation + ring * GOLDEN_ANGLE;
    for (let index = 0; index < onRing; index += 1) {
      const angle = start + (index * 2 * Math.PI) / onRing;
      offsets.push({
        x: Math.cos(angle) * ringRadius,
        y: Math.sin(angle) * ringRadius,
      });
    }
    remaining -= onRing;
    ring += 1;
  }
  return offsets;
};

/**
 * Lays out connected-source clusters around the map centre, keeping clear of
 * the `avoid` points already on the map.
 *
 * `counts` is either a flat number of independent clusters (each takes its
 * own spiral slot, as before) or one entry per source giving that source's
 * cluster count. A grouped entry places the source's first cluster — its hub
 * — on the spiral and rings the remaining clusters around it as satellites,
 * so the source's dots stay together and their link lines stay short. The
 * returned points keep flattened source order, hub first; empty groups
 * contribute nothing.
 *
 * Guarantees, in order of priority:
 * - No two returned points sit within OVERLAP_FLOOR of each other or of an
 *   avoid point — within a pod, across pods, and against the chat-derived
 *   clusters alike — so a node can never bury another node.
 * - Placement is a pure function of its inputs: re-rendering the screen with
 *   the same workspace produces the same map, so nodes never jitter.
 * - A pod stays cohesive: satellites hold POD_RING_RADIUS from their hub and
 *   only step one ring further out when a ring fills, instead of drifting to
 *   wherever the spiral has room.
 * - Realistic workspaces stay inside MAX_RADIUS; absurd ones grow outward
 *   ring by ring instead of stacking.
 *
 * The walk always terminates: every rejected slot advances the spiral, and
 * each existing point can only reject the finitely many slots whose pod
 * falls inside its clearance disc before the radius leaves it behind for
 * good.
 */
export function spreadSourceClusters(
  counts: number | readonly number[],
  avoid: readonly MapPoint[] = [],
): MapPoint[] {
  const podSizes =
    typeof counts === "number"
      ? Array.from({ length: Math.max(0, Math.floor(counts)) }, () => 1)
      : counts
          .map(size => Math.max(0, Math.floor(size)))
          .filter(size => size > 0);
  const total = podSizes.reduce((sum, size) => sum + size, 0);
  const reach = podSizes.reduce((max, size) => Math.max(max, podReach(size - 1)), 0);

  // Aim hubs inside MAX_RADIUS minus the widest pod's reach so satellites
  // stay on the canvas too. Flat input has no reach, so its spacing — and
  // therefore its layout — is exactly what it always was.
  const spacing = Math.min(
    TARGET_SPACING,
    Math.max(MIN_SPACING, (MAX_RADIUS - reach) / Math.sqrt(total + FIRST_SLOT)),
  );

  const points: MapPoint[] = [];
  let slot = FIRST_SLOT;
  let avoidSkips = AVOID_SKIP_BUDGET;

  for (const size of podSizes) {
    const satelliteCount = size - 1;
    for (;;) {
      const radius = spacing * Math.sqrt(slot);
      const angle = slot * GOLDEN_ANGLE;
      const hub = {
        x: Math.round(Math.cos(angle) * radius),
        y: Math.round(Math.sin(angle) * radius),
      };
      slot += 1;

      // The whole pod stands or falls together: geometry already keeps its
      // own points apart, so only other pods and the avoid list can veto.
      const pod = [
        hub,
        ...satelliteOffsets(satelliteCount, angle).map(offset => ({
          x: Math.round(hub.x + offset.x),
          y: Math.round(hub.y + offset.y),
        })),
      ];

      // Spiral geometry keeps slots close to `spacing` apart on its own; the
      // explicit floor also covers the tightened spiral, integer rounding,
      // and satellites reaching toward a neighbouring pod.
      if (pod.some(point => nearestDistance(point, points) < OVERLAP_FLOOR)) {
        continue;
      }

      const avoidDistance = pod.reduce(
        (min, point) => Math.min(min, nearestDistance(point, avoid)),
        Infinity,
      );
      if (avoidDistance < OVERLAP_FLOOR) continue;
      if (avoidDistance < AVOID_CLEARANCE && avoidSkips > 0 && radius <= MAX_RADIUS) {
        avoidSkips -= 1;
        continue;
      }

      points.push(...pod);
      // Reserve the area the satellites consumed: skipping one slot per
      // satellite keeps slots-used proportional to nodes placed, which is
      // what lets the spacing formula hold realistic maps inside MAX_RADIUS.
      slot += satelliteCount;
      break;
    }
  }

  return points;
}
