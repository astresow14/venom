/**
 * Display-time density helpers: satellites and islands.
 *
 * A brain with five concepts should still read as a colony, not a diagram.
 * These helpers derive extra visual mass from the concepts' real substance
 * (their sources and mention counts) and pull related concepts into visual
 * islands — without ever inventing concepts. Everything here is presentation
 * geometry; stored ontology data and the real node/connection counts are
 * untouched.
 *
 * All placement is deterministic (hashed from stable ids), so satellites do
 * not jitter between renders and both surfaces lay out the same map the same
 * way.
 *
 * Runtime-dependency-free (type-only imports) so unit tests can load it
 * directly under Node's type stripping.
 */

import type { SlimeNode } from "./field";

/** A projected concept plus the substance its satellites are derived from. */
export type SatelliteParent = SlimeNode & {
  sourceCount: number;
  mentionCount: number;
};

const GOLDEN_ANGLE = 2.399963229728653;

/** Small deterministic hash → 0..1, stable across sessions and surfaces. */
function hash01(text: string, lane: number): number {
  let h = 2166136261 ^ Math.imul(lane + 1, 16777619);
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return ((h >>> 0) % 100000) / 100000;
}

/**
 * How many satellite clumps a concept earns. Derived from real substance —
 * attached sources weigh more than passing mentions — and capped so a heavily
 * cited concept becomes a dense cluster, not a swarm.
 */
export function satelliteCountFor(
  sourceCount: number,
  mentionCount: number,
): number {
  const sources = Number.isFinite(sourceCount) ? Math.max(0, sourceCount) : 0;
  const mentions = Number.isFinite(mentionCount)
    ? Math.max(0, mentionCount)
    : 0;
  const substance = sources + Math.floor(mentions / 3);
  return Math.max(2, Math.min(6, 2 + Math.round(substance)));
}

/**
 * Derive goo-only satellite micro-nodes around each projected concept.
 *
 * Satellites live in the same screen space as their parents (the host has
 * already projected them), hug the parent at 1.15–1.65× its radius, and sit
 * slightly off the parent's depth so the cluster reads as a 3D clump. They
 * carry derived ids (`<parent>#s<n>`) and are never counted, labelled, or
 * hit-tested — they only feed the distance field.
 */
export function deriveSatelliteNodes(
  parents: readonly SatelliteParent[],
): SlimeNode[] {
  const satellites: SlimeNode[] = [];

  for (const parent of parents) {
    if (
      !Number.isFinite(parent.x) ||
      !Number.isFinite(parent.y) ||
      !Number.isFinite(parent.radius) ||
      parent.radius <= 0
    ) {
      continue;
    }

    const count = satelliteCountFor(parent.sourceCount, parent.mentionCount);
    const baseAngle = hash01(parent.id, 0) * Math.PI * 2;

    for (let i = 0; i < count; i += 1) {
      const angle = baseAngle + i * GOLDEN_ANGLE;
      const dist =
        parent.radius * (1.15 + 0.5 * hash01(parent.id, i * 3 + 1));
      const radius = Math.max(
        3,
        parent.radius * (0.16 + 0.12 * hash01(parent.id, i * 3 + 2)),
      );
      const depth =
        parent.depth +
        (hash01(parent.id, i * 3 + 3) - 0.5) * parent.radius * 0.9;

      satellites.push({
        id: `${parent.id}#s${i}`,
        x: parent.x + Math.cos(angle) * dist,
        y: parent.y + Math.sin(angle) * dist,
        depth,
        radius,
      });
    }
  }

  return satellites;
}

export type IslandMember = {
  id: string;
  x: number;
  y: number;
  category?: string;
};

export type IslandLayoutOptions = {
  /** 0..1 — how far members are pulled toward their island's centroid. */
  tighten?: number;
  /** Extra push of island centroids away from the global centroid. */
  separate?: number;
};

/**
 * Pull concepts of the same category into visual islands.
 *
 * Members move toward their island centroid, islands push slightly apart,
 * and then the whole layout is rescaled so its overall footprint matches the
 * original — clustering must change the map's texture, not its extent, or
 * small screens would clip the outermost concepts.
 *
 * Applied to **world coordinates before projection** so goo, labels and hit
 * targets all move together. Returns adjusted copies; input order and every
 * other field are preserved.
 */
export function layoutIslands<T extends IslandMember>(
  items: readonly T[],
  options?: IslandLayoutOptions,
): T[] {
  if (items.length <= 1) return [...items];

  const tighten = clamp01(options?.tighten ?? 0.3);
  const separate = options?.separate ?? 0.36;

  // Global centroid and original footprint.
  let gx = 0;
  let gy = 0;
  for (const item of items) {
    gx += item.x;
    gy += item.y;
  }
  gx /= items.length;
  gy /= items.length;

  let originalReach = 0;
  for (const item of items) {
    const reach = Math.hypot(item.x - gx, item.y - gy);
    if (reach > originalReach) originalReach = reach;
  }

  // Island per category (uncategorised concepts share one island).
  const islands = new Map<string, { sumX: number; sumY: number; n: number }>();
  const keyFor = (item: IslandMember) =>
    item.category && item.category.length > 0 ? item.category : "misc";

  for (const item of items) {
    const key = keyFor(item);
    const island = islands.get(key);
    if (island) {
      island.sumX += item.x;
      island.sumY += item.y;
      island.n += 1;
    } else {
      islands.set(key, { sumX: item.x, sumY: item.y, n: 1 });
    }
  }

  if (islands.size === items.length) {
    // Every concept is its own island; nothing to cluster.
    return [...items];
  }

  const adjusted = items.map((item) => {
    const island = islands.get(keyFor(item))!;
    const cx = island.sumX / island.n;
    const cy = island.sumY / island.n;
    // Tighten toward the island, then push the island outward.
    const shiftX = (cx - gx) * separate;
    const shiftY = (cy - gy) * separate;
    return {
      ...item,
      x: cx + (item.x - cx) * (1 - tighten) + shiftX,
      y: cy + (item.y - cy) * (1 - tighten) + shiftY,
    };
  });

  // Restore the original footprint.
  let newReach = 0;
  for (const item of adjusted) {
    const reach = Math.hypot(item.x - gx, item.y - gy);
    if (reach > newReach) newReach = reach;
  }
  if (newReach > 1e-6 && originalReach > 1e-6) {
    const rescale = originalReach / newReach;
    for (const item of adjusted) {
      item.x = gx + (item.x - gx) * rescale;
      item.y = gy + (item.y - gy) * rescale;
    }
  }

  return adjusted;
}

function clamp01(value: number): number {
  return Math.min(Math.max(value, 0), 1);
}
