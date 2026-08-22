/**
 * The landing page's ambient organism: where the symbiote rests while nobody
 * is signed in.
 *
 * Composition contract (design-language.md): monochrome ink, mass weighted
 * into the edges and corners of the stage, and the hero column — the VENOM
 * wordmark reveal and the composer — left on clean near-black. Five cores
 * seep in from the stage edges (a titan under the bottom-left corner, a
 * crown hanging off the top-right, clots hugging the left, right and bottom
 * rims), each trailing satellites that sway on slow bounded arcs, tied
 * together by strands that hug the frame instead of crossing it.
 *
 * Everything is a pure function of the stage size and the clock — no state,
 * no randomness — so reduced motion (time pinned to 0) is exactly the same
 * sculpture held still, and unit tests can assert on any instant of the
 * roam. Amplitudes are all bounded (drift sines, arc sways, breathing), so
 * the composition can never wander into the hero clearing.
 *
 * Runtime-dependency-free (type-only imports) so the unit tests can load it
 * directly under Node's type stripping.
 */

import type { SlimeEdge, SlimeNode } from "@workspace/slime";

const TAU = Math.PI * 2;

type CoreSpec = {
  id: string;
  /** Anchor, as fractions of the stage width/height (may exceed [0,1]). */
  ax: number;
  ay: number;
  /** Radius and depth as fractions of the stage's min dimension. */
  r: number;
  depth: number;
  /** Drift: two slow sines, amplitudes in min-dimension fractions. */
  dxA: number;
  dxF: number;
  dxP: number;
  dyA: number;
  dyF: number;
  dyP: number;
  /** Breathing: radius modulation. */
  bA: number;
  bF: number;
  bP: number;
};

type SatelliteSpec = {
  id: string;
  parent: string;
  /** Orbit distance as a fraction of the min dimension. */
  dist: number;
  /** Home angle (radians) and the bounded sway arc around it. */
  angle: number;
  sweep: number;
  swayF: number;
  swayP: number;
  r: number;
  depth: number;
  bA: number;
  bF: number;
  bP: number;
};

/**
 * Cores seep in from the stage rim. Anchors sit at or beyond the edges so
 * every mass reads as partly submerged — the organism is bigger than the
 * window it presses against.
 */
const CORES: readonly CoreSpec[] = [
  {
    id: "deep",
    ax: 0.07,
    ay: 1.02,
    r: 0.21,
    depth: 0.02,
    dxA: 0.015,
    dxF: 0.021,
    dxP: 0.0,
    dyA: 0.01,
    dyF: 0.017,
    dyP: 2.1,
    bA: 0.045,
    bF: 0.05,
    bP: 0.7,
  },
  {
    id: "crown",
    ax: 0.96,
    ay: 0.08,
    r: 0.115,
    depth: 0.05,
    dxA: 0.012,
    dxF: 0.026,
    dxP: 1.3,
    dyA: 0.014,
    dyF: 0.019,
    dyP: 4.2,
    bA: 0.05,
    bF: 0.065,
    bP: 2.9,
  },
  {
    id: "west",
    ax: -0.005,
    ay: 0.13,
    r: 0.075,
    depth: 0.035,
    dxA: 0.008,
    dxF: 0.024,
    dxP: 3.8,
    dyA: 0.014,
    dyF: 0.015,
    dyP: 1.1,
    bA: 0.06,
    bF: 0.045,
    bP: 4.4,
  },
  {
    id: "east",
    ax: 1.005,
    ay: 0.72,
    r: 0.1,
    depth: 0.03,
    dxA: 0.009,
    dxF: 0.018,
    dxP: 5.0,
    dyA: 0.016,
    dyF: 0.022,
    dyP: 0.4,
    bA: 0.055,
    bF: 0.06,
    bP: 1.8,
  },
  {
    id: "keel",
    ax: 0.62,
    ay: 1.06,
    r: 0.09,
    depth: 0.045,
    dxA: 0.02,
    dxF: 0.016,
    dxP: 2.6,
    dyA: 0.008,
    dyF: 0.02,
    dyP: 3.3,
    bA: 0.05,
    bF: 0.055,
    bP: 5.1,
  },
];

/**
 * Satellites sway on bounded arcs around their cores — never full orbits,
 * which could carry them across the hero clearing on some stage shapes.
 * Ids use the `#s` suffix convention satellites carry elsewhere.
 */
