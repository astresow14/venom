/**
 * Durable record of the last GitHub sync attempt.
 *
 * The post-merge hook deliberately never fails setup over a sync problem, so the
 * only trace of a failed or skipped sync used to be one line in a merge log
 * nobody re-reads. Every attempt is recorded here instead, and
 * `pnpm run check:github-sync` reports it alongside the live drift.
 *
 * The file lives under `.local/`, which is git-ignored, so recording an attempt
 * can never itself create the drift it is meant to detect.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export type SyncOutcome = "success" | "failed" | "skipped";

export interface SyncAttempt {
  /** ISO timestamp of the attempt. */
  at: string;
  outcome: SyncOutcome;
  repo: string;
  branch: string;
  /** Local HEAD at the time of the attempt, when it could be read. */
  headSha: string | null;
  /** One-line summary: what was synced, or why it failed or was skipped. */
  detail: string | null;
  pullRequest: { number: number; url: string } | null;
}

export interface SyncState {
  version: 1;
  lastAttempt: SyncAttempt | null;
  lastSuccess: SyncAttempt | null;
}

export const EMPTY_STATE: SyncState = { version: 1, lastAttempt: null, lastSuccess: null };

const DEFAULT_STATE_PATH = join(".local", "state", "venom", "github-sync.json");

/** Where the marker lives; `VENOM_GITHUB_SYNC_STATE` overrides it (used by tests). */
export function stateFilePath(repoRoot: string): string {
  const override = process.env.VENOM_GITHUB_SYNC_STATE?.trim();
  return override ? override : join(repoRoot, DEFAULT_STATE_PATH);
}

function isAttempt(value: unknown): value is SyncAttempt {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const candidate = value as Partial<SyncAttempt>;
  return (
    typeof candidate.at === "string" &&
    (candidate.outcome === "success" ||
      candidate.outcome === "failed" ||
      candidate.outcome === "skipped")
  );
}

/** Read the marker. A missing or corrupt file reads as "nothing recorded yet". */
export function readSyncState(path: string): SyncState {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return { ...EMPTY_STATE };
  }

  try {
    const parsed = JSON.parse(raw) as Partial<SyncState>;
    return {
      version: 1,
      lastAttempt: isAttempt(parsed.lastAttempt) ? parsed.lastAttempt : null,
      lastSuccess: isAttempt(parsed.lastSuccess) ? parsed.lastSuccess : null,
    };
  } catch {
    return { ...EMPTY_STATE };
  }
}

export function nextState(previous: SyncState, attempt: SyncAttempt): SyncState {
  return {
    version: 1,
    lastAttempt: attempt,
    lastSuccess: attempt.outcome === "success" ? attempt : previous.lastSuccess,
  };
}

/**
 * Record one attempt. Never throws: a sync must not fail because the marker
 * could not be written, and the check reports a missing marker on its own.
 */
export function recordSyncAttempt(path: string, attempt: SyncAttempt): void {
  try {
    const state = nextState(readSyncState(path), attempt);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`Could not record the sync attempt (${message}).`);
  }
}

/** "3 minutes ago", "6 days ago" — plain language for a recorded timestamp. */
export function describeAge(iso: string, now: Date = new Date()): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) {
    return "at an unknown time";
  }

  const seconds = Math.max(0, Math.round((now.getTime() - then) / 1000));
  const units: Array<[label: string, size: number]> = [
    ["day", 86_400],
    ["hour", 3_600],
    ["minute", 60],
  ];

  for (const [label, size] of units) {
    const count = Math.floor(seconds / size);
    if (count >= 1) {
      return `${count} ${label}${count === 1 ? "" : "s"} ago`;
    }
  }
  return "just now";
}

/** Collapse a multi-line error into the single line the marker keeps. */
export function firstLine(text: string, limit = 200): string {
  const line = text.split("\n").map((part) => part.trim()).find(Boolean) ?? "";
  return line.length > limit ? `${line.slice(0, limit - 1)}…` : line;
}
