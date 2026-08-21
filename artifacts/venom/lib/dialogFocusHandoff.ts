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
export type FocusHandoffTarget = "project-switcher";

const HANDOFF_TTL_MS = 3000;

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
