import { useEffect, useRef, useState } from 'react';
import type { SyncStatus } from '@/lib/workspaceState';

// How long the workspace must sit unsynced after a failed cloud save before
// chat mentions it. Only a failure starts this clock — a normal save, however
// slow, never does — so an ordinary send cannot flash the notice, and a brief
// blip that recovers right away stays quiet. Mirrors the mobile chat notice
// (artifacts/venom/components/chat/ChatWorkspace.tsx).
const UNSYNCED_NOTICE_DELAY_MS = 4_000;

/**
 * The in-chat "saved on this device only" notice, keyed off the workspace
 * SyncStatus without flicker or false alarms:
 *
 * - Arm on failure only (`error` / `too_large`), behind a grace delay, so a
 *   healthy save — however slow — never surfaces it.
 * - Let the in-flight states sustain an armed or visible notice. On desktop a
 *   retry rides either the sidebar Retry button (straight to `syncing`) or
 *   the next edit's debounced flush (through `pending` first); neither may
 *   blink the notice off while the save carrying the unsynced work is still
 *   in flight.
 * - Clear only when the workspace leaves the unsynced set: a landed save
 *   (`synced`), or the offline/loading states whose messaging lives in the
 *   sidebar status instead.
 *
 * Returns the notice copy to render, or null while there is nothing to say.
 */
export function useUnsyncedNoticeText(syncStatus: SyncStatus): string | null {
  const [showNotice, setShowNotice] = useState(false);
  const noticeDueAtRef = useRef<number | null>(null);

  const saveFailed = syncStatus === 'error' || syncStatus === 'too_large';
  const workspaceUnsynced =
    saveFailed || syncStatus === 'syncing' || syncStatus === 'pending';

  useEffect(() => {
    if (!workspaceUnsynced) {
      noticeDueAtRef.current = null;
      setShowNotice(false);
      return;
    }
    if (saveFailed && noticeDueAtRef.current === null) {
      noticeDueAtRef.current = Date.now() + UNSYNCED_NOTICE_DELAY_MS;
    }
    // The deadline survives status flips: each re-run re-arms the timer with
    // whatever time remains, so retries can neither reset nor skip the delay.
    const dueAt = noticeDueAtRef.current;
    if (dueAt === null) return;
    const timer = window.setTimeout(
      () => setShowNotice(true),
      Math.max(0, dueAt - Date.now()),
    );
    return () => window.clearTimeout(timer);
  }, [saveFailed, workspaceUnsynced]);

  if (!showNotice) return null;
  return syncStatus === 'too_large'
    ? 'Latest messages are saved on this device only — this workspace is too large to sync right now.'
    : "Latest messages are saved on this device only — they'll sync when the connection returns.";
}
