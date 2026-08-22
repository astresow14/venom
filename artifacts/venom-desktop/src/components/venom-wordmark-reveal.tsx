import { useEffect, useId } from "react";
import {
  animate,
  motion,
  useMotionValue,
  useReducedMotion,
} from "framer-motion";
import { cn } from "@/lib/utils";
import { VENOM_WORDMARK_PATH } from "@/components/venom-wordmark";

/**
 * One-time "tagging" reveal of the scrawled VENOM wordmark: the lettering is
 * swept in left to right behind an angled mask edge (a marker swipe), then the
 * two drip tails run down to finish the tag. Plays once on mount (~1s,
 * ease-out, no loop) and rests as the exact static mark afterwards.
 *
 * Brand-marks rules apply (design-language.md): the artwork is sourced from
 * VENOM_WORDMARK_PATH so there is no second copy of the scrawl, everything
 * stays `currentColor` monochrome, and the svg reserves its final size from
 * the first frame so nothing shifts. Under `prefers-reduced-motion` the
 * static mark renders immediately with no mask at all.
 *
 * This file must only be imported by surfaces that already load Motion
 * (currently the landing hero); the plain VenomWordmark stays dependency-free
 * for the entry-adjacent chunks.
 */

// Geometry in the wordmark's own viewBox units (x 0-1024, y 266-550).
const WORDMARK_VIEW_BOX = "0 266 1024 284";
// Everything above this line is lettering; below it live only the two drip
// tails (V drip x≈146-153 down to y≈514, M drip x≈901-911 down to y≈548).
const DRIP_LINE = 486;
// The sweep edge is skewed like a marker swipe: x' = x - tan(12°)·y, so the
// rect is offset and oversized to still cover x 0-1024 across the band.
const SWEEP_SKEW_DEG = -12;
const SWEEP_X = 40;
const SWEEP_FINAL_WIDTH = 1140;
const DRIP_FINAL_HEIGHT = 70;

const SWEEP_SECONDS = 0.8;
// Must stay late enough that the sweep has passed the M drip (x≈911) before
// the full-width drip band starts growing, or the M drip would lead its stem.
const DRIP_DELAY_SECONDS = 0.55;
const DRIP_SECONDS = 0.5;

type VenomWordmarkRevealProps = {
  className?: string;
  title?: string;
};

export function VenomWordmarkReveal({
  className,
  title = "Venom",
}: VenomWordmarkRevealProps) {
  const reduceMotion = useReducedMotion();
  // React's useId contains ":", which breaks `url(#…)` references.
  const rawId = useId();
  const maskId = `venom-tag-reveal-${rawId.replace(/[^a-zA-Z0-9_-]/g, "")}`;

  const sweepWidth = useMotionValue(0);
  const dripHeight = useMotionValue(0);

  useEffect(() => {
    if (reduceMotion) return;
    const sweep = animate(sweepWidth, SWEEP_FINAL_WIDTH, {
      duration: SWEEP_SECONDS,
      ease: [0.33, 1, 0.68, 1],
    });
    const drips = animate(dripHeight, DRIP_FINAL_HEIGHT, {
      delay: DRIP_DELAY_SECONDS,
      duration: DRIP_SECONDS,
      ease: "easeOut",
    });
    return () => {
      sweep.stop();
      drips.stop();
    };
  }, [reduceMotion, sweepWidth, dripHeight]);

  // Reduced motion: the finished tag, nothing else.
  if (reduceMotion) {
    return (
      <svg
        viewBox={WORDMARK_VIEW_BOX}
        className={cn("h-8 w-auto", className)}
        role="img"
        aria-label={title}
        focusable="false"
      >
        <path fill="currentColor" fillRule="evenodd" d={VENOM_WORDMARK_PATH} />
      </svg>
    );
  }

  return (
    <svg
      viewBox={WORDMARK_VIEW_BOX}
      className={cn("h-8 w-auto", className)}
      role="img"
      aria-label={title}
      focusable="false"
    >
      <mask
        id={maskId}
        maskUnits="userSpaceOnUse"
        x="-60"
        y="250"
        width="1160"
        height="310"
      >
        {/* Lettering band — an angled edge sweeping left to right. The skew
            sits on a plain <g>, since Motion manages `transform` on its own
            elements and must not fight the marker-swipe angle. */}
        <g transform={`skewX(${SWEEP_SKEW_DEG})`}>
          <motion.rect
            x={SWEEP_X}
            y={250}
            width={sweepWidth}
            height={DRIP_LINE - 250}
            fill="white"
          />
        </g>
        {/* Drip band — grows downward once the tag has landed. */}
        <motion.rect
          x={-60}
          y={DRIP_LINE}
          width={1160}
          height={dripHeight}
          fill="white"
        />
      </mask>
      <path
        fill="currentColor"
        fillRule="evenodd"
        d={VENOM_WORDMARK_PATH}
        mask={`url(#${maskId})`}
      />
    </svg>
  );
}
