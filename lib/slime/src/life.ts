/**
 * Droplet life simulation: the display-time metabolism of the slime.
 *
 * Maintains a fixed population of micro-droplets around the host-projected
 * anchor nodes: they orbit lazily, periodically pinch off a parent (which
 * briefly deflates), dart toward a neighbouring cluster or droplet with an
 * accelerating leap, and are absorbed on contact (the target briefly swells).
 * An ambient cohort orbits the field's own centroid, so the space between
 * clusters teems too.
 *
 * Everything is simulated **relative to the anchors the host passes in**:
 * a droplet's position is `parent position + offset in units of the parent's
 * radius`, and a leap interpolates between two anchor-relative endpoints. The
 * anchors are already projected into screen space by the host, so pan, zoom
 * and orbit carry every droplet along without the sim knowing a camera
 * exists.
 *
 * Positions are pure functions of internal state + current anchors — `step`
 * only advances that state when not frozen. Under reduced motion the host
 * passes `frozen: true` and gets a calm, settled, perfectly still field.
 *
 * This module is runtime-dependency-free (type-only imports) so the unit
 * tests can load it directly under Node's type stripping.
 */

import type { SlimeDroplet, SlimeNode } from "./field";

export type SlimeLifeStepOptions = {
  /** Hard cap on emitted droplets; pass the renderer capacity's drop count. */
  maxDroplets: number;
  /** Reduced motion: keep the population, stop the life. */
  frozen?: boolean;
};

export type SlimeLifeFrame = {
  /**
   * The anchors with their life pulses applied (deflate on pinch-off, swell
   * on absorption). Same order as the input anchors.
   */
  nodes: SlimeNode[];
  droplets: SlimeDroplet[];
};

export type SlimeLife = {
  step(
    anchors: readonly SlimeNode[],
    nowSeconds: number,
    options: SlimeLifeStepOptions,
  ): SlimeLifeFrame;
};

/** Deterministic PRNG so both surfaces evolve the same way for a given seed. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const ORBIT = 0;
const LEAP = 1;

/** Sentinel parent id for droplets that roam the whole field. */
const FIELD = "";

type Droplet = {
  id: number;
  ambient: boolean;
  parentId: string;
  angle: number;
  spin: number;
  baseDist: number;
  bob: number;
  bobSpeed: number;
  size: number;
  depthK: number;
  /** 0..1 grow-in after (re)spawn; doubles as the pinch-off emergence. */
  grow: number;
  age: number;
  mode: typeof ORBIT | typeof LEAP;
  targetAnchorId: string | null;
  targetDropletId: number;
  fromX: number;
  fromY: number;
  fromDepth: number;
  leapT: number;
  leapDuration: number;
  nextLeapAt: number;
  swell: number;
};

type AnchorState = {
  pulse: number;
  nextEmitAt: number;
};

type Anchor = SlimeNode;

const clamp = (value: number, min: number, max: number) =>
  Math.min(Math.max(value, min), max);

const easeOut = (value: number) => 1 - (1 - clamp(value, 0, 1)) ** 2;

