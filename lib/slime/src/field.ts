/**
 * Uniform-array capacities shared by the shader and the packer.
 *
 * These live here, rather than beside the GLSL, so this module has no imports
 * at all. Node's type stripping cannot resolve extensionless TypeScript
 * specifiers, while Metro needs them, and keeping the packer dependency-free
 * lets the unit tests load it directly under both.
 *
 * The MAX_* constants are the ceilings of the richest tier. The shader is
 * compiled per device at whichever tier its fragment-uniform budget affords,
 * so a weak GPU gets a smaller field instead of a compile failure.
 */
export const MAX_BLOBS = 44;
export const MAX_LINKS = 36;
export const MAX_DROPS = 64;

/** How many vec4 slots of each uniform array a compiled shader offers. */
export type SlimeCapacity = {
  blobs: number;
  links: number;
  drops: number;
};

export const FULL_SLIME_CAPACITY: SlimeCapacity = {
  blobs: MAX_BLOBS,
  links: MAX_LINKS,
  drops: MAX_DROPS,
};

/**
 * Scalar and vec3 uniforms around the arrays (resolution, time, blend, alpha,
 * ink, light and the three counts). Each is budgeted as one vector because
 * GLSL packing rules let drivers charge a full vec4 per scalar.
 */
export const SLIME_UNIFORM_OVERHEAD = 10;

/**
 * Capacity tiers in descending order of richness. Every links slot costs two
 * vectors (both capsule endpoints travel as their own vec4 array).
 */
export const SLIME_CAPACITY_TIERS: readonly SlimeCapacity[] = [
  FULL_SLIME_CAPACITY, // 44 + 72 + 64 + 10 = 190 vectors
  { blobs: 28, links: 22, drops: 28 }, // 28 + 44 + 28 + 10 = 110 vectors
  { blobs: 16, links: 12, drops: 12 }, // 16 + 24 + 12 + 10 = 62 vectors
];

export function slimeUniformVectorsFor(capacity: SlimeCapacity): number {
  return (
    capacity.blobs +
    capacity.links * 2 +
    capacity.drops +
    SLIME_UNIFORM_OVERHEAD
  );
}

/**
 * Pick the richest tier the reported fragment-uniform budget can hold.
 *
 * A non-finite budget (a context that will not answer) gets the full tier —
 * the compile itself then decides, which matches the old behaviour. Returns
 * null when even the smallest tier cannot fit; callers fall back to their
 * non-WebGL presentation.
 */
export function capacityForBudget(
  availableVectors: number,
): SlimeCapacity | null {
  if (!Number.isFinite(availableVectors)) return SLIME_CAPACITY_TIERS[0];
  for (const tier of SLIME_CAPACITY_TIERS) {
    if (slimeUniformVectorsFor(tier) <= availableVectors) return tier;
  }
  return null;
}

/**
 * The tier for software rasterizers (SwiftShader, llvmpipe, the Windows basic
 * driver). Their per-pixel throughput is orders of magnitude below real GPUs,
 * so raster cost — not the uniform budget — is the binding constraint. This
 * matches roughly the field the original single-blob-per-concept shader drew,
 * which those rasterizers handled: concept cores plus a couple of satellites,
 * no ambient droplets. Cores pack ahead of satellites, so the cap sheds
 * decoration before it ever sheds a real concept.
 */
export const SOFTWARE_SLIME_CAPACITY: SlimeCapacity = {
  blobs: 8,
  links: 8,
  drops: 0,
};

/**
 * Whether a GL renderer string names a software rasterizer.
 *
 * An empty or unrecognised label is treated as hardware: false negatives cost
 * a slow experience, false positives silently strip the organism from capable
 * machines, and drivers that mask their identity are overwhelmingly real GPUs.
 */
export function isSoftwareGlRenderer(label: string): boolean {
  return /swiftshader|llvmpipe|softpipe|software rasterizer|microsoft basic render/i.test(
    label,
  );
}

/**
 * Resolve a human-readable tier name to its capacity, for test hooks that
 * pin the population instead of trusting device detection — visual capture
 * on software rasterizers, for instance, where a still frame of the full
 * organism is affordable even though live rendering is not.
 */
export function slimeCapacityForTierName(name: string): SlimeCapacity | null {
  switch (name) {
    case "full":
      return SLIME_CAPACITY_TIERS[0];
    case "medium":
      return SLIME_CAPACITY_TIERS[1];
    case "compact":
      return SLIME_CAPACITY_TIERS[2];
    case "software":
      return SOFTWARE_SLIME_CAPACITY;
    default:
      return null;
  }
}

/**
 * A node already projected into the host app's own screen space.
 *
 * Both artifacts keep their existing camera maths and hand us the result, so
 * the slime cannot drift away from the labels drawn on top of it.
 */
