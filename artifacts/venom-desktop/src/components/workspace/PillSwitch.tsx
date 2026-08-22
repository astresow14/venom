/**
 * PillSwitch – compact monochrome on/off control in the composer dialect:
 * an optional text label and a small sliding-thumb track inside a bordered
 * pill. Used for the composer's Debate switch and the Verify toggle in the
 * models & voices popup.
 */

import React from "react";
import { motion, useReducedMotion } from "framer-motion";
import { cn } from "@/lib/utils";

const SETTLE = [0.16, 1, 0.3, 1] as const;

export function PillSwitch({
  checked,
  onChange,
  disabled,
  label,
  ariaLabel,
  title,
  testId,
  className,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
  /** Visible text inside the pill (omit when surrounding copy names it). */
  label?: string;
  ariaLabel: string;
  title?: string;
  testId: string;
  className?: string;
}) {
  const reduceMotion = useReducedMotion();
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={ariaLabel}
      title={title}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cn(
        "group flex items-center gap-2 rounded-full border px-2.5 py-1 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        checked ? "border-foreground/70" : "border-border/60",
        disabled && "opacity-50",
        className,
      )}
      data-testid={testId}
    >
      {label && (
        <span
          className={cn(
            "text-xs font-medium transition-colors",
            checked
              ? "text-foreground"
              : "text-muted-foreground group-hover:text-foreground",
          )}
        >
          {label}
        </span>
      )}
      {/* Track + thumb. The thumb is positioned with top/left offsets only —
          framer-motion owns the transform, so a Tailwind translate here would
          be overwritten mid-animation. */}
      <span
        aria-hidden="true"
        className={cn(
          "relative h-3.5 w-6 shrink-0 rounded-full border transition-colors",
          checked
            ? "border-foreground bg-foreground"
            : "border-border bg-transparent",
        )}
      >
        <motion.span
          className={cn(
            "absolute left-[2px] top-[2px] h-2 w-2 rounded-full",
            checked ? "bg-background" : "bg-muted-foreground",
          )}
          initial={false}
          animate={{ x: checked ? 10 : 0 }}
          transition={
            reduceMotion ? { duration: 0 } : { duration: 0.3, ease: SETTLE }
          }
        />
      </span>
    </button>
  );
}