const SATELLITES: readonly SatelliteSpec[] = [
  {
    id: "deep#s0",
    parent: "deep",
    dist: 0.3,
    angle: -1.05,
    sweep: 0.55,
    swayF: 0.019,
    swayP: 0.0,
    r: 0.052,
    depth: 0.01,
    bA: 0.07,
    bF: 0.07,
    bP: 1.4,
  },
  {
    id: "deep#s1",
    parent: "deep",
    dist: 0.36,
    angle: -0.28,
    sweep: 0.4,
    swayF: 0.014,
    swayP: 2.2,
    r: 0.042,
    depth: 0.03,
    bA: 0.065,
    bF: 0.055,
    bP: 3.6,
  },
  {
    id: "crown#s0",
    parent: "crown",
    dist: 0.16,
    angle: 2.75,
    sweep: 0.3,
    swayF: 0.022,
    swayP: 4.1,
    r: 0.038,
    depth: 0.02,
    bA: 0.075,
    bF: 0.08,
    bP: 0.3,
  },
  {
    id: "crown#s1",
    parent: "crown",
    dist: 0.24,
    angle: 1.35,
    sweep: 0.35,
    swayF: 0.016,
    swayP: 5.3,
    r: 0.032,
    depth: 0.04,
    bA: 0.06,
    bF: 0.065,
    bP: 2.0,
  },
  {
    id: "west#s0",
    parent: "west",
    dist: 0.13,
    angle: 1.35,
    sweep: 0.5,
    swayF: 0.025,
    swayP: 1.7,
    r: 0.028,
    depth: 0.015,
    bA: 0.08,
    bF: 0.075,
    bP: 4.9,
  },
  {
    id: "east#s0",
    parent: "east",
    dist: 0.16,
    angle: -1.6,
    sweep: 0.45,
    swayF: 0.02,
    swayP: 3.0,
    r: 0.034,
    depth: 0.025,
    bA: 0.07,
    bF: 0.06,
    bP: 5.8,
  },
  {
    id: "keel#s0",
    parent: "keel",
    dist: 0.16,
    angle: -1.6,
    sweep: 0.5,
    swayF: 0.024,
    swayP: 0.9,
    r: 0.026,
    depth: 0.02,
    bA: 0.08,
    bF: 0.085,
    bP: 2.5,
  },
];

/**
 * Strands hug the stage rim: core to satellite, plus the long ties along
 * the left, right and bottom edges. Nothing crosses the hero clearing.
 */
export const LANDING_ORGANISM_EDGES: readonly SlimeEdge[] = [
  { sourceId: "deep", targetId: "deep#s0" },
  { sourceId: "deep", targetId: "deep#s1" },
  { sourceId: "deep", targetId: "west" },
  { sourceId: "west", targetId: "west#s0" },
  { sourceId: "crown", targetId: "crown#s0" },
  { sourceId: "crown", targetId: "crown#s1" },
  { sourceId: "crown", targetId: "east" },
  { sourceId: "east", targetId: "east#s0" },
  { sourceId: "keel", targetId: "keel#s0" },
  { sourceId: "deep#s1", targetId: "keel" },
  { sourceId: "east", targetId: "keel" },
];

/**
 * The hero clearing: an ellipse around the wordmark reveal and composer
 * that the organism must never enter. The stage cannot see the viewport
 * breakpoint (its own box is the pane, not the window), so narrow stages
 * union the two possible hero placements — top-anchored on desktop
 * layouts, centered on phones.
 *
 * This is the composition's testable contract, not a runtime clamp: the
 * arrangement above keeps out of it by construction, and the unit sweep
 * fails the build if a future tweak lets any node or strand wander in.
 */
export function landingClearZone(width: number, height: number) {
  const narrow = width < 700;
  const top = (narrow ? 0.19 : 0.14) * height;
  const bottom = (narrow ? 0.66 : 0.62) * height;
  return {
    cx: width * 0.5,
    cy: (top + bottom) / 2,
    rx: narrow ? width * 0.37 : Math.min(310, width * 0.4),
    ry: (bottom - top) / 2,
  };
}

export type LandingOrganismFrame = {
  nodes: readonly SlimeNode[];
  edges: readonly SlimeEdge[];
};

export type LandingOrganism = {
  /**
   * The organism at one instant, in CSS pixels of a width×height stage.
   * The returned arrays are reused between calls; read, pack, move on.
   */
  frame(width: number, height: number, timeSeconds: number): LandingOrganismFrame;
};

type MutableNode = { id: string; x: number; y: number; depth: number; radius: number };

export function createLandingOrganism(): LandingOrganism {
  // One mutable node per spec, reused every frame.
  const nodes: MutableNode[] = [
    ...CORES.map((core) => ({ id: core.id, x: 0, y: 0, depth: 0, radius: 1 })),
    ...SATELLITES.map((s) => ({ id: s.id, x: 0, y: 0, depth: 0, radius: 1 })),
  ];
  const coreIndex = new Map<string, number>();
  CORES.forEach((core, index) => coreIndex.set(core.id, index));

  const result: LandingOrganismFrame = { nodes, edges: LANDING_ORGANISM_EDGES };

  return {
    frame(width, height, timeSeconds) {
      const m = Math.min(width, height);
      const t = timeSeconds;

      for (let i = 0; i < CORES.length; i += 1) {
        const spec = CORES[i];
        const node = nodes[i];
        node.x =
          spec.ax * width + spec.dxA * m * Math.sin(TAU * spec.dxF * t + spec.dxP);
        node.y =
          spec.ay * height + spec.dyA * m * Math.sin(TAU * spec.dyF * t + spec.dyP);
        node.depth = spec.depth * m;
        node.radius =
          spec.r * m * (1 + spec.bA * Math.sin(TAU * spec.bF * t + spec.bP));
      }

      for (let i = 0; i < SATELLITES.length; i += 1) {
        const spec = SATELLITES[i];
        const node = nodes[CORES.length + i];
        const parent = nodes[coreIndex.get(spec.parent)!];
        const angle =
          spec.angle +
          spec.sweep * Math.sin(TAU * spec.swayF * t + spec.swayP);
        node.x = parent.x + spec.dist * m * Math.cos(angle);
        node.y = parent.y + spec.dist * m * Math.sin(angle);
        node.depth = spec.depth * m;
        node.radius =
          spec.r * m * (1 + spec.bA * Math.sin(TAU * spec.bF * t + spec.bP));
      }

      return result;
    },
  };
}
