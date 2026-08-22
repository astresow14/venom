/**
 * In-process fan-out of company membership endings to signed-in devices.
 *
 * Removal, leaving, and company deletion must end access on an already-open
 * device immediately, not at the next directory poll: the Brain layer keeps
 * rendering fetched company concepts from memory, so a polling interval is a
 * real disclosure window. Every client holds one event-stream subscription;
 * when a membership ends the server pushes `membership-changed` to each
 * affected user and the client drops cached company state on the spot, then
 * re-fetches the directory for the authoritative view.
 *
 * The registry is in-process on purpose: the API server runs as a single
 * process, and a missed event only degrades to the existing 25s poll — the
 * push is the immediacy fence for open screens, while server routes remain
 * the authorization fence (a removed member 403s on every org request either
 * way).
 */
import type { Response } from "express";

export type VenomOrgMembershipEvent = {
  type: "membership-changed";
  orgId: string;
};

const subscribersByUser = new Map<string, Set<Response>>();

/** SSE comment heartbeat cadence; keeps proxies from reaping idle streams. */
export const ORG_EVENTS_HEARTBEAT_MS = 20_000;

export function subscribeOrgEvents(userId: string, res: Response): () => void {
  let set = subscribersByUser.get(userId);
  if (!set) {
    set = new Set();
    subscribersByUser.set(userId, set);
  }
  set.add(res);
  return () => {
    const current = subscribersByUser.get(userId);
    if (!current) return;
    current.delete(res);
    if (current.size === 0) subscribersByUser.delete(userId);
  };
}

/** Visible for tests: how many live streams a user currently holds. */
export function countOrgEventSubscribers(userId: string): number {
  return subscribersByUser.get(userId)?.size ?? 0;
}

/**
 * Tell every listed user's open devices that their relationship to `orgId`
 * changed. Fire-and-forget: a dead socket is skipped (its close handler
 * unsubscribes it) and users without a live stream simply learn from the
 * next poll or 403.
 */
export function publishOrgMembershipChanged(
  userIds: Iterable<string>,
  orgId: string,
): void {
  const event: VenomOrgMembershipEvent = { type: "membership-changed", orgId };
  const payload = `data: ${JSON.stringify(event)}\n\n`;
  for (const userId of new Set(userIds)) {
    const set = subscribersByUser.get(userId);
    if (!set) continue;
    for (const res of set) {
      try {
        res.write(payload);
      } catch {
        // Socket already gone; the request close handler cleans it up.
      }
    }
  }
}
