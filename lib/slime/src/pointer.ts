/**
 * Pointer attractor: the mass reaching for a free cursor or touch.
 *
 * Unlike emphasis (which reacts to *concepts* by id), the pointer is a free
 * 2D position in the host's own screen space with no node identity at all —
 * a cursor roaming a landing page, a finger resting on a touch surface. The
 * module keeps two pieces of eased state: a presence weight that attacks
 * while a pointer is supplied and releases after it leaves, and a smoothed
 * position that trails the raw pointer through a viscous lag, so the mass
 * chases the cursor and settles instead of snapping to it.
 *
 * `step` folds the attraction into the frame's nodes: blobs inside the
 * influence radius swell, lift toward the viewer, and lean toward the
 * smoothed position — with the strongest reach at mid distance, so a nearby
 * surface bulges out while a far one stays asleep. `reach` then warps the
 * frame's droplets: free droplets inside the field are drawn in, and a short
 * tendril of extra droplets bridges the gap from the nearest touched blob
 * toward the pointer, so the mass visibly extends a pseudopod to meet it.
 *
 * Everything is display-time geometry in the host's own screen space — no
 * stored data, no camera maths, and the input arrays are never mutated. When
 * no pointer has been seen, or the weight has fully released, both calls
 * return their input untouched.
 *
 * Under reduced motion (`frozen`) the attractor is inert by design: the
 * sculpted mass stays present but perfectly still, so it must not chase the
 * cursor at all. Frozen steps drop any eased state and pass the frame
 * through, and leaving reduced motion later starts from rest.
 *
 * This module is runtime-dependency-free (type-only imports) so the unit
 * tests can load it directly under Node's type stripping.
 */

import type { SlimeDroplet, SlimeNode } from "./field";

/** How far the pull is felt, in CSS pixels (plus the blob's own radius). */
export const SLIME_POINTER_RADIUS = 320;

/** Radius multiplier at full weight and zero gap: how hard a blob swells. */
export const SLIME_POINTER_SWELL = 0.34;

/**
 * Fraction of the falloff-scaled gap a blob leans toward the pointer. The
 * product of falloff and distance peaks at mid range, which is what makes
 * the mass *reach*: blobs under the cursor merely swell, blobs a hand-width
 * away stretch toward it.
 */
export const SLIME_POINTER_LEAN = 0.5;

/** Target weight while pressed (hover targets 1): a firmer, deeper pull. */
export const SLIME_POINTER_PRESSED_WEIGHT = 1.35;

/** How hard free droplets inside the field are drawn toward the pointer. */
export const SLIME_POINTER_DROPLET_PULL = 0.55;

/** Extra droplets forming the pseudopod between mass and pointer. */
export const SLIME_POINTER_TENDRIL_DROPS = 3;

/** The tendril only forms within this many pixels of the nearest surface. */
export const SLIME_POINTER_TENDRIL_REACH = 230;

/** Per-second easing rates. Reaching out is quicker than settling back. */
const ATTACK_RATE = 3.4;
const RELEASE_RATE = 1.5;

/** How fast the smoothed position chases the raw pointer (viscous lag). */
const FOLLOW_RATE = 5.5;

/** Long stalls (tab switches, hitches) integrate as one short step. */
const MAX_STEP_SECONDS = 0.1;

/** Below this a released weight is dropped and the frame passes through. */
const REST_WEIGHT = 0.004;

/** How far a touched blob is lifted toward the viewer plane (depth 0). */
const DEPTH_LIFT = 0.3;

/** A blob never leans further than this fraction of its own radius. */
const LEAN_CAP = 0.8;

/** No tendril when the pointer is already on (or inside) the surface. */
const TENDRIL_MIN_GAP = 6;

export type SlimePointerTarget = {
  /** Pointer position in the host's own CSS-pixel space. */
  x: number;
  y: number;
  /** True while the pointer is down or a finger is on the surface. */
  pressed?: boolean;
};

