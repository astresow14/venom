export const WORKSPACE_SYNC_RETRY_BASE_DELAY_MS = 1_000;
export const WORKSPACE_SYNC_RETRY_MAX_DELAY_MS = 30_000;

export function workspaceSyncRetryDelay(attempt: number) {
  const safeAttempt = Math.max(0, Math.floor(attempt));
  return Math.min(
    WORKSPACE_SYNC_RETRY_BASE_DELAY_MS * 2 ** safeAttempt,
    WORKSPACE_SYNC_RETRY_MAX_DELAY_MS,
  );
}