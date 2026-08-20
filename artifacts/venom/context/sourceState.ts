import type {
  ProjectSource,
  VenomDeletionMarker,
} from "@workspace/api-client-react";

export function mergeSourceDeletionMarkers(
  limit: number,
  ...markerLists: VenomDeletionMarker[][]
) {
  const merged = new Map<string, VenomDeletionMarker>();
  for (const marker of markerLists.flat()) {
    const existing = merged.get(marker.id);
    if (!existing || marker.deletedAt > existing.deletedAt) {
      merged.set(marker.id, marker);
    }
  }

  return [...merged.values()]
    .sort((left, right) => right.deletedAt - left.deletedAt)
    .slice(0, limit);
}

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/**
 * Human-readable "last successful sync" label for a connected source card.
 */
export function describeLastSync(syncedAt: string, now: number): string {
  const syncedTime = Date.parse(syncedAt);
  if (Number.isNaN(syncedTime)) return "Last synced recently";

  const elapsed = now - syncedTime;
  if (elapsed < 0 || elapsed < MINUTE_MS) return "Last synced just now";
  if (elapsed < HOUR_MS) {
    const minutes = Math.floor(elapsed / MINUTE_MS);
    return `Last synced ${minutes}m ago`;
  }
  if (elapsed < DAY_MS) {
    const hours = Math.floor(elapsed / HOUR_MS);
    return `Last synced ${hours}h ago`;
  }

  const days = Math.floor(elapsed / DAY_MS);
  if (days <= 30) return `Last synced ${days}d ago`;
  return `Last synced ${syncedAt.slice(0, 10)}`;
}

export type SourceRefreshRequest =
  | { provider: "github"; projectId: string; repository: string }
  | { provider: "website"; projectId: string; url: string };

const REPOSITORY_PATH_PATTERN = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;

function githubRepositoryPath(source: ProjectSource): string | null {
  const name = source.name.trim();
  if (REPOSITORY_PATH_PATTERN.test(name)) return name;

  const fromUrl = source.url
    .trim()
    .replace(/^https?:\/\/(www\.)?github\.com\//i, "")
    .replace(/\.git$/i, "")
    .replace(/\/+$/, "");
  return REPOSITORY_PATH_PATTERN.test(fromUrl) ? fromUrl : null;
}

/**
 * Describes how an already-connected source is re-synced. Refresh reuses the
 * original connect request so the server recomputes the same deterministic
 * source id, which is what lets a refresh replace a source in place.
 */
export function sourceRefreshRequest(
  source: ProjectSource,
): SourceRefreshRequest | null {
  if (source.provider === "github") {
    const repository = githubRepositoryPath(source);
    return repository
      ? { provider: "github", projectId: source.projectId, repository }
      : null;
  }

  const url = source.url.trim();
  return /^https:\/\/\S+$/i.test(url)
    ? { provider: "website", projectId: source.projectId, url }
    : null;
}

/**
 * Swaps a refreshed snapshot in for the source it was refreshed from so stale
 * metadata, citations, and clusters never linger beside the new ones. Returns
 * null when the refresh must be discarded instead of applied.
 */
export function replaceRefreshedSource(
  sources: ProjectSource[],
  previousSourceId: string,
  refreshed: ProjectSource,
): { sources: ProjectSource[]; retiredSourceId: string | null } | null {
  const previousIndex = sources.findIndex(
    (source) => source.id === previousSourceId,
  );
  // The source was removed (or never restored) while the refresh was in
  // flight; applying it would resurrect deleted content.
  if (previousIndex === -1) return null;

  const previous = sources[previousIndex];
  if (previous.projectId !== refreshed.projectId) return null;

  const existing = sources.find((source) => source.id === refreshed.id);
  if (
    existing &&
    Date.parse(refreshed.syncedAt) < Date.parse(existing.syncedAt)
  ) {
    return null;
  }

  const next = sources.filter(
    (source) => source.id !== previousSourceId && source.id !== refreshed.id,
  );
  next.splice(Math.min(previousIndex, next.length), 0, refreshed);

  return {
    sources: next,
    retiredSourceId: previous.id === refreshed.id ? null : previous.id,
  };
}

export function mergeProjectSources(
  current: ProjectSource[],
  incoming: ProjectSource[],
  deletionMarkers: VenomDeletionMarker[] = [],
): ProjectSource[] {
  const byId = new Map(current.map((source) => [source.id, source]));
  for (const source of incoming) {
    const existing = byId.get(source.id);
    if (!existing || source.syncedAt >= existing.syncedAt) {
      byId.set(source.id, source);
    }
  }

  const deletionTimes = new Map(
    deletionMarkers.map((marker) => [marker.id, marker.deletedAt]),
  );
  return [...byId.values()].filter(
    (source) =>
      (deletionTimes.get(source.id) ?? -1) < Date.parse(source.syncedAt),
  );
}