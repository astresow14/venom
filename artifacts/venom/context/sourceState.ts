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