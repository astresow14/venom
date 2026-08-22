import { useEffect, useRef, useState } from "react";
import type { SyncStatus } from "@/context/VenomContext";

// How long the workspace must sit unsynced after a failed cloud save before
// any surface mentions it. Only a failure starts this clock — a normal save,
// however slow, never does — so an ordinary edit cannot flash an indicator,
// and a brief blip that recovers on the first retry stays quiet.
export const UNSYNCED_INDICATOR_DELAY_MS = 4_000;

/**
 * Whether a surface should currently report "this device is holding work the
 * cloud does not have": armed only after a failed save (error / too_large)
 * has sat unresolved past a grace delay, sustained through 'syncing' so it
 * cannot flicker off while a backoff retry is in flight, and cleared the
 * moment the workspace leaves the unsynced set (a landed save, or a stable
 * no-cloud state like signed-out 'offline').
 *
 * Every notice or icon that reports device-only work should key on this hook
 * rather than the raw status; the raw status cycles error → syncing → error
 * while retries back off, so status-keyed UI blinks several times in the
 * first seconds of an outage and alarms on one-second blips.
 */
export function useUnsyncedIndicator(syncStatus: SyncStatus): boolean {
  const [showUnsyncedIndicator, setShowUnsyncedIndicator] = useState(false);
  const dueAtRef = useRef<number | null>(null);
  const saveFailed = syncStatus === "error" || syncStatus === "too_large";
  const workspaceUnsynced = saveFailed || syncStatus === "syncing";

  useEffect(() => {
    if (!workspaceUnsynced) {
      dueAtRef.current = null;
      setShowUnsyncedIndicator(false);
      return;
    }
    if (saveFailed && dueAtRef.current === null) {
      dueAtRef.current = Date.now() + UNSYNCED_INDICATOR_DELAY_MS;
    }
    const dueAt = dueAtRef.current;
    if (dueAt === null) return;
    const timer = setTimeout(
      () => setShowUnsyncedIndicator(true),
      Math.max(0, dueAt - Date.now()),
    );
    return () => clearTimeout(timer);
  }, [saveFailed, workspaceUnsynced]);

  return showUnsyncedIndicator;
}
