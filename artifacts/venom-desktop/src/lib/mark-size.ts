/**
 * Class list for the Venom mark: a default 32px square that applies only
 * when the caller does not size the mark itself (h-*, w-*, or size-*).
 *
 * Entry-reachable code must not use the tailwind-merge `cn()` (see
 * src/lib/cx.ts), and an order-only join cannot let a caller's `h-5` beat a
 * base `h-8` — so the base size classes are withheld instead of merged away.
 * mark-size.test.mjs locks string-for-string parity with what the old
 * tailwind-merge cn("h-8 w-8", className) produced for realistic callers.
 */
export function markSizeClasses(className?: string): string {
  const tokens = className ? className.trim().split(/\s+/).filter(Boolean) : [];
  const sized = (axis: "h" | "w") =>
    tokens.some((t) => t.startsWith(`${axis}-`) || t.startsWith("size-"));
  const classes: string[] = [];
  if (!sized("h")) classes.push("h-8");
  if (!sized("w")) classes.push("w-8");
  classes.push(...tokens);
  return classes.join(" ");
}
