/**
 * BlendPad – the triangle model-blend control in the chat composer.
 *
 * The three participating voices sit at the corners; a draggable pin sets a
 * weight gradient over them. Centered reads as an even blend, pinning a
 * corner favors that voice without silencing the rest.
 *
 * Non-pointer path: the pin is a slider — arrow keys nudge it in 6% steps,
 * Home recenters, and 1/2/3 favor a corner — while the corner labels are
 * buttons that favor their voice directly. State is announced through
 * aria-valuetext and a polite live region.
 */

import React, { useMemo, useRef, useState } from "react";
import { motion, useReducedMotion } from "framer-motion";
import { cn } from "@/lib/utils";
import {
  BLEND_TRIANGLE,
  EVEN_BLEND,
  describeBlend,
  favoredBlend,
  nudgeWeights,
  pinToWeights,
  weightsToPin,
  type BlendWeights,
} from "@/lib/blend";

export type BlendPadCorner = {
  id: string;
  label: string;
  /** Shown under the label when the voice's model differs from its name. */
  sublabel?: string;
};

// Pad geometry: unit triangle mapped into a padded SVG viewport. The top and
// bottom insets leave room for a two-line corner caption (label + sublabel).
const PAD_W = 236;
const PAD_H = 210;
const INSET_X = 34;
const INSET_TOP = 36;
const INSET_BOTTOM = 40;

function toSvg(point: { x: number; y: number }) {
  return {
    x: INSET_X + point.x * (PAD_W - INSET_X * 2),
    y: INSET_TOP + point.y * (PAD_H - INSET_TOP - INSET_BOTTOM),
  };
}

function fromSvg(x: number, y: number) {
  return {
    x: (x - INSET_X) / (PAD_W - INSET_X * 2),
    y: (y - INSET_TOP) / (PAD_H - INSET_TOP - INSET_BOTTOM),
  };
}

const CORNER_SVG = BLEND_TRIANGLE.map(toSvg);
const TRIANGLE_PATH = `M ${CORNER_SVG[0].x} ${CORNER_SVG[0].y} L ${CORNER_SVG[1].x} ${CORNER_SVG[1].y} L ${CORNER_SVG[2].x} ${CORNER_SVG[2].y} Z`;
const KEY_STEP = 0.06;