export type SlimeNode = {
  id: string;
  /** Horizontal position in CSS pixels, measured from the left of the stage. */
  x: number;
  /** Vertical position in CSS pixels, measured from the top of the stage. */
  y: number;
  /** Depth in CSS pixels. Positive is further from the viewer. */
  depth: number;
  /** Blob radius in CSS pixels. */
  radius: number;
};

export type SlimeEdge = {
  sourceId: string;
  targetId: string;
};

/**
 * A free-roaming micro-droplet, in the same CSS-pixel space as the nodes.
 * Droplets are display-time life only — they never correspond to stored
 * concepts, so they carry no id.
 */
export type SlimeDroplet = {
  x: number;
  y: number;
  depth: number;
  radius: number;
};

export type SlimeField = {
  capacity: SlimeCapacity;
  blobs: Float32Array;
  blobCount: number;
  linkA: Float32Array;
  linkB: Float32Array;
  linkCount: number;
  drops: Float32Array;
  dropCount: number;
};

export function createEmptyField(
  capacity: SlimeCapacity = FULL_SLIME_CAPACITY,
): SlimeField {
  return {
    capacity,
    blobs: new Float32Array(capacity.blobs * 4),
    blobCount: 0,
    linkA: new Float32Array(capacity.links * 4),
    linkB: new Float32Array(capacity.links * 4),
    linkCount: 0,
    drops: new Float32Array(capacity.drops * 4),
    dropCount: 0,
  };
}

/**
 * Pack nodes, edges and droplets into the flat uniform arrays the shader
 * expects.
 *
 * The shader has fixed-size uniform arrays, so when a map outgrows them we
 * keep the largest nodes (they carry the most visual weight) and only the
 * connections between nodes that survived. Reusing a caller-owned target
 * avoids allocating new arrays every animation frame.
 */
export function packSlimeField(
  nodes: readonly SlimeNode[],
  edges: readonly SlimeEdge[],
  scale = 1,
  target: SlimeField = createEmptyField(),
  droplets: readonly SlimeDroplet[] = [],
): SlimeField {
  // A broken scale would write garbage into every uniform, so treat it as an
  // empty frame rather than poisoning the field with infinities.
  if (!Number.isFinite(scale) || scale <= 0) {
    target.blobCount = 0;
    target.linkCount = 0;
    target.dropCount = 0;
    return target;
  }

  const { blobs: maxBlobs, links: maxLinks, drops: maxDrops } = target.capacity;

  const ranked = [...nodes]
    .filter(
      (node) =>
        Number.isFinite(node.x) &&
        Number.isFinite(node.y) &&
        Number.isFinite(node.depth) &&
        Number.isFinite(node.radius) &&
        node.radius > 0,
    )
    .sort((left, right) => right.radius - left.radius)
    .slice(0, maxBlobs);

  const indexById = new Map<string, number>();

  for (let index = 0; index < ranked.length; index += 1) {
    const node = ranked[index];
    indexById.set(node.id, index);
    const offset = index * 4;
    target.blobs[offset] = node.x * scale;
    target.blobs[offset + 1] = node.y * scale;
    target.blobs[offset + 2] = node.depth * scale;
    target.blobs[offset + 3] = node.radius * scale;
  }

  target.blobCount = ranked.length;

  let linkCount = 0;

  for (const edge of edges) {
    if (linkCount >= maxLinks) break;

    const from = indexById.get(edge.sourceId);
    const to = indexById.get(edge.targetId);
    if (from === undefined || to === undefined || from === to) continue;

    const fromOffset = from * 4;
    const toOffset = to * 4;
    const offset = linkCount * 4;

    target.linkA[offset] = target.blobs[fromOffset];
    target.linkA[offset + 1] = target.blobs[fromOffset + 1];
    target.linkA[offset + 2] = target.blobs[fromOffset + 2];
    target.linkA[offset + 3] = target.blobs[fromOffset + 3];

    target.linkB[offset] = target.blobs[toOffset];
    target.linkB[offset + 1] = target.blobs[toOffset + 1];
    target.linkB[offset + 2] = target.blobs[toOffset + 2];
    target.linkB[offset + 3] = target.blobs[toOffset + 3];

    linkCount += 1;
  }

  target.linkCount = linkCount;

  let dropCount = 0;

  for (const droplet of droplets) {
    if (dropCount >= maxDrops) break;
    if (
      !Number.isFinite(droplet.x) ||
      !Number.isFinite(droplet.y) ||
      !Number.isFinite(droplet.depth) ||
      !Number.isFinite(droplet.radius) ||
      droplet.radius <= 0
    ) {
      continue;
    }

    const offset = dropCount * 4;
    target.drops[offset] = droplet.x * scale;
    target.drops[offset + 1] = droplet.y * scale;
    target.drops[offset + 2] = droplet.depth * scale;
    target.drops[offset + 3] = droplet.radius * scale;
    dropCount += 1;
  }

  target.dropCount = dropCount;

  return target;
}
