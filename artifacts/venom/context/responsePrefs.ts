/**
 * Blend pad math and conversation response-mode helpers — pure, no React.
 *
 * The pad is a triangle with the three participating voices at its corners
 * and a draggable pin. The pin's barycentric coordinates ARE the blend
 * weights: centered means an even blend, near a corner means that voice is
 * strongly favored. These helpers convert between pin position (unit space)
 * and normalized weights, and validate the persisted per-conversation
 * preference block.
 */

import type {
  VenomConversation,
  VenomConversationBlend,
} from '@workspace/api-client-react';

export type BlendWeights = [number, number, number];
export type BlendPoint = { x: number; y: number };

/**
 * Triangle vertices in unit space, corner order = weight order:
 * corner 0 top-center, corner 1 bottom-left, corner 2 bottom-right.
 */
export const BLEND_TRIANGLE: [BlendPoint, BlendPoint, BlendPoint] = [
  { x: 0.5, y: 0 },
  { x: 0, y: 1 },
  { x: 1, y: 1 },
];

export const EVEN_BLEND: BlendWeights = [1 / 3, 1 / 3, 1 / 3];

/** Weights applied when a corner is explicitly favored (keyboard 1/2/3, corner tap). */
export function favoredBlend(corner: 0 | 1 | 2): BlendWeights {
  const weights: BlendWeights = [0.15, 0.15, 0.15];
  weights[corner] = 0.7;
  return weights;
}

export function normalizeWeights(weights: number[]): BlendWeights {
  const safe = [0, 1, 2].map((index) => {
    const value = weights[index];
    return Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0;
  }) as BlendWeights;
  const total = safe[0] + safe[1] + safe[2];
  if (!(total > 0)) return [...EVEN_BLEND] as BlendWeights;
  return [safe[0] / total, safe[1] / total, safe[2] / total];
}

/**
 * Barycentric weights for a point in unit space. Points outside the triangle
 * clamp to the nearest valid blend, so a drag past an edge stays sensible.
 */
export function pinToWeights(point: BlendPoint): BlendWeights {
  const [a, b, c] = BLEND_TRIANGLE;
  const denom = (b.y - c.y) * (a.x - c.x) + (c.x - b.x) * (a.y - c.y);
  const w0 = ((b.y - c.y) * (point.x - c.x) + (c.x - b.x) * (point.y - c.y)) / denom;
  const w1 = ((c.y - a.y) * (point.x - c.x) + (a.x - c.x) * (point.y - c.y)) / denom;
  const w2 = 1 - w0 - w1;
  return normalizeWeights([w0, w1, w2]);
}

/** The pin position for a set of weights: the weighted average of the corners. */
export function weightsToPin(weights: number[]): BlendPoint {
  const [w0, w1, w2] = normalizeWeights(weights);
  const [a, b, c] = BLEND_TRIANGLE;
  return {
    x: w0 * a.x + w1 * b.x + w2 * c.x,
    y: w0 * a.y + w1 * b.y + w2 * c.y,
  };
}

/** Nudge the blend by a unit-space delta (keyboard arrows). */
export function nudgeWeights(weights: number[], dx: number, dy: number): BlendWeights {
  const pin = weightsToPin(weights);
  return pinToWeights({
    x: Math.min(1, Math.max(0, pin.x + dx)),
    y: Math.min(1, Math.max(0, pin.y + dy)),
  });
}

/** Human-readable description of the blend, used for aria-valuetext. */
export function describeBlend(weights: number[], names: string[]): string {
  const normalized = normalizeWeights(weights);
  const spread = Math.max(...normalized) - Math.min(...normalized);
  if (spread < 0.08) {
    return `Even blend of ${names.join(', ')}`;
  }
  return normalized
    .map((weight, index) => `${names[index]} ${Math.round(weight * 100)}%`)
    .join(', ');
}

// ---------------------------------------------------------------------------
// Conversation preference block
// ---------------------------------------------------------------------------

