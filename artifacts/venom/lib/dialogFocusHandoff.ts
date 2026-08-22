/**
 * Cross-screen keyboard focus handoff.
 *
 * Some dialogs close by leaving their screen entirely (creating a project
 * pops back to the workspace). The dialog cannot focus anything on the
 * destination screen itself — it unmounts together with its own screen — so
 * it records the intended landing control here, and the destination screen
 * claims the request when it regains navigation focus.
 *
 * Deliberately module-scoped and single-slot: only one navigation-driven
 * handoff can be in flight at a time, and a claim consumes it. Requests
 * expire quickly so an unclaimed handoff (for example when the navigation
 * never happened) cannot yank focus during an unrelated visit later.
 */
export type FocusHandoffTarget = "project-switcher" | "build-run";

// The claim happens on the destination view's very next mount commit — the
// navigation that follows a request is programmatic, with no user action in
// between — so the TTL only guards a navigation that never happened. It must
// therefore outlast a CPU-starved commit (loaded CI containers stretch one
// past 3s) while staying far below human-scale "unrelated later visit" time.
const HANDOFF_TTL_MS = 10_000;

let pending: { target: FocusHandoffTarget; requestedAt: number } | null = null;

export function requestFocusHandoff(target: FocusHandoffTarget): void {
  pending = { target, requestedAt: Date.now() };
}

export function claimFocusHandoff(target: FocusHandoffTarget): boolean {
  if (!pending || pending.target !== target) return false;
  const fresh = Date.now() - pending.requestedAt <= HANDOFF_TTL_MS;
  pending = null;
  return fresh;
}