export function BlendPad({
  corners,
  weights,
  onChange,
  onCommit,
  disabled,
}: {
  corners: [BlendPadCorner, BlendPadCorner, BlendPadCorner];
  weights: BlendWeights;
  /** Live updates while dragging; keep cheap. */
  onChange: (weights: BlendWeights) => void;
  /** Final value on release / keyboard change; persist here. */
  onCommit: (weights: BlendWeights) => void;
  disabled?: boolean;
}) {
  const reduceMotion = useReducedMotion();
  const svgRef = useRef<SVGSVGElement>(null);
  const [dragging, setDragging] = useState(false);

  const pin = toSvg(weightsToPin(weights));
  const names = corners.map((corner) => corner.label);
  const description = describeBlend(weights, names);
  const dominant = Math.round(Math.max(...weights) * 100);

  const weightsFromPointer = (event: React.PointerEvent): BlendWeights => {
    const svg = svgRef.current;
    if (!svg) return weights;
    const rect = svg.getBoundingClientRect();
    const x = ((event.clientX - rect.left) / rect.width) * PAD_W;
    const y = ((event.clientY - rect.top) / rect.height) * PAD_H;
    const unit = fromSvg(x, y);
    return pinToWeights(unit);
  };

  const handlePointerDown = (event: React.PointerEvent) => {
    if (disabled) return;
    event.preventDefault();
    (event.target as Element).setPointerCapture?.(event.pointerId);
    setDragging(true);
    onChange(weightsFromPointer(event));
  };

  const handlePointerMove = (event: React.PointerEvent) => {
    if (!dragging || disabled) return;
    onChange(weightsFromPointer(event));
  };

  const handlePointerUp = (event: React.PointerEvent) => {
    if (!dragging || disabled) return;
    setDragging(false);
    onCommit(weightsFromPointer(event));
  };

  const handleKeyDown = (event: React.KeyboardEvent) => {
    if (disabled) return;
    let next: BlendWeights | null = null;
    switch (event.key) {
      case "ArrowLeft":
        next = nudgeWeights(weights, -KEY_STEP, 0);
        break;
      case "ArrowRight":
        next = nudgeWeights(weights, KEY_STEP, 0);
        break;
      case "ArrowUp":
        next = nudgeWeights(weights, 0, -KEY_STEP);
        break;
      case "ArrowDown":
        next = nudgeWeights(weights, 0, KEY_STEP);
        break;
      case "Home":
        next = [...EVEN_BLEND] as BlendWeights;
        break;
      case "1":
        next = favoredBlend(0);
        break;
      case "2":
        next = favoredBlend(1);
        break;
      case "3":
        next = favoredBlend(2);
        break;
      default:
        return;
    }
    event.preventDefault();
    onCommit(next);
  };

  // Corner caption anchors around the triangle: the label line plus an
  // optional sublabel line (the model playing that voice) beneath it.
  const labelProps = useMemo(
    () => [
      {
        x: CORNER_SVG[0].x,
        y: CORNER_SVG[0].y - 22,
        subY: CORNER_SVG[0].y - 11,
        anchor: "middle" as const,
      },
      {
        x: CORNER_SVG[1].x,
        y: CORNER_SVG[1].y + 16,
        subY: CORNER_SVG[1].y + 27,
        anchor: "start" as const,
      },
      {
        x: CORNER_SVG[2].x,
        y: CORNER_SVG[2].y + 16,
        subY: CORNER_SVG[2].y + 27,
        anchor: "end" as const,
      },
    ],
    [],
  );

  return (
    <div className="flex flex-col items-center" data-testid="blend-pad">
      <svg
        ref={svgRef}
        viewBox={`0 0 ${PAD_W} ${PAD_H}`}
        className={cn(
          "w-[236px] max-w-full select-none",
          disabled ? "opacity-50" : "cursor-pointer",
        )}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
        aria-hidden="false"
        role="presentation"
      >
        <defs>
          {/* The favoring gradient: a soft monochrome glow that follows the pin. */}
          <radialGradient
            id="blend-favor"
            gradientUnits="userSpaceOnUse"
            cx={pin.x}
            cy={pin.y}
            r={PAD_W * 0.5}
          >
            <stop offset="0%" stopColor="currentColor" stopOpacity="0.22" />
            <stop offset="55%" stopColor="currentColor" stopOpacity="0.07" />
            <stop offset="100%" stopColor="currentColor" stopOpacity="0" />
          </radialGradient>
        </defs>

        <path
          d={TRIANGLE_PATH}
          className="fill-muted/40 stroke-border/80 text-foreground"
          strokeWidth="1"
        />
        <path d={TRIANGLE_PATH} fill="url(#blend-favor)" className="text-foreground" />

        {/* Corner dots grow with their weight. */}
        {CORNER_SVG.map((corner, index) => (
          <circle
            key={corners[index].id}
            cx={corner.x}
            cy={corner.y}
            r={3 + weights[index] * 5}
            className={cn(
              "text-foreground transition-[r] duration-200",
              weights[index] >= 0.45 ? "fill-current" : "fill-current opacity-40",
            )}
            data-testid={`blend-corner-${corners[index].id}`}
          />
        ))}

        {/* Corner labels double as favor buttons (see the button row below for
            the accessible path; these are visual). */}
        {labelProps.map((label, index) => (
          <g key={corners[index].id}>
            <text
              x={label.x}
              y={label.y}
              textAnchor={label.anchor}
              className="fill-muted-foreground text-[10px]"
            >
              {corners[index].label}
            </text>
            {corners[index].sublabel && (
              <text
                x={label.x}
                y={label.subY}
                textAnchor={label.anchor}
                className="fill-muted-foreground opacity-60 text-[9px]"
                data-testid={`blend-sublabel-${corners[index].id}`}
              >
                {corners[index].sublabel}
              </text>
            )}
          </g>
        ))}

        {/* The pin. */}
        <motion.g
          animate={reduceMotion || dragging ? undefined : { x: 0, y: 0 }}
          style={{ x: 0, y: 0 }}
        >
          <circle
            cx={pin.x}
            cy={pin.y}
            r="11"
            className="fill-foreground/10"
            style={{
              transition:
                reduceMotion || dragging ? undefined : "cx 0.2s, cy 0.2s",
            }}
          />
          <circle
            cx={pin.x}
            cy={pin.y}
            r="5.5"
            className="fill-foreground stroke-background"
            strokeWidth="1.5"
            style={{
              transition:
                reduceMotion || dragging ? undefined : "cx 0.2s, cy 0.2s",
            }}
          />
        </motion.g>
      </svg>

      {/* Keyboard/screen-reader control surface for the same value. */}
      <div
        role="slider"
        tabIndex={disabled ? -1 : 0}
        aria-label="Model blend"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={dominant}
        aria-valuetext={description}
        aria-disabled={disabled || undefined}
        onKeyDown={handleKeyDown}
        data-testid="blend-pin"
        className="mt-1 rounded-full px-2 py-0.5 text-center text-xs text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        {description}
      </div>
      <p className="sr-only" aria-live="polite">
        {description}
      </p>

      {/* Per-corner favor buttons: the non-pointer path. */}
      <div className="mt-1.5 flex flex-wrap items-center justify-center gap-1.5">
        {corners.map((corner, index) => (
          <button
            key={corner.id}
            type="button"
            disabled={disabled}
            onClick={() => onCommit(favoredBlend(index as 0 | 1 | 2))}
            className="rounded-full border border-border/60 px-2 py-0.5 text-[11px] text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            data-testid={`button-blend-favor-${corner.id}`}
          >
            Favor {corner.label}
            <span
              className="ml-1 text-foreground/70"
              data-testid={`blend-weight-${corner.id}`}
            >
              {Math.round(weights[index] * 100)}%
            </span>
          </button>
        ))}
        <button
          type="button"
          disabled={disabled}
          onClick={() => onCommit([...EVEN_BLEND] as BlendWeights)}
          className="rounded-full border border-border/60 px-2 py-0.5 text-[11px] text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          data-testid="button-blend-even"
        >
          Even blend
        </button>
      </div>
    </div>
  );
}