export type ResponseMode = 'talk' | 'verify' | 'debate';
export const RESPONSE_MODES: ResponseMode[] = ['talk', 'verify', 'debate'];

export function isResponseMode(value: unknown): value is ResponseMode {
  return value === 'talk' || value === 'verify' || value === 'debate';
}

/**
 * Validate a persisted blend block: exactly three distinct non-empty corners
 * and three finite weights. Returns a normalized copy or undefined; junk from
 * older builds is dropped rather than synced onward.
 */
export function normalizeConversationBlend(
  value: unknown,
): VenomConversationBlend | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const raw = value as Partial<VenomConversationBlend>;
  if (!Array.isArray(raw.corners) || raw.corners.length !== 3) return undefined;
  if (!Array.isArray(raw.weights) || raw.weights.length !== 3) return undefined;
  const corners = raw.corners.map((corner) =>
    typeof corner === 'string' ? corner.slice(0, 64) : '',
  );
  if (corners.some((corner) => corner.length === 0)) return undefined;
  if (new Set(corners).size !== 3) return undefined;
  if (raw.weights.some((weight) => typeof weight !== 'number' || !Number.isFinite(weight))) {
    return undefined;
  }
  return { corners, weights: [...normalizeWeights(raw.weights)] };
}

type ResponsePrefs = Pick<VenomConversation, 'responseMode' | 'blend' | 'modeUpdatedAt'>;

/**
 * Normalize a conversation's response-mode preference block in place on
 * hydration: invalid modes and malformed blends disappear instead of syncing.
 */
export function normalizeConversationResponsePrefs<T extends ResponsePrefs>(
  conversation: T,
): T {
  const mode = isResponseMode(conversation.responseMode)
    ? conversation.responseMode
    : undefined;
  const blend = normalizeConversationBlend(conversation.blend);
  const modeUpdatedAt =
    typeof conversation.modeUpdatedAt === 'number' &&
    Number.isFinite(conversation.modeUpdatedAt) &&
    conversation.modeUpdatedAt >= 0
      ? Math.floor(conversation.modeUpdatedAt)
      : undefined;

  if (
    mode === conversation.responseMode &&
    blend === conversation.blend &&
    modeUpdatedAt === conversation.modeUpdatedAt
  ) {
    return conversation;
  }

  const next = { ...conversation };
  delete next.responseMode;
  delete next.blend;
  delete next.modeUpdatedAt;
  if (mode) next.responseMode = mode;
  if (blend) next.blend = blend;
  if ((mode || blend) && modeUpdatedAt !== undefined) next.modeUpdatedAt = modeUpdatedAt;
  return next;
}

/**
 * Merge the response-mode preference block of two synced copies of the same
 * conversation: the block whose `modeUpdatedAt` is newer wins whole — mode,
 * blend, and stamp move together so a device never sees a mixed state.
 * Missing stamps rank lowest; ties keep the device copy.
 */
export function mergeConversationResponsePrefs<T extends ResponsePrefs>(
  base: T,
  cloud: ResponsePrefs | undefined,
  device: ResponsePrefs | undefined,
): T {
  const stamp = (prefs: ResponsePrefs | undefined): number =>
    prefs && typeof prefs.modeUpdatedAt === 'number' ? prefs.modeUpdatedAt : -1;
  const winner = stamp(device) >= stamp(cloud) ? device : cloud;

  const next = { ...base };
  delete next.responseMode;
  delete next.blend;
  delete next.modeUpdatedAt;
  if (winner) {
    if (isResponseMode(winner.responseMode)) next.responseMode = winner.responseMode;
    const blend = normalizeConversationBlend(winner.blend);
    if (blend) next.blend = blend;
    if (
      (next.responseMode || next.blend) &&
      typeof winner.modeUpdatedAt === 'number' &&
      winner.modeUpdatedAt >= 0
    ) {
      next.modeUpdatedAt = winner.modeUpdatedAt;
    }
  }
  return next;
}
