/**
 * Bloom-in: newly absorbed knowledge grows out of the mass.
 *
 * Hosts pass the same node arrays they already hand the renderer every
 * frame, so an id that was never there before is a freshly absorbed
 * concept. Each newcomer earns a weight that eases from zero to one over a
 * few hundred milliseconds, and its radius is scaled by that weight: the
 * new mass visibly swells out of nothing instead of popping in at full
 * size. A newcomer's satellite clumps (`<parent>#s<n>`, see density.ts) are
 * new ids too, so they grow the same way — and they additionally surface
 * from just inside their core's skin and ease out to their resting offset,
 * so the whole family reads as one mass extruding rather than a core with
 * specks around it.
 *
 * The session's first *populated* frame is the baseline: whatever the map
 * opened with was absorbed some other time, so it appears settled instead
 * of blooming all at once. Empty frames before that (a host mounted while
 * its workspace was still hydrating) do not spend the exemption. First-seen
 * ids are remembered for the whole session, so a concept that merely left
 * and returned — a search narrowing and then clearing — does not bloom
 * again.
 *
 * Under reduced motion (`frozen`) a newcomer is simply there, full size,
 * the moment it arrives: the state change lands without the animation, and
 * any bloom already in flight completes instantly.
 *
 * This module is runtime-dependency-free (type-only imports) so the unit
 * tests can load it directly under Node's type stripping.
 */

import type { SlimeNode } from "./field";

/** Per-second ease rate: a newcomer reads full-size ~430 ms after arrival. */
const BLOOM_RATE = 7;

/** Past this a bloom is finished and the node passes through untouched. */
const SETTLED_WEIGHT = 0.995;

/**
 * Where a blooming satellite starts along the path to its resting offset,
 * as a fraction of that offset. Satellites rest at ~1.15–1.65× their core's
 * radius (density.ts), so starting at 0.35 places them just inside the
 * core's skin — the same place droplet pinch-offs emerge from (life.ts).
 */
const BLOOM_EMERGE = 0.35;

/**
 * Satellite ids are `<parent>#s<n>` (see density.ts). The bloom follows
 * that contract so a concept's derived clumps grow out of its core.
 */
const SATELLITE_MARKER = "#s";

export type SlimeBloomStepOptions = {
  /** Reduced motion: newcomers appear at full size, instantly. */
  frozen?: boolean;
};

export type SlimeBloom = {
  /**
   * Fold grow-in weights into the frame's nodes. Returns the input array
   * untouched when nothing is currently blooming.
   */
  step(
    nodes: readonly SlimeNode[],
    nowSeconds: number,
    options?: SlimeBloomStepOptions,
  ): readonly SlimeNode[];
};

const clamp = (value: number, min: number, max: number) =>
  Math.min(Math.max(value, min), max);

export function createSlimeBloom(): SlimeBloom {
  /** Every id this session has ever shown, at any size. */
  const seen = new Set<string>();
  /** Ids still growing: id → eased weight in (0..1). */
  const weights = new Map<string, number>();
  const neededCores = new Set<string>();
  const coresById = new Map<string, SlimeNode>();
  const out: SlimeNode[] = [];

  let lastNow: number | null = null;
  let baselined = false;

  return {
    step(nodes, nowSeconds, options) {
      const frozen = options?.frozen === true;
      const dt =
        frozen || lastNow === null ? 0 : clamp(nowSeconds - lastNow, 0, 0.1);
      lastNow = nowSeconds;

      // Blooms in flight advance before this frame's newcomers are admitted,
      // so a newcomer's very first frame samples weight zero: it starts from
      // nothing. Weights advance even for ids briefly absent (a search
      // flicker mid-bloom) — they settle invisibly and drop away.
      for (const [id, weight] of weights) {
        const next = frozen
          ? 1
          : weight + (1 - weight) * (1 - Math.exp(-dt * BLOOM_RATE));
        if (next >= SETTLED_WEIGHT) weights.delete(id);
        else weights.set(id, next);
      }

      // The first frame that actually carries nodes is the session baseline:
      // those concepts were already known, so none of them bloom. Earlier
      // empty frames (data still hydrating) do not count as that baseline.
      if (!baselined) {
        if (nodes.length === 0) return nodes;
        baselined = true;
        for (const node of nodes) seen.add(node.id);
        return nodes;
      }

      for (const node of nodes) {
        if (seen.has(node.id)) continue;
        seen.add(node.id);
        // Reduced motion: the newcomer is simply there, full size, now.
        if (!frozen) weights.set(node.id, 0);
      }

      if (weights.size === 0) return nodes;

      // Blooming satellites ease outward from their core's current position,
      // so collect the cores those satellites need from this frame.
      neededCores.clear();
      for (const id of weights.keys()) {
        const cut = id.lastIndexOf(SATELLITE_MARKER);
        if (cut > 0) neededCores.add(id.slice(0, cut));
      }
      coresById.clear();
      if (neededCores.size > 0) {
        for (const node of nodes) {
          if (neededCores.has(node.id)) coresById.set(node.id, node);
        }
      }

      out.length = 0;
      for (const node of nodes) {
        const weight = weights.get(node.id);
        if (weight === undefined) {
          out.push(node);
          continue;
        }

        const cut = node.id.lastIndexOf(SATELLITE_MARKER);
        const core = cut > 0 ? coresById.get(node.id.slice(0, cut)) : undefined;
        if (core) {
          // A blooming satellite surfaces from inside the core's skin and
          // eases out to its resting offset while it grows.
          const reach = BLOOM_EMERGE + (1 - BLOOM_EMERGE) * weight;
          out.push({
            ...node,
            x: core.x + (node.x - core.x) * reach,
            y: core.y + (node.y - core.y) * reach,
            depth: core.depth + (node.depth - core.depth) * reach,
            radius: node.radius * weight,
          });
        } else {
          out.push({ ...node, radius: node.radius * weight });
        }
      }

      return out;
    },
  };
}
