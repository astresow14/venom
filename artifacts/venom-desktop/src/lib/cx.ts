import { clsx, type ClassValue } from "clsx";

/**
 * Order-only class joiner for ENTRY-REACHABLE modules.
 *
 * Unlike `cn()` (src/lib/utils.ts) it does NOT resolve conflicting Tailwind
 * classes — later classes do not beat earlier ones that target the same CSS
 * property. Only use it where the joined classes can never conflict (verify
 * every call site, including what callers pass as `className`). In exchange
 * it keeps tailwind-merge (~102 KiB pre-minify, historically the single
 * largest module in the entry chunk) off the critical path.
 *
 * Rule of thumb: anything App.tsx reaches statically (app shell, toasts,
 * tooltips, route fallbacks, the brand mark) uses `cx`; lazy-loaded code
 * keeps `cn`. The bundle budget gate (scripts/check-bundle-budget.mjs) fails
 * any build where tailwind-merge creeps back into the entry chunk.
 */
export function cx(...inputs: ClassValue[]) {
  return clsx(inputs);
}
