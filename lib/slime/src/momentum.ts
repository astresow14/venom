/**
 * Camera momentum: the mass trailing a flung map.
 *
 * Panning or orbiting reprojects every node instantly, which used to carry
 * the goo along rigidly. This module gives each blob a little inertia: the
 * displayed mass chases the projected stream through a slightly underdamped
 * spring, so a fling makes it lag behind, stretch (nodes at different depths
 * move at different screen speeds, so their trails shear apart), swing just
 * past its resting pose, and settle. When the camera is still the input
 * passes through untouched.
 *
 * The module needs no camera input of its own: hosts already hand the
 * renderer per-frame projected positions, and the motion of that stream *is*
 * the camera's momentum. Anything that moves the map — drag, fling, orbit,
 * pinch, even a camera reset — earns the same organic follow-through.
 *
 * Everything here is display-time geometry in the host's own screen space —
 * no camera or layout maths of its own, no stored data. Trails are keyed by
 * node id and dropped the moment the id leaves the frame, so a concept that
 * returns (a released search filter, a restored project) appears in place
 * instead of flying in from where it once was.
 *
 * Under reduced motion (`frozen`) the mass moves rigidly with the map — the
 * pass-through *is* the state — and the trail memory is dropped so leaving
 * reduced motion later starts from rest instead of animating out of a stale
 * pose.
 *
 * This module is runtime-dependency-free (type-only imports) so the unit
 * tests can load it directly under Node's type stripping.
 */

import type { SlimeNode } from "./field";

/**
 * Spring stiffness as an angular frequency in radians per second. Higher
 * values make the mass catch up faster (less lag, quicker settle).
 */
export const SLIME_MOMENTUM_STIFFNESS = 11;

/**
 * Damping ratio. Below 1 the mass swings slightly past its resting pose
 * before settling — the follow-through that makes a fling read as weight
 * rather than latency.
 */
export const SLIME_MOMENTUM_DAMPING = 0.68;

/**
 * The trail never falls further behind than this many pixels, so a violent
 * fling (or a camera reset teleporting every node) stretches the mass
 * instead of tearing it off the map.
 */
export const SLIME_MOMENTUM_MAX_LAG = 120;

/** Long stalls (tab switches, hitches) integrate as one short step. */
const MAX_STEP_SECONDS = 0.1;

/** Below this offset (px) and speed (px/s) a trail snaps to rest exactly. */
const REST_OFFSET = 0.06;
const REST_SPEED = 1;

export type SlimeMomentumStepOptions = {
  /** Reduced motion: move rigidly with the map, adding no animation. */
  frozen?: boolean;
};

export type SlimeMomentum = {
  /**
   * Fold camera momentum into the frame's nodes. Returns the input array
   * untouched while every trail is at rest (still camera, reduced motion).
   */
  step(
    nodes: readonly SlimeNode[],
    nowSeconds: number,
    options?: SlimeMomentumStepOptions,
  ): readonly SlimeNode[];
};

type Trail = {
  x: number;
  y: number;
  depth: number;
  vx: number;
  vy: number;
  vd: number;
};

const clamp = (value: number, min: number, max: number) =>
  Math.min(Math.max(value, min), max);

export function createSlimeMomentum(): SlimeMomentum {
  const trails = new Map<string, Trail>();
  const presentIds = new Set<string>();
  const out: SlimeNode[] = [];

  let lastNow: number | null = null;

  return {
    step(nodes, nowSeconds, options) {
      if (options?.frozen === true) {
        // Rigid motion is the reduced-motion state change, applied instantly:
        // the map and the mass reproject together. Trails are forgotten so a
        // later return to full motion starts from rest.
        if (trails.size > 0) trails.clear();
        lastNow = nowSeconds;
        return nodes;
      }

      const dt =
        lastNow === null ? 0 : clamp(nowSeconds - lastNow, 0, MAX_STEP_SECONDS);
      lastNow = nowSeconds;

      presentIds.clear();
      for (const node of nodes) presentIds.add(node.id);
      // A concept that left the frame is forgotten immediately, so when it
      // comes back it appears in place instead of flying in.
      for (const id of trails.keys()) {
        if (!presentIds.has(id)) trails.delete(id);
      }

      const stiffness = SLIME_MOMENTUM_STIFFNESS;
      const pull = stiffness * stiffness;
      const drag = 2 * SLIME_MOMENTUM_DAMPING * stiffness;

      let moving = false;
      for (const node of nodes) {
        const trail = trails.get(node.id);
        if (!trail) {
          // First sighting: the node appears exactly where it is.
          trails.set(node.id, {
            x: node.x,
            y: node.y,
            depth: node.depth,
            vx: 0,
            vy: 0,
            vd: 0,
          });
          continue;
        }

        if (dt > 0) {
          // Semi-implicit Euler: accelerate toward the projected position,
          // then move. Stable under the clamped step.
          trail.vx += (-pull * (trail.x - node.x) - drag * trail.vx) * dt;
          trail.vy += (-pull * (trail.y - node.y) - drag * trail.vy) * dt;
          trail.vd += (-pull * (trail.depth - node.depth) - drag * trail.vd) * dt;
          trail.x += trail.vx * dt;
          trail.y += trail.vy * dt;
          trail.depth += trail.vd * dt;
        }

        // Cap how far the mass can fall behind, so it stretches rather than
        // tears when the whole map teleports.
        const offX = trail.x - node.x;
        const offY = trail.y - node.y;
        const planar = Math.hypot(offX, offY);
        if (planar > SLIME_MOMENTUM_MAX_LAG) {
          const scale = SLIME_MOMENTUM_MAX_LAG / planar;
          trail.x = node.x + offX * scale;
          trail.y = node.y + offY * scale;
        }
        const offDepth = trail.depth - node.depth;
        if (Math.abs(offDepth) > SLIME_MOMENTUM_MAX_LAG) {
          trail.depth =
            node.depth + Math.sign(offDepth) * SLIME_MOMENTUM_MAX_LAG;
        }

        const resting =
          Math.abs(trail.x - node.x) < REST_OFFSET &&
          Math.abs(trail.y - node.y) < REST_OFFSET &&
          Math.abs(trail.depth - node.depth) < REST_OFFSET &&
          Math.abs(trail.vx) < REST_SPEED &&
          Math.abs(trail.vy) < REST_SPEED &&
          Math.abs(trail.vd) < REST_SPEED;
        if (resting) {
          // Settle exactly so a still camera compares clean below.
          trail.x = node.x;
          trail.y = node.y;
          trail.depth = node.depth;
          trail.vx = 0;
          trail.vy = 0;
          trail.vd = 0;
        } else {
          moving = true;
        }
      }

      if (!moving) return nodes;

      out.length = 0;
      for (const node of nodes) {
        const trail = trails.get(node.id);
        if (
          !trail ||
          (trail.x === node.x &&
            trail.y === node.y &&
            trail.depth === node.depth)
        ) {
          out.push(node);
          continue;
        }
        out.push({ ...node, x: trail.x, y: trail.y, depth: trail.depth });
      }
      return out;
    },
  };
}
