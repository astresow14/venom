/**
 * ResponseModeSwitch – the 3-position Talk / Verify / Debate control in the
 * chat composer. A radiogroup with arrow-key movement and an animated pill
 * that settles behind the active option, in the monochrome Venom dialect.
 */

import React, { useRef } from "react";
import { motion, useReducedMotion } from "framer-motion";
import { cn } from "@/lib/utils";
import { RESPONSE_MODES, type ResponseMode } from "@/lib/blend";

const MODE_LABELS: Record<ResponseMode, string> = {
  talk: "Talk",
  verify: "Verify",
  debate: "Debate",
};

const MODE_HINTS: Record<ResponseMode, string> = {
  talk: "One assistant answers",
  verify: "Voices check the answer in the background",
  debate: "Voices argue it out in the thread",
};

const SETTLE = [0.16, 1, 0.3, 1] as const;

export function ResponseModeSwitch({
  value,
  onChange,
  disabled,
  className,
}: {
  value: ResponseMode;
  onChange: (mode: ResponseMode) => void;
  disabled?: boolean;
  className?: string;
}) {
  const reduceMotion = useReducedMotion();
  const groupRef = useRef<HTMLDivElement>(null);

  const moveTo = (mode: ResponseMode) => {
    onChange(mode);
    // Keep focus with the checked radio, as arrow keys expect.
    requestAnimationFrame(() => {
      groupRef.current
        ?.querySelector<HTMLButtonElement>(`[data-mode="${mode}"]`)
        ?.focus();
    });
  };

  const handleKeyDown = (event: React.KeyboardEvent) => {
    const index = RESPONSE_MODES.indexOf(value);
    if (event.key === "ArrowRight" || event.key === "ArrowDown") {
      event.preventDefault();
      moveTo(RESPONSE_MODES[(index + 1) % RESPONSE_MODES.length]);
    } else if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
      event.preventDefault();
      moveTo(
        RESPONSE_MODES[
          (index - 1 + RESPONSE_MODES.length) % RESPONSE_MODES.length
        ],
      );
    } else if (event.key === "Home") {
      event.preventDefault();
      moveTo(RESPONSE_MODES[0]);
    } else if (event.key === "End") {
      event.preventDefault();
      moveTo(RESPONSE_MODES[RESPONSE_MODES.length - 1]);
    }
  };

  return (
    <div
      ref={groupRef}
      role="radiogroup"
      aria-label="Response mode"
      onKeyDown={handleKeyDown}
      className={cn(
        "flex items-center rounded-full border border-border/60 p-0.5",
        disabled && "opacity-50",
        className,
      )}
      data-testid="mode-switch"
    >
      {RESPONSE_MODES.map((mode) => {
        const checked = mode === value;
        return (
          <button
            key={mode}
            type="button"
            role="radio"
            aria-checked={checked}
            aria-label={`${MODE_LABELS[mode]}: ${MODE_HINTS[mode]}`}
            title={MODE_HINTS[mode]}
            tabIndex={checked ? 0 : -1}
            disabled={disabled}
            data-mode={mode}
            data-testid={`mode-option-${mode}`}
            onClick={() => onChange(mode)}
            className={cn(
              "relative rounded-full px-2.5 py-1 text-xs transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
              checked
                ? "text-background"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            {checked && (
              <motion.span
                layoutId="response-mode-pill"
                className="absolute inset-0 rounded-full bg-foreground"
                transition={
                  reduceMotion
                    ? { duration: 0 }
                    : { duration: 0.35, ease: SETTLE }
                }
                aria-hidden="true"
              />
            )}
            <span className="relative z-10">{MODE_LABELS[mode]}</span>
          </button>
        );
      })}
    </div>
  );
}