export type SlimePointerStepOptions = {
  /** Reduced motion: the attractor is inert — present mass, no chasing. */
  frozen?: boolean;
};

/** Read-only view of the eased state, for host telemetry and tests. */
export type SlimePointerSnapshot = {
  /** Eased presence weight; 0 at rest, 1 hovering, above 1 while pressed. */
  weight: number;
  /** Smoothed (trailing) pointer position last used. */
  x: number;
  y: number;
  /** Nodes inside the influence radius on the last step. */
  touched: number;
};

export type SlimePointer = {
  /**
   * Fold the pointer attraction into the frame's nodes. Returns the input
   * array untouched when no pointer has been seen, the weight has fully
   * released, or nothing is in reach.
   */
  step(
    nodes: readonly SlimeNode[],
    target: SlimePointerTarget | null,
    nowSeconds: number,
    options?: SlimePointerStepOptions,
  ): readonly SlimeNode[];
  /**
   * Draw the frame's droplets toward the pointer and extend a tendril from
   * the nearest touched blob. Call after `step` (and after the life sim) so
   * it works from this frame's eased state. Returns the input untouched at
   * rest. Tendril droplets are prepended, so hosts that reserve capacity for
   * them keep the pseudopod even when the colony fills the field.
   */
  reach(droplets: readonly SlimeDroplet[]): readonly SlimeDroplet[];
  snapshot(): SlimePointerSnapshot;
};

const clamp = (value: number, min: number, max: number) =>
  Math.min(Math.max(value, min), max);

