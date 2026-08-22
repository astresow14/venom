import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

/**
 * Tailwind-aware class merge: later classes win over earlier ones that target
 * the same CSS property (`cn("p-6", "p-2")` → `"p-2"`). Many call sites rely
 * on this to override component base classes, so keep it for anything
 * lazy-loaded.
 *
 * tailwind-merge is ~102 KiB pre-minify — do NOT import this module from
 * entry-reachable code (anything App.tsx reaches statically). Those modules
 * use the order-only `cx()` from src/lib/cx.ts instead; the bundle budget
 * gate fails any build where tailwind-merge reaches the entry chunk.
 */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}
