/**
 * Deterministic knowledge-map placement for chat-derived clusters.
 *
 * A chat-learned topic gets its map spot exactly once, at creation, and the
 * coordinates are persisted into synced state. The legacy picker hashed the
 * label into one of 360 directions and a handful of radius steps, so two
 * labels could land on (or within a node's width of) the same point — and
 * because the stack was stored, it survived every render and every sync,
 * leaving one dot buried and untappable. These rules give both apps (and the
 * server's mirrored filing path in venom-ontology-core.ts) a single home for:
 *
 * - the map-wide spacing floor, shared with the connected-source layout
 *   (artifacts/venom/context/sourceClusterLayout.ts documents the map-pixel
 *   semantics on the knowledge screens),
 * - the legacy label hash, kept byte-identical so existing well-spread
 *   workspaces keep their familiar geometry,
 * - clearance-aware placement for newly created clusters, and
 * - the idempotent repair that separates already-stored stacks.
 *
 * Determinism is load-bearing. Placement and repair run independently on
 * every device, and their outputs are synced fields: if two engines could
 * disagree by even one unit, each sync would re-upload the disagreement
 * forever. Past the hash seed (computed once, on one device, then stored),
 * every rule below uses integer coordinates and exact squared-distance
 * comparisons — no trig, no square roots — so V8, JSC and Hermes cannot
 * drift by a ULP.
 */

export type ClusterMapPoint = { x: number; y: number };

/**
 * Minimum centre-to-centre distance, in logical map units, before the smaller
 * of two knowledge nodes stops being reliably tappable. The knowledge screens
 * render at 2 map px per logical unit, so 12 units = 24 map px. Chat-cluster
 * placement, the stacked-cluster repair, and the connected-source spiral
 * (sourceClusterLayout.ts) all honour this same floor.
 */
export const CLUSTER_SPACING_FLOOR = 12;

/**
 * Clearance a freshly placed or relocated cluster aims for: twice the floor,
 * so a spot chosen today still clears the floor after future neighbours are
 * placed against it with floor-level tolerance.
 */
export const CLUSTER_PLACEMENT_CLEARANCE = 24;

const FLOOR_SQUARED = CLUSTER_SPACING_FLOOR * CLUSTER_SPACING_FLOOR;
const CLEARANCE_SQUARED =
  CLUSTER_PLACEMENT_CLEARANCE * CLUSTER_PLACEMENT_CLEARANCE;

/** Probe lattice pitch: half the floor, fine enough to find nearby gaps. */
const PROBE_STEP = CLUSTER_SPACING_FLOOR / 2;
/** Rings that hold out for comfortable clearance before settling for less. */
const COMFORT_RING_LIMIT = 64;
/**
 * Hard search bound. Rings 65..256 reach radius 1536 and hold ~250k probe
 * points; even a workspace at the 1000-cluster schema cap can only blanket a
 * tiny fraction of them with floor-sized exclusion discs, so the floor phase
 * always finds a spot long before this bound in any storable workspace.
 */
const FLOOR_RING_LIMIT = 256;

/**
 * The legacy label hash, byte-identical to the copies it replaces (mobile
 * knowledgeState.ts/VenomContext.tsx, desktop workspaceState.ts, and the
 * server's venom-ontology-core.ts port keeps its own mirror). It remains the
 * seed for every new placement, so a label keeps gravitating to its familiar
 * region of the map — but it is no longer anyone's final answer, because two
 * labels can hash to the same point.
 */
export function hashPositionForLabel(
  label: string,
  index: number,
): ClusterMapPoint {
  const hash = [...label].reduce(
    (value, char) => (value * 31 + char.charCodeAt(0)) >>> 0,
    17,
  );
  const angle = (hash % 360) * (Math.PI / 180);
  const radius = 80 + ((hash >>> 8) % 4) * 42 + (index % 3) * 18;
  return {
    x: Math.round(Math.cos(angle) * radius),
    y: Math.round(Math.sin(angle) * radius),
  };
}

/** Exact squared distance to the nearest occupied point (Infinity if none). */
function minDistanceSquared(
  x: number,
  y: number,
  occupied: readonly ClusterMapPoint[],
): number {
  let min = Infinity;
  for (const point of occupied) {
    const dx = point.x - x;
    const dy = point.y - y;
    const squared = dx * dx + dy * dy;
    if (squared < min) min = squared;
  }
  return min;
}

/**
 * Picks the spot a cluster actually gets, given the seed it wants and the
 * points already on the map.
 *
 * The seed is kept whenever it clears the spacing floor — existing labels'
 * geometry survives untouched. Otherwise the picker walks integer square
 * rings around the seed (pitch = half the floor), starting each ring at a
 * seed-derived offset so collided pairs do not all resolve in the same
 * compass direction, and returns the first point with comfortable clearance.
 * If no comfortable spot exists near the seed it takes the best floor-clearing
 * point seen, then widens the search demanding only the floor. The final
 * fallback (unreachable in any storable workspace) is the most-clear point
 * probed, so the walk is total and pure: same inputs, same answer, on every
 * device and engine.
 */