export function createSlimePointer(): SlimePointer {
  const out: SlimeNode[] = [];
  const outDrops: SlimeDroplet[] = [];

  let weight = 0;
  let hasPosition = false;
  let px = 0;
  let py = 0;
  let touched = 0;
  let lastNow: number | null = null;

  // The nearest touched blob on the last step, as displayed (post swell and
  // lean), so the tendril roots on the surface the viewer actually sees.
  let nearestGap = Infinity;
  let nearestX = 0;
  let nearestY = 0;
  let nearestDepth = 0;
  let nearestRadius = 0;

  const rest = () => {
    weight = 0;
    hasPosition = false;
    touched = 0;
    nearestGap = Infinity;
    // Activating again later starts with a dt-0 frame, so the first step
    // samples the mass at rest instead of accruing a partial reaction.
    lastNow = null;
  };

  return {
    step(nodes, target, nowSeconds, options) {
      if (options?.frozen === true) {
        // Present but still: reduced motion must not chase the cursor, and
        // leaving it later starts from rest instead of mid-reaction.
        rest();
        return nodes;
      }

      const dt =
        lastNow === null
          ? 0
          : clamp(nowSeconds - lastNow, 0, MAX_STEP_SECONDS);
      lastNow = nowSeconds;

      const targetWeight =
        target === null ? 0 : target.pressed ? SLIME_POINTER_PRESSED_WEIGHT : 1;

      if (target !== null) {
        if (!hasPosition) {
          // First sighting: reach from where the pointer actually is, not
          // from wherever it was last seen minutes ago.
          px = target.x;
          py = target.y;
          hasPosition = true;
        } else if (dt > 0) {
          const follow = 1 - Math.exp(-dt * FOLLOW_RATE);
          px += (target.x - px) * follow;
          py += (target.y - py) * follow;
        }
      }
      // With no target the position freezes where it was: the mass relaxes
      // back around the last point of contact instead of snapping away.

      if (dt > 0) {
        const rate = targetWeight > weight ? ATTACK_RATE : RELEASE_RATE;
        weight += (targetWeight - weight) * (1 - Math.exp(-dt * rate));
      }
      if (targetWeight === 0 && weight < REST_WEIGHT) rest();

      touched = 0;
      nearestGap = Infinity;

      if (weight <= 0 || !hasPosition || nodes.length === 0) return nodes;

      out.length = 0;
      let any = false;

      for (const node of nodes) {
        const dx = px - node.x;
        const dy = py - node.y;
        const dist = Math.hypot(dx, dy);
        // Bigger blobs feel the pointer from further away.
        const span = SLIME_POINTER_RADIUS + node.radius;
        const q = dist / span;
        if (q >= 1) {
          out.push(node);
          continue;
        }

        const falloff = (1 - q) * (1 - q);
        const influence = falloff * weight;
        touched += 1;
        any = true;

        const lean = Math.min(
          SLIME_POINTER_LEAN * falloff * weight * dist,
          node.radius * LEAN_CAP,
        );
        const ux = dist > 1e-6 ? dx / dist : 0;
        const uy = dist > 1e-6 ? dy / dist : 0;

        const x = node.x + ux * lean;
        const y = node.y + uy * lean;
        const depth = node.depth * (1 - DEPTH_LIFT * Math.min(influence, 1));
        const radius = node.radius * (1 + SLIME_POINTER_SWELL * influence);
        out.push({ id: node.id, x, y, depth, radius });

        const gap = Math.hypot(px - x, py - y) - radius;
        if (gap < nearestGap) {
          nearestGap = gap;
          nearestX = x;
          nearestY = y;
          nearestDepth = depth;
          nearestRadius = radius;
        }
      }

      return any ? out : nodes;
    },

    reach(droplets) {
      if (weight <= 0 || !hasPosition) return droplets;

      outDrops.length = 0;
      let warped = false;

      // The pseudopod: a tapering chain from the nearest touched surface
      // toward the pointer, extending further as the weight settles in.
      if (
        nearestGap > TENDRIL_MIN_GAP &&
        nearestGap < SLIME_POINTER_TENDRIL_REACH
      ) {
        const reachFalloff = 1 - nearestGap / SLIME_POINTER_TENDRIL_REACH;
        const extend = Math.min(weight, 1) * reachFalloff;
        const ddx = px - nearestX;
        const ddy = py - nearestY;
        const d = Math.hypot(ddx, ddy);
        if (d > 1e-6 && extend > 0.04) {
          const ux = ddx / d;
          const uy = ddy / d;
          const rootX = nearestX + ux * nearestRadius;
          const rootY = nearestY + uy * nearestRadius;
          const base = clamp(nearestRadius * 0.22, 3.5, 16);
          for (let i = 1; i <= SLIME_POINTER_TENDRIL_DROPS; i += 1) {
            const t = (i / SLIME_POINTER_TENDRIL_DROPS) * extend;
            const taper =
              1 -
              0.55 *
                ((i - 1) / Math.max(SLIME_POINTER_TENDRIL_DROPS - 1, 1));
            outDrops.push({
              x: rootX + (px - rootX) * t,
              y: rootY + (py - rootY) * t,
              depth: nearestDepth * (1 - t),
              radius: base * taper * (0.35 + 0.65 * extend),
            });
          }
          warped = true;
        }
      }

      for (const drop of droplets) {
        const dx = px - drop.x;
        const dy = py - drop.y;
        const dist = Math.hypot(dx, dy);
        const q = dist / SLIME_POINTER_RADIUS;
        if (q >= 1 || dist < 1e-6) {
          outDrops.push(drop);
          continue;
        }
        const falloff = (1 - q) * (1 - q);
        const pull =
          Math.min(SLIME_POINTER_DROPLET_PULL * falloff * weight, 0.9) * dist;
        warped = true;
        outDrops.push({
          x: drop.x + (dx / dist) * pull,
          y: drop.y + (dy / dist) * pull,
          depth: drop.depth,
          radius: drop.radius * (1 + 0.25 * Math.min(falloff * weight, 1)),
        });
      }

      return warped ? outDrops : droplets;
    },

    snapshot() {
      return { weight, x: px, y: py, touched };
    },
  };
}
