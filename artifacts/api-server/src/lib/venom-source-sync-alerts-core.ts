/**
 * venom-source-sync-alerts-core.ts
 *
 * Pure logic for scheduled source sync alerts: when a streak of failed
 * server-side sync attempts becomes worth interrupting someone over, and
 * when a stored alert is no longer telling the truth about the workspace.
 *
 * The worker records one failure per *attempt*, and failed attempts are paced
 * by FAILED_SYNC_RETRY_MS (an hour), so the threshold below means roughly
 * "this source has been failing for a few hours straight" — long enough to
 * skip transient blips, short enough that a lapsed GitHub connection is
 * surfaced the same day, not weeks later when the user next opens Settings.
 */
import type { StoredProjectSource } from "./venom-scheduled-source-sync";

/** Consecutive failed scheduled attempts before an alert surfaces. */
export const SOURCE_SYNC_ALERT_FAILURE_THRESHOLD = 3;

export const SOURCE_SYNC_ALERT_NAME_MAX_CHARS = 200;
/** Mirrors SOURCE_SCHEDULE_ERROR_MAX_CHARS on the source card itself. */
export const SOURCE_SYNC_ALERT_ERROR_MAX_CHARS = 300;

export type SourceSyncAlertProvider = "github" | "website";

/**
 * Only connector-backed GitHub sources and website sources can be re-synced
 * unattended, so only they can accumulate a meaningful failure streak. Any
 * other provider has no schedule to alert about.
 */
export function sourceSyncAlertProvider(
  provider: string,
): SourceSyncAlertProvider | null {
  return provider === "github" || provider === "website" ? provider : null;
}

export function normalizeSourceSyncAlertName(name: unknown): string {
  const trimmed = typeof name === "string" ? name.trim() : "";
  return trimmed.slice(0, SOURCE_SYNC_ALERT_NAME_MAX_CHARS) || "Untitled source";
}

export function normalizeSourceSyncAlertError(message: string): string {
  return (
    message.trim().slice(0, SOURCE_SYNC_ALERT_ERROR_MAX_CHARS) ||
    "Venom could not update this source."
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * An alert row is only honest while the workspace still shows the failure it
 * describes: the source exists, it still has a live daily/weekly schedule,
 * and its card still carries a lastError. Anything else — source removed,
 * schedule turned off, or a *client-side* refresh that succeeded and cleared
 * the error (the server worker never saw it to clear the row itself) — means
 * the alert must be dropped at read time instead of nagging about a fixed
 * problem.
 */
export function isSourceSyncAlertStillRelevant(
  sourceId: string,
  sources: StoredProjectSource[],
): boolean {
  const source = sources.find((candidate) => candidate.id === sourceId);
  if (!source) return false;

  const schedule = source.schedule;
  if (!isRecord(schedule)) return false;
  if (schedule.cadence !== "daily" && schedule.cadence !== "weekly") {
    return false;
  }

  return typeof schedule.lastError === "string" && schedule.lastError !== "";
}
