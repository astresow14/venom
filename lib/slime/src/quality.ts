/**
 * Adaptive render quality for the slime surfaces.
 *
 * Raymarching cost scales with the *square* of the render scale, and the
 * fixed downscales both hosts shipped with were chosen by eye, not measured.
 * This controller watches the real frame cadence at runtime and moves the
 * scale to hold a smooth rate: sustained misses shed resolution (cost falls
 * quadratically), sustained headroom sharpens the surface back up.
 *
 * Measurement notes, learned the hard way:
 *
 * - rAF deltas are vsync-quantised. A 60 Hz display reports either ~16.7ms or
 *   ~33.3ms and nothing in between, so a percentile flips between "perfect"
 *   and "catastrophic" with no middle ground. A lightly trimmed mean instead
 *   turns the *miss rate* into a smooth signal: isolated GC spikes are
 *   trimmed away, sustained misses raise the average.
 * - Deltas beyond `stallMs` usually mean the tab was hidden or the loop was
 *   paused, so a single one is discarded — but a *run* of them is a real
 *   (terrible) cadence and must still drive the scale to its floor, or the
 *   slowest devices would be the only ones adaptation ignores.
 * - A scale that just failed is remembered as a ceiling so recovery does not
 *   bounce straight back into the miss; the ceiling is probed upward slowly
 *   once the loop is healthy at the capped scale, so a one-off stall cannot
 *   cap quality forever.
 *
 * Dependency-free (like field.ts) so unit tests can drive it with synthetic
 * clocks under both Node's type stripping and Metro.
 */

export type AdaptiveQualityOptions = {
  /** Scale to start from. Clamped into [minScale, maxScale]. */
  initialScale: number;
  /** Hard floor — blur we accept before giving up on further shedding. */
  minScale: number;
  /** Hard ceiling — typically the device pixel ratio, capped. */
  maxScale: number;
  /** Trimmed-mean frame time above which the scale is shed. Default 22ms. */
  degradeAboveMs?: number;
  /** Trimmed-mean frame time below which the scale sharpens. Default 17.5ms. */
  sharpenBelowMs?: number;
  /** Ideal frame time used to size degrade jumps. Default 16.7ms. */
  targetMs?: number;
  /** Accepted samples that fill a decision window. Default 24. */
  windowSize?: number;
  /** A full window still waits until it spans this long. Default 350ms. */
  minWindowMs?: number;
  /**
   * A slow device should not wait for a full window: decide as soon as the
   * window spans this long with at least `minSlowSamples` frames in it.
   * Default 600ms / 4 samples.
   */
  slowDecisionMs?: number;
  minSlowSamples?: number;
  /** Frames ignored after a scale change (resize hitches). Default 3. */
  settleFrames?: number;
  /** Multiplier applied per sharpening decision. Default 1.06. */
  sharpenStep?: number;
  /** Deltas beyond this are pauses, not frames — unless they repeat. Default 1500ms. */
  stallMs?: number;
};

export type AdaptiveQuality = {
  /** The scale the host should currently render at. */
  readonly scale: number;
  /**
   * Feed one frame timestamp (milliseconds, any monotonic-ish clock).
   * Returns true when `scale` just changed and the surface should be resized.
   */
  frame(timestampMs: number): boolean;
  /**
   * Forget the cadence after a pause the caller knows about (visibility
   * change, GL context restore) so the gap is not measured as a frame.
   */
  reset(): void;
};

/** Fraction of the slowest samples trimmed before averaging a window. */
const TRIM_FRACTION = 0.12;
/** Degrades are proportional to the overshoot but never worse than this. */
const MAX_DEGRADE_STEP = 0.4;
/** How fast a remembered failure ceiling is probed upward again. */
const CEILING_RELAX_STEP = 1.02;
/** Consecutive over-stall deltas that stop counting as pauses. */
const STALL_STREAK_LIMIT = 3;
/** Relative scale change below which a decision is not worth a resize. */
const MIN_CHANGE_RATIO = 0.01;

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