export function placeClusterPosition(
  seed: ClusterMapPoint,
  occupied: readonly ClusterMapPoint[],
): ClusterMapPoint {
  const seedX = Math.round(seed.x);
  const seedY = Math.round(seed.y);
  const seedClearance = minDistanceSquared(seedX, seedY, occupied);
  if (seedClearance >= FLOOR_SQUARED) {
    return { x: seedX, y: seedY };
  }

  let bestPoint: ClusterMapPoint = { x: seedX, y: seedY };
  let bestSquared = seedClearance;
  for (let ring = 1; ring <= FLOOR_RING_LIMIT; ring += 1) {
    const half = ring * PROBE_STEP;
    const pointsPerSide = ring * 2;
    const perimeter = pointsPerSide * 4;
    const start =
      (((seedX * 31 + seedY) % perimeter) + perimeter) % perimeter;
    for (let step = 0; step < perimeter; step += 1) {
      const walk = (start + step) % perimeter;
      const side = Math.floor(walk / pointsPerSide);
      const along = (walk % pointsPerSide) * PROBE_STEP - half;
      const x =
        seedX +
        (side === 0 ? half : side === 1 ? -along : side === 2 ? -half : along);
      const y =
        seedY +
        (side === 0 ? along : side === 1 ? half : side === 2 ? -along : -half);
      const squared = minDistanceSquared(x, y, occupied);
      if (squared >= CLEARANCE_SQUARED) {
        return { x, y };
      }
      if (squared > bestSquared) {
        bestPoint = { x, y };
        bestSquared = squared;
      }
    }
    if (ring >= COMFORT_RING_LIMIT && bestSquared >= FLOOR_SQUARED) {
      // No comfortable spot in the near sweep; the best floor-clearing point
      // seen so far beats wandering further out for comfort's sake.
      return bestPoint;
    }
  }
  return bestPoint;
}

/**
 * Where a brand-new chat cluster goes: its legacy hash seed, adjusted until
 * it has clearance from every position already stored on the map. Callers
 * pass the live cluster list as `occupied`, so a batch of topics filed
 * together spreads out too.
 */
export function positionForNewCluster(
  label: string,
  index: number,
  occupied: readonly ClusterMapPoint[],
): ClusterMapPoint {
  return placeClusterPosition(hashPositionForLabel(label, index), occupied);
}

/**
 * Separates clusters whose stored positions already bury each other, without
 * moving anything that keeps the spacing floor.
 *
 * Both apps run this on every inbound snapshot (normalize) and on every
 * cross-device merge, so it must converge rather than churn:
 *
 * - Clusters are processed in ascending-id order — a stable, creation-shaped
 *   priority — so every device resolves the same stack the same way no
 *   matter what order the records arrived in.
 * - A cluster keeps its exact stored coordinates (float or not) unless it
 *   sits within the floor of an already-kept cluster; only violators move.
 * - A violator is re-placed from its own stored spot, steering clear of the
 *   stored spots of clusters not yet processed as well, so one move can
 *   never cascade into a chain of moves.
 * - `lastUpdatedAt` is never touched: separation is a presentation repair,
 *   not an edit, so it cannot win merges against real edits, resurrect
 *   tombstoned clusters, or make two devices fight over which copy is newer.
 *   Both sides of a sync compute the identical repaired coordinates instead.
 *
 * Running it twice is a no-op: the first pass leaves every pair at or above
 * the floor, so the second pass keeps everything. When nothing violates the
 * floor the input array is returned as-is (same reference), letting callers
 * and React state skip pointless work.
 */
export function separateStackedClusters<
  T extends { id: string; x: number; y: number },
>(clusters: T[]): T[] {
  if (clusters.length < 2) return clusters;

  const order = clusters
    .map((_, position) => position)
    .sort((left, right) => {
      const a = clusters[left].id;
      const b = clusters[right].id;
      return a < b ? -1 : a > b ? 1 : left - right;
    });

  const accepted: ClusterMapPoint[] = [];
  const replacements = new Map<number, ClusterMapPoint>();
  for (let rank = 0; rank < order.length; rank += 1) {
    const position = order[rank];
    const cluster = clusters[position];
    if (minDistanceSquared(cluster.x, cluster.y, accepted) >= FLOOR_SQUARED) {
      accepted.push({ x: cluster.x, y: cluster.y });
      continue;
    }
    const pendingStoredSpots: ClusterMapPoint[] = [];
    for (let later = rank + 1; later < order.length; later += 1) {
      const laterCluster = clusters[order[later]];
      pendingStoredSpots.push({ x: laterCluster.x, y: laterCluster.y });
    }
    const placed = placeClusterPosition(cluster, [
      ...accepted,
      ...pendingStoredSpots,
    ]);
    replacements.set(position, placed);
    accepted.push(placed);
  }

  if (replacements.size === 0) return clusters;
  return clusters.map((cluster, position) => {
    const placed = replacements.get(position);
    return placed ? { ...cluster, x: placed.x, y: placed.y } : cluster;
  });
}