export function createSlimeLife(options?: { seed?: number }): SlimeLife {
  const random = mulberry32(options?.seed ?? 0x51173);

  const droplets: Droplet[] = [];
  const anchorStates = new Map<string, AnchorState>();
  const outNodes: SlimeNode[] = [];
  const outDroplets: SlimeDroplet[] = [];

  let nextDropletId = 1;
  let lastNow: number | null = null;

  /** The synthetic anchor ambient droplets orbit: the field itself. */
  const fieldAnchor: Anchor = { id: FIELD, x: 0, y: 0, depth: 0, radius: 1 };

  function weightedAnchor(anchors: readonly Anchor[]): Anchor {
    let total = 0;
    for (const anchor of anchors) total += anchor.radius;
    let ticket = random() * total;
    for (const anchor of anchors) {
      ticket -= anchor.radius;
      if (ticket <= 0) return anchor;
    }
    return anchors[anchors.length - 1];
  }

  function spawnDroplet(
    anchors: readonly Anchor[],
    ambient: boolean,
    settled: boolean,
  ): Droplet {
    const parent = ambient ? fieldAnchor : weightedAnchor(anchors);
    return {
      id: nextDropletId++,
      ambient,
      parentId: parent.id,
      angle: random() * Math.PI * 2,
      spin: (random() - 0.5) * (ambient ? 0.24 : 0.55),
      baseDist: ambient ? 0.3 + random() * 0.85 : 1.3 + random() * 1.1,
      bob: random() * Math.PI * 2,
      bobSpeed: 0.55 + random() * 0.9,
      size: ambient ? 0.014 + random() * 0.02 : 0.1 + random() * 0.09,
      depthK: (random() - 0.5) * (ambient ? 0.45 : 0.6),
      grow: settled ? 1 : 0,
      age: settled ? 10 : 0,
      mode: ORBIT,
      targetAnchorId: null,
      targetDropletId: -1,
      fromX: 0,
      fromY: 0,
      fromDepth: 0,
      leapT: 0,
      leapDuration: 1,
      nextLeapAt: (ambient ? 7 : 3.5) + random() * (ambient ? 14 : 8),
      swell: 0,
    };
  }

  function respawn(
    droplet: Droplet,
    anchors: readonly Anchor[],
    preferredParentId: string | null,
  ) {
    const parent =
      !droplet.ambient && preferredParentId !== null
        ? (anchors.find((anchor) => anchor.id === preferredParentId) ??
          weightedAnchor(anchors))
        : droplet.ambient
          ? fieldAnchor
          : weightedAnchor(anchors);
    droplet.parentId = parent.id;
    droplet.angle = random() * Math.PI * 2;
    droplet.baseDist = droplet.ambient
      ? 0.3 + random() * 0.85
      : 1.3 + random() * 1.1;
    droplet.grow = 0;
    droplet.mode = ORBIT;
    droplet.targetAnchorId = null;
    droplet.targetDropletId = -1;
    droplet.leapT = 0;
    droplet.swell = 0;
  }

  function anchorOf(droplet: Droplet, anchorById: Map<string, Anchor>): Anchor {
    if (droplet.ambient) return fieldAnchor;
    return anchorById.get(droplet.parentId) ?? fieldAnchor;
  }

  function orbitPosition(
    droplet: Droplet,
    anchorById: Map<string, Anchor>,
    out: { x: number; y: number; depth: number },
  ) {
    const parent = anchorOf(droplet, anchorById);
    const wobble = 1 + 0.14 * Math.sin(droplet.bob);
    const grow = easeOut(droplet.grow);
    // New droplets surface from just inside the parent's skin, so a pinch-off
    // visibly squeezes out of the mass instead of popping into space.
    const emergeDist = droplet.ambient ? 0.12 : 0.55;
    const dist =
      (emergeDist + (droplet.baseDist * wobble - emergeDist) * grow) *
      parent.radius;
    out.x = parent.x + Math.cos(droplet.angle) * dist;
    out.y = parent.y + Math.sin(droplet.angle) * dist;
    out.depth = parent.depth + droplet.depthK * parent.radius;
  }

  const scratchA = { x: 0, y: 0, depth: 0 };
  const scratchB = { x: 0, y: 0, depth: 0 };

  function dropletRadius(
    droplet: Droplet,
    anchorById: Map<string, Anchor>,
  ): number {
    const parent = anchorOf(droplet, anchorById);
    const base = droplet.ambient
      ? clamp(droplet.size * parent.radius, 2.2, 6.5)
      : clamp(droplet.size * parent.radius, 2.2, parent.radius * 0.24);
    const grow = easeOut(droplet.grow);
    return base * grow * (1 + 0.45 * Math.min(droplet.swell, 1.2));
  }

  return {
    step(anchors, nowSeconds, stepOptions) {
      const frozen = stepOptions.frozen === true;
      const maxDroplets = Math.max(
        0,
        Math.floor(stepOptions.maxDroplets ?? 0),
      );

      const dt =
        frozen || lastNow === null
          ? 0
          : clamp(nowSeconds - lastNow, 0, 0.1);
      lastNow = nowSeconds;

      outNodes.length = 0;
      outDroplets.length = 0;

      if (anchors.length === 0 || maxDroplets <= 0) {
        for (const anchor of anchors) outNodes.push(anchor);
        return { nodes: outNodes, droplets: outDroplets };
      }

      // --- Field frame: centroid and spread carry the ambient cohort. ---
      let cx = 0;
      let cy = 0;
      let cDepth = 0;
      for (const anchor of anchors) {
        cx += anchor.x;
        cy += anchor.y;
        cDepth += anchor.depth;
      }
      cx /= anchors.length;
      cy /= anchors.length;
      cDepth /= anchors.length;
      let spread = 0;
      for (const anchor of anchors) {
        const reach =
          Math.hypot(anchor.x - cx, anchor.y - cy) + anchor.radius;
        if (reach > spread) spread = reach;
      }
      fieldAnchor.x = cx;
      fieldAnchor.y = cy;
      fieldAnchor.depth = cDepth;
      fieldAnchor.radius = Math.max(spread * 1.05, 90);

      const anchorById = new Map<string, Anchor>();
      for (const anchor of anchors) anchorById.set(anchor.id, anchor);

      // --- Anchor states: create for newcomers, drop the departed. ---
      for (const anchor of anchors) {
        if (!anchorStates.has(anchor.id)) {
          anchorStates.set(anchor.id, {
            pulse: 0,
            nextEmitAt: nowSeconds + 1.5 + random() * 6,
          });
        }
      }
      for (const id of [...anchorStates.keys()]) {
        if (!anchorById.has(id)) anchorStates.delete(id);
      }

      // --- Population reconciliation (runs even frozen, settled). ---
      const orbitTarget = Math.min(
        Math.floor(maxDroplets * 0.6),
        anchors.length * 2,
      );
      const ambientTarget = Math.min(
        maxDroplets - orbitTarget,
        8 + anchors.length * 2,
      );

      let orbitCount = 0;
      let ambientCount = 0;
      for (const droplet of droplets) {
        if (droplet.ambient) ambientCount += 1;
        else orbitCount += 1;
      }

      for (let i = droplets.length - 1; i >= 0; i -= 1) {
        const droplet = droplets[i];
        const over = droplet.ambient
          ? ambientCount > ambientTarget
          : orbitCount > orbitTarget;
        if (!over) continue;
        if (droplet.ambient) ambientCount -= 1;
        else orbitCount -= 1;
        droplets.splice(i, 1);
      }
      while (orbitCount < orbitTarget) {
        droplets.push(spawnDroplet(anchors, false, frozen));
        orbitCount += 1;
      }
      while (ambientCount < ambientTarget) {
        droplets.push(spawnDroplet(anchors, true, frozen));
        ambientCount += 1;
      }

      // Re-home droplets whose parent vanished (project switch, filtering).
      for (const droplet of droplets) {
        if (droplet.ambient) continue;
        if (!anchorById.has(droplet.parentId)) {
          respawn(droplet, anchors, null);
          if (frozen) {
            droplet.grow = 1;
            droplet.age = 10;
          }
        }
        if (
          droplet.mode === LEAP &&
          droplet.targetAnchorId !== null &&
          !anchorById.has(droplet.targetAnchorId)
        ) {
          // Target dissolved mid-flight: fall back to re-fusing with the parent.
          droplet.targetAnchorId = droplet.parentId;
        }
      }

      const dropletById = new Map<number, Droplet>();
      for (const droplet of droplets) dropletById.set(droplet.id, droplet);

      // --- Advance the life (skipped entirely under reduced motion). ---
      if (!frozen && dt > 0) {
        for (const state of anchorStates.values()) {
          state.pulse *= Math.exp(-dt * 2.8);
        }

        for (const droplet of droplets) {
          droplet.age += dt;
          droplet.bob += dt * droplet.bobSpeed;
          droplet.angle += dt * droplet.spin;
          droplet.grow = Math.min(1, droplet.grow + dt / 0.7);
          droplet.swell *= Math.exp(-dt * 3);
        }

        // Pinch-offs: a parent squeezes one of its settled droplets back out
        // and visibly deflates for a beat.
        for (const anchor of anchors) {
          const state = anchorStates.get(anchor.id);
          if (!state || nowSeconds < state.nextEmitAt) continue;
          const candidate = droplets.find(
            (droplet) =>
              !droplet.ambient &&
              droplet.parentId === anchor.id &&
              droplet.mode === ORBIT &&
              droplet.age > 1.5 &&
              droplet.grow >= 1,
          );
          if (candidate) {
            candidate.grow = 0;
            candidate.age = 0;
            candidate.angle = random() * Math.PI * 2;
            // A freshly pinched clump soon darts at a neighbour.
            candidate.nextLeapAt = 2.2 + random() * 3.5;
            state.pulse -= 0.09;
            state.nextEmitAt =
              nowSeconds +
              (2.6 + random() * 5.5) * clamp(46 / anchor.radius, 0.7, 2.6);
          } else {
            state.nextEmitAt = nowSeconds + 1.2;
          }
        }

        // Leap starts.
        for (const droplet of droplets) {
          if (droplet.mode !== ORBIT) continue;
          if (droplet.age < 2 || droplet.grow < 1) continue;
          if (droplet.age < droplet.nextLeapAt) continue;

          const parent = anchorOf(droplet, anchorById);
          orbitPosition(droplet, anchorById, scratchA);
          droplet.fromX = (scratchA.x - parent.x) / parent.radius;
          droplet.fromY = (scratchA.y - parent.y) / parent.radius;
          droplet.fromDepth = (scratchA.depth - parent.depth) / parent.radius;

          const roll = random();
          droplet.targetAnchorId = null;
          droplet.targetDropletId = -1;

          if (droplet.ambient) {
            droplet.targetAnchorId = weightedAnchor(anchors).id;
          } else if (roll < 0.5 && anchors.length > 1) {
            // Dart at one of the two nearest other clusters.
            let best: Anchor | null = null;
            let second: Anchor | null = null;
            let bestDist = Infinity;
            let secondDist = Infinity;
            for (const anchor of anchors) {
              if (anchor.id === droplet.parentId) continue;
              const dist = Math.hypot(anchor.x - parent.x, anchor.y - parent.y);
              if (dist < bestDist) {
                second = best;
                secondDist = bestDist;
                best = anchor;
                bestDist = dist;
              } else if (dist < secondDist) {
                second = anchor;
                secondDist = dist;
              }
            }
            const target = second && random() < 0.4 ? second : best;
            droplet.targetAnchorId = target?.id ?? droplet.parentId;
          } else if (roll < 0.72) {
            // Leap at another settled droplet and join it.
            const candidates = droplets.filter(
              (other) =>
                other !== droplet &&
                other.mode === ORBIT &&
                !other.ambient &&
                other.parentId !== droplet.parentId &&
                other.grow >= 1,
            );
            if (candidates.length > 0) {
              droplet.targetDropletId =
                candidates[Math.floor(random() * candidates.length)].id;
            } else {
              droplet.targetAnchorId = droplet.parentId;
            }
          } else {
            // Pinch back into the parent it came from.
            droplet.targetAnchorId = droplet.parentId;
          }

          droplet.mode = LEAP;
          droplet.leapT = 0;
          droplet.leapDuration = 0.6 + random() * 0.55;
        }

        // Leap progress and arrivals.
        for (const droplet of droplets) {
          if (droplet.mode !== LEAP) continue;
          droplet.leapT += dt / droplet.leapDuration;
          if (droplet.leapT < 1) continue;

          if (droplet.targetDropletId >= 0) {
            const target = dropletById.get(droplet.targetDropletId);
            if (target && target.mode === ORBIT) target.swell += 0.9;
          } else if (droplet.targetAnchorId !== null) {
            const state = anchorStates.get(droplet.targetAnchorId);
            if (state) state.pulse = Math.min(state.pulse + 0.13, 0.35);
          }

          // The traveller is absorbed; the population stays constant by
          // respawning it as a fresh pinch elsewhere.
          const preferred =
            droplet.targetAnchorId !== null && random() < 0.5
              ? droplet.targetAnchorId
              : null;
          respawn(droplet, anchors, preferred);
          droplet.nextLeapAt = droplet.age + 4 + random() * 9;
        }
      }

      // --- Emit the frame. ---
      for (const anchor of anchors) {
        const pulse = clamp(
          anchorStates.get(anchor.id)?.pulse ?? 0,
          -0.22,
          0.35,
        );
        outNodes.push(
          pulse === 0
            ? anchor
            : {
                id: anchor.id,
                x: anchor.x,
                y: anchor.y,
                depth: anchor.depth,
                radius: anchor.radius * (1 + pulse),
              },
        );
      }

      for (const droplet of droplets) {
        if (outDroplets.length >= maxDroplets) break;

        let x: number;
        let y: number;
        let depth: number;
        let radius = dropletRadius(droplet, anchorById);

        if (droplet.mode === LEAP && !frozen) {
          const parent = anchorOf(droplet, anchorById);
          scratchA.x = parent.x + droplet.fromX * parent.radius;
          scratchA.y = parent.y + droplet.fromY * parent.radius;
          scratchA.depth = parent.depth + droplet.fromDepth * parent.radius;

          const targetDroplet =
            droplet.targetDropletId >= 0
              ? dropletById.get(droplet.targetDropletId)
              : undefined;
          if (targetDroplet && targetDroplet.mode === ORBIT) {
            orbitPosition(targetDroplet, anchorById, scratchB);
          } else {
            const targetAnchor =
              (droplet.targetAnchorId !== null
                ? anchorById.get(droplet.targetAnchorId)
                : undefined) ?? anchorOf(droplet, anchorById);
            const towardX = scratchA.x - targetAnchor.x;
            const towardY = scratchA.y - targetAnchor.y;
            const length = Math.hypot(towardX, towardY) || 1;
            // Land just inside the target's skin so the merge reads as fusion.
            scratchB.x =
              targetAnchor.x + (towardX / length) * targetAnchor.radius * 0.5;
            scratchB.y =
              targetAnchor.y + (towardY / length) * targetAnchor.radius * 0.5;
            scratchB.depth = targetAnchor.depth;
          }

          const t = clamp(droplet.leapT, 0, 1);
          const ease = t ** 1.9;
          x = scratchA.x + (scratchB.x - scratchA.x) * ease;
          y = scratchA.y + (scratchB.y - scratchA.y) * ease;
          depth = scratchA.depth + (scratchB.depth - scratchA.depth) * ease;
          // Stretch slightly mid-flight, shrink into the target at the end.
          const flare = 1 + 0.3 * Math.sin(t * Math.PI);
          const merge = t > 0.82 ? 1 - ((t - 0.82) / 0.18) * 0.6 : 1;
          radius *= flare * merge;
        } else {
          orbitPosition(droplet, anchorById, scratchA);
          x = scratchA.x;
          y = scratchA.y;
          depth = scratchA.depth;
        }

        if (radius <= 0.4) continue;

        outDroplets.push({ x, y, depth, radius });
      }

      return { nodes: outNodes, droplets: outDroplets };
    },
  };
}