export function createAdaptiveQuality(
  options: AdaptiveQualityOptions,
): AdaptiveQuality {
  const minScale = Math.max(options.minScale, 0.01);
  const maxScale = Math.max(options.maxScale, minScale);
  const degradeAboveMs = options.degradeAboveMs ?? 22;
  const sharpenBelowMs = Math.min(
    options.sharpenBelowMs ?? 17.5,
    degradeAboveMs,
  );
  const targetMs = options.targetMs ?? 16.7;
  const windowSize = Math.max(options.windowSize ?? 24, 2);
  const minWindowMs = options.minWindowMs ?? 350;
  const slowDecisionMs = options.slowDecisionMs ?? 600;
  const minSlowSamples = Math.max(options.minSlowSamples ?? 4, 2);
  const settleFrames = options.settleFrames ?? 3;
  const sharpenStep = options.sharpenStep ?? 1.06;
  const stallMs = options.stallMs ?? 1500;

  let scale = clamp(options.initialScale, minScale, maxScale);
  /** Highest scale sharpening may currently reach. Lowered on every failure. */
  let ceiling = maxScale;
  let lastTimestamp: number | null = null;
  let settleRemaining = 0;
  let stallStreak = 0;
  let samples: number[] = [];
  let sampleSum = 0;

  const clearWindow = () => {
    samples = [];
    sampleSum = 0;
  };

  const decide = (): boolean => {
    const sorted = [...samples].sort((a, b) => a - b);
    clearWindow();

    // Trimmed mean: drop the slowest ~12% so one GC or paint hiccup cannot
    // masquerade as a sustained miss, then average what survives. Sustained
    // vsync misses survive the trim and raise the mean smoothly.
    const kept = Math.max(
      1,
      sorted.length - Math.ceil(sorted.length * TRIM_FRACTION),
    );
    let sum = 0;
    for (let i = 0; i < kept; i += 1) sum += sorted[i];
    const measured = sum / kept;

    let next = scale;

    if (measured > degradeAboveMs) {
      // This scale demonstrably misses. Remember it as the recovery ceiling,
      // then shed proportionally to the overshoot: cost is quadratic in the
      // scale, so sqrt(target/measured) aims straight at the budget.
      ceiling = Math.max(minScale, scale * 0.97);
      next = scale * Math.max(Math.sqrt(targetMs / measured), MAX_DEGRADE_STEP);
    } else if (measured < sharpenBelowMs && scale < maxScale) {
      if (scale >= ceiling * 0.999) {
        // Healthy for a whole window while parked at a scale that once
        // failed: conditions may have changed (sparser map, smaller window),
        // so probe past it gently instead of never recovering.
        ceiling = Math.min(maxScale, ceiling * CEILING_RELAX_STEP);
      }
      next = Math.min(scale * sharpenStep, ceiling);
    }

    next = clamp(next, minScale, maxScale);

    if (Math.abs(next - scale) <= scale * MIN_CHANGE_RATIO) return false;

    scale = next;
    settleRemaining = settleFrames;
    return true;
  };

  return {
    get scale() {
      return scale;
    },

    frame(timestampMs: number): boolean {
      if (lastTimestamp === null) {
        lastTimestamp = timestampMs;
        return false;
      }

      const delta = timestampMs - lastTimestamp;
      lastTimestamp = timestampMs;

      if (!Number.isFinite(delta) || delta <= 0) return false;

      if (settleRemaining > 0) {
        settleRemaining -= 1;
        return false;
      }

      if (delta > stallMs) {
        // One giant delta is a pause (hidden tab, suspended app) and says
        // nothing about render cost. A run of them is the actual frame rate:
        // count those, clamped, so catastrophic devices still hit the floor.
        stallStreak += 1;
        if (stallStreak < STALL_STREAK_LIMIT) return false;
        samples.push(stallMs);
        sampleSum += stallMs;
      } else {
        stallStreak = 0;
        samples.push(delta);
        sampleSum += delta;
      }

      const fullWindow =
        samples.length >= windowSize && sampleSum >= minWindowMs;
      const slowWindow =
        sampleSum >= slowDecisionMs && samples.length >= minSlowSamples;

      if (!fullWindow && !slowWindow) return false;

      return decide();
    },

    reset() {
      lastTimestamp = null;
      stallStreak = 0;
      clearWindow();
    },
  };
}
