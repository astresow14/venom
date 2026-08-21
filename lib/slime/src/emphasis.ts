/**
 * Touch emphasis: the mass reacting to the concept the user is on.
 *
 * Hosts pass the id the user has selected and the id under their pointer (or
 * finger). Each active concept earns a weight that eases toward its target
 * over a few hundred milliseconds, and that weight is folded into the
 * per-node radius the hosts already hand the renderer every frame: the core
 * and its satellite clumps swell, the satellites pull in against the core,
 * and directly linked neighbours lean toward the touched concept so the
 * strands between them visibly thicken.
 *
 * Everything here is display-time geometry in the host's own screen space —
 * no camera or layout maths, no stored data. Weights only ever attach to ids
 * that are actually present in the frame, so stale references (a deleted
 * concept, a hover that never got a leave event) decay harmlessly instead of
 * swelling a node when it reappears.
 *
 * Under reduced motion (`frozen`) the state change still happens — the mass
 * around the active concept is swollen — but it is applied instantly instead
 * of animating.
 *
 * This module is runtime-dependency-free (type-only imports) so the unit
 * tests can load it directly under Node's type stripping.
 */

import type { SlimeEdge, SlimeNode } from "./field";

/** Radius multiplier at full weight: an active concept swells by this much. */
export const SLIME_EMPHASIS_SWELL = 0.3;

/**
 * How far a satellite clump is pulled toward its core at full weight, as a
 * fraction of its offset. The clump visibly gathers around the concept the
 * user is on.
 */
export const SLIME_EMPHASIS_TIGHTEN = 0.16;

/** Target weight for the committed (clicked / tapped) concept. */
export const SELECTED_EMPHASIS_WEIGHT = 1;

/** Target weight for the concept merely under the pointer or finger. */
export const HOVERED_EMPHASIS_WEIGHT = 0.55;

/**
 * Fraction of an active concept's weight granted to its directly linked
 * neighbours. Both capsule endpoints thicken, so the strand toward the
 * active concept tightens instead of only its near end bulging.
 */
export const LINKED_EMPHASIS_SHARE = 0.35;

/** Per-second easing rates. Swelling in is quicker than letting go. */
const ATTACK_RATE = 8;
const RELEASE_RATE = 4;

/** Below this a released weight is dropped entirely. */
const REST_WEIGHT = 0.004;

/**
 * Satellite ids are `<parent>#s<n>` (see density.ts). The emphasis follows
 * that contract so a concept's derived clumps react with it.
 */
const SATELLITE_MARKER = "#s";

export type SlimeEmphasisTargets = {
  /** Concept the user has committed to (clicked / tapped), or null. */
  selectedId?: string | null;
  /** Concept under the pointer or finger right now, or null. */
  hoveredId?: string | null;
};

export type SlimeEmphasisStepOptions = {
  /** Reduced motion: apply the state change instantly, without easing. */
  frozen?: boolean;
};

export type SlimeEmphasis = {
  /**
   * Fold the current touch state into the frame's nodes. Returns the input
   * array untouched when nothing is (or is easing back from being) active.
   */
  step(
    nodes: readonly SlimeNode[],
    edges: readonly SlimeEdge[],
    targets: SlimeEmphasisTargets,
    nowSeconds: number,
    options?: SlimeEmphasisStepOptions,
  ): readonly SlimeNode[];
};

const clamp = (value: number, min: number, max: number) =>
  Math.min(Math.max(value, min), max);

export function createSlimeEmphasis(): SlimeEmphasis {
  const weights = new Map<string, number>();
  const frameTargets = new Map<string, number>();
  const presentIds = new Set<string>();
  const weightedCores = new Map<string, SlimeNode>();
  const out: SlimeNode[] = [];

  let lastNow: number | null = null;

  return {
    step(nodes, edges, targets, nowSeconds, options) {
      const frozen = options?.frozen === true;
      const dt =
        frozen || lastNow === null ? 0 : clamp(nowSeconds - lastNow, 0, 0.1);
      lastNow = nowSeconds;

      presentIds.clear();
      for (const node of nodes) presentIds.add(node.id);

      // Targets only attach to concepts actually on the map this frame, so a
      // stale selection or an un-left hover cannot swell a node later.
      frameTargets.clear();
      const raise = (id: string, weight: number) => {
        frameTargets.set(id, Math.max(frameTargets.get(id) ?? 0, weight));
      };
      const activate = (id: string | null | undefined, weight: number) => {
        if (!id || !presentIds.has(id)) return;
        raise(id, weight);
        for (const edge of edges) {
          const other: string | null =
            edge.sourceId === id
              ? edge.targetId
              : edge.targetId === id
                ? edge.sourceId
                : null;
          if (other === null || other === id || !presentIds.has(other)) {
            continue;
          }
          raise(other, weight * LINKED_EMPHASIS_SHARE);
        }
      };
      activate(targets.selectedId, SELECTED_EMPHASIS_WEIGHT);
      activate(targets.hoveredId, HOVERED_EMPHASIS_WEIGHT);

      for (const id of frameTargets.keys()) {
        if (!weights.has(id)) weights.set(id, 0);
      }

      for (const [id, weight] of weights) {
        const target = frameTargets.get(id) ?? 0;
        let next: number;
        if (frozen) {
          next = target;
        } else {
          const rate = target > weight ? ATTACK_RATE : RELEASE_RATE;
          next = weight + (target - weight) * (1 - Math.exp(-dt * rate));
        }
        if (target === 0 && next < REST_WEIGHT) weights.delete(id);
        else weights.set(id, next);
      }

      if (weights.size === 0) return nodes;

      weightedCores.clear();
      for (const node of nodes) {
        if (weights.has(node.id)) weightedCores.set(node.id, node);
      }

      out.length = 0;
      for (const node of nodes) {
        const cut = node.id.lastIndexOf(SATELLITE_MARKER);
        const familyId = cut > 0 ? node.id.slice(0, cut) : node.id;
        const weight = weights.get(familyId);
        if (weight === undefined || weight <= 0) {
          out.push(node);
          continue;
        }

        const swell = 1 + SLIME_EMPHASIS_SWELL * weight;
        const core = cut > 0 ? weightedCores.get(familyId) : undefined;
        if (core) {
          // A satellite hugs its swollen core a little tighter.
          const pull = SLIME_EMPHASIS_TIGHTEN * weight;
          out.push({
            ...node,
            x: node.x + (core.x - node.x) * pull,
            y: node.y + (core.y - node.y) * pull,
            depth: node.depth + (core.depth - node.depth) * pull,
            radius: node.radius * swell,
          });
        } else {
          out.push({ ...node, radius: node.radius * swell });
        }
      }

      return out;
    },
  };
}
