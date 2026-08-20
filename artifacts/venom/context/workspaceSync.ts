import type {
  VenomConversation,
  VenomDeletionMarker,
  VenomKnowledgeCluster,
  VenomProject,
  VenomWorkspaceState,
  VenomWorkspaceTombstones,
} from '@workspace/api-client-react';
import {
  mergeProjectBoardSnapshots,
  normalizeProjectBoard,
} from './boardState.ts';

type WorkspaceTombstones = VenomWorkspaceTombstones;
type TombstoneCollection = keyof WorkspaceTombstones;

const TOMBSTONE_LIMITS: Record<TombstoneCollection, number> = {
  projects: 1000,
  tasks: 5000,
  conversations: 1000,
  messages: 10000,
  clusters: 2000,
  stages: 15000,
  fields: 20000,
};

export type SyncController = {
  userId: string | null;
  inFlight: boolean;
  queued: VenomWorkspaceState | null;
  retryAttempt: number;
  retryTimer: ReturnType<typeof setTimeout> | null;
};

export type SuccessfulWorkspaceHydration = {
  state: VenomWorkspaceState;
  pendingLegacyImport: boolean;
  shouldUpload: boolean;
  syncStatus: 'pending' | 'syncing' | 'synced';
};

type WorkspaceSyncSnapshot = {
  state: VenomWorkspaceState | null;
  revision: number;
  updatedAt: string | null;
};

type WorkspaceSyncFailure =
  | { kind: 'conflict'; snapshot: WorkspaceSyncSnapshot | null }
  | { kind: 'too_large' }
  | { kind: 'other' };

type FlushWorkspaceStateOptions = {
  nextState: VenomWorkspaceState;
  syncUserId: string;
  controller: SyncController;
  getCurrentController: () => SyncController;
  getActiveUserId: () => string | null;
  getLatestState: () => VenomWorkspaceState;
  getRevision: () => number;
  setRevision: (revision: number) => void;
  getToken: () => Promise<string | null>;
  saveState: (
    state: VenomWorkspaceState,
    baseRevision: number,
    token: string,
  ) => Promise<WorkspaceSyncSnapshot>;
  classifyFailure: (error: unknown) => WorkspaceSyncFailure;
  onSyncing: () => void;
  onSaved: (input: {
    state: VenomWorkspaceState;
    serialized: string;
    snapshot: WorkspaceSyncSnapshot;
  }) => Promise<void>;
  onConflictMerged: (
    state: VenomWorkspaceState,
    snapshot: WorkspaceSyncSnapshot,
  ) => void;
  onTooLarge: () => void;
  onError: () => void;
  onRetryableFailure?: () => void;
};

export function createEmptyTombstones(): WorkspaceTombstones {
  return {
    projects: [],
    tasks: [],
    conversations: [],
    messages: [],
    clusters: [],
    stages: [],
    fields: [],
  };
}

function mergeDeletionMarkers(
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

export function normalizeTombstones(
  tombstones: VenomWorkspaceState['tombstones'],
): WorkspaceTombstones {
  const empty = createEmptyTombstones();
  if (!tombstones) return empty;

  return {
    projects: mergeDeletionMarkers(
      TOMBSTONE_LIMITS.projects,
      tombstones.projects ?? [],
    ),
    tasks: mergeDeletionMarkers(
      TOMBSTONE_LIMITS.tasks,
      tombstones.tasks ?? [],
    ),
    conversations: mergeDeletionMarkers(
      TOMBSTONE_LIMITS.conversations,
      tombstones.conversations ?? [],
    ),
    messages: mergeDeletionMarkers(
      TOMBSTONE_LIMITS.messages,
      tombstones.messages ?? [],
    ),
    clusters: mergeDeletionMarkers(
      TOMBSTONE_LIMITS.clusters,
      tombstones.clusters ?? [],
    ),
    stages: mergeDeletionMarkers(
      TOMBSTONE_LIMITS.stages,
      tombstones.stages ?? [],
    ),
    fields: mergeDeletionMarkers(
      TOMBSTONE_LIMITS.fields,
      tombstones.fields ?? [],
    ),
  };
}

export function mergeTombstones(
  current: VenomWorkspaceState['tombstones'],
  additions: Partial<WorkspaceTombstones>,
): WorkspaceTombstones {
  const normalized = normalizeTombstones(current);
  return {
    projects: mergeDeletionMarkers(
      TOMBSTONE_LIMITS.projects,
      normalized.projects,
      additions.projects ?? [],
    ),
    tasks: mergeDeletionMarkers(
      TOMBSTONE_LIMITS.tasks,
      normalized.tasks,
      additions.tasks ?? [],
    ),
    conversations: mergeDeletionMarkers(
      TOMBSTONE_LIMITS.conversations,
      normalized.conversations,
      additions.conversations ?? [],
    ),
    messages: mergeDeletionMarkers(
      TOMBSTONE_LIMITS.messages,
      normalized.messages,
      additions.messages ?? [],
    ),
    clusters: mergeDeletionMarkers(
      TOMBSTONE_LIMITS.clusters,
      normalized.clusters,
      additions.clusters ?? [],
    ),
    stages: mergeDeletionMarkers(
      TOMBSTONE_LIMITS.stages,
      normalized.stages,
      additions.stages ?? [],
    ),
    fields: mergeDeletionMarkers(
      TOMBSTONE_LIMITS.fields,
      normalized.fields,
      additions.fields ?? [],
    ),
  };
}

export function createDeletionMarkers(ids: string[], deletedAt: number) {
  return [...new Set(ids)].map((id) => ({ id, deletedAt }));
}

function deletionTime(markers: VenomDeletionMarker[]) {
  return new Map(markers.map((marker) => [marker.id, marker.deletedAt]));
}

export function isWorkspaceState(
  value: unknown,
): value is VenomWorkspaceState {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<VenomWorkspaceState>;
  return (
    Array.isArray(candidate.projects) &&
    Array.isArray(candidate.conversations) &&
    Array.isArray(candidate.clusters)
  );
}

export function normalizeWorkspaceState(
  value: VenomWorkspaceState,
): VenomWorkspaceState {
  return {
    ...value,
    projects: value.projects.map((project) => normalizeProjectBoard(project)),
    clusters: value.clusters.map((cluster) => {
      const legacyDescription =
        typeof cluster.description === 'string'
          ? cluster.description
          : `${cluster.label} knowledge saved by Venom.`;
      return {
        ...cluster,
        projectId:
          typeof cluster.projectId === 'string' || cluster.projectId === null
            ? cluster.projectId
            : value.activeProjectId,
        description: legacyDescription,
        summary:
          typeof cluster.summary === 'string'
            ? cluster.summary
            : legacyDescription,
        mentionCount:
          typeof cluster.mentionCount === 'number' ? cluster.mentionCount : 1,
        lastUpdatedAt:
          typeof cluster.lastUpdatedAt === 'number'
            ? cluster.lastUpdatedAt
            : 0,
        sources: Array.isArray(cluster.sources) ? cluster.sources : [],
      };
    }),
    tombstones: normalizeTombstones(value.tombstones),
  };
}

function mergeProjects(
  cloudItems: VenomProject[],
  deviceItems: VenomProject[],
  tombstones: WorkspaceTombstones,
): VenomProject[] {
  const projectDeletionTimes = deletionTime(tombstones.projects);
  const taskDeletionTimes = deletionTime(tombstones.tasks);
  const stageDeletionTimes = deletionTime(tombstones.stages);
  const fieldDeletionTimes = deletionTime(tombstones.fields);
  const cloudById = new Map(cloudItems.map((item) => [item.id, item]));
  const deviceById = new Map(deviceItems.map((item) => [item.id, item]));
  const projectIds = new Set([...cloudById.keys(), ...deviceById.keys()]);
  const merged: VenomProject[] = [];

  for (const projectId of projectIds) {
    const cloudItem = cloudById.get(projectId);
    const deviceItem = deviceById.get(projectId);
    const newest =
      !cloudItem ||
      (deviceItem && deviceItem.updatedAt >= cloudItem.updatedAt)
        ? deviceItem
        : cloudItem;
    if (!newest) continue;
    if (
      (projectDeletionTimes.get(projectId) ?? -1) >= newest.updatedAt
    ) {
      continue;
    }

    merged.push(
      mergeProjectBoardSnapshots(
        cloudItem ?? newest,
        deviceItem ?? newest,
        {
          tasks: taskDeletionTimes,
          stages: stageDeletionTimes,
          fields: fieldDeletionTimes,
        },
      ),
    );
  }

  return merged;
}

function mergeConversations(
  cloudItems: VenomConversation[],
  deviceItems: VenomConversation[],
  tombstones: WorkspaceTombstones,
): VenomConversation[] {
  const conversationDeletionTimes = deletionTime(tombstones.conversations);
  const messageDeletionTimes = deletionTime(tombstones.messages);
  const cloudById = new Map(cloudItems.map((item) => [item.id, item]));
  const deviceById = new Map(deviceItems.map((item) => [item.id, item]));
  const conversationIds = new Set([
    ...cloudById.keys(),
    ...deviceById.keys(),
  ]);
  const merged: VenomConversation[] = [];

  for (const conversationId of conversationIds) {
    const cloudItem = cloudById.get(conversationId);
    const deviceItem = deviceById.get(conversationId);
    const newest =
      !cloudItem ||
      (deviceItem && deviceItem.updatedAt >= cloudItem.updatedAt)
        ? deviceItem
        : cloudItem;
    if (!newest) continue;
    if (
      (conversationDeletionTimes.get(conversationId) ?? -1) >=
      newest.updatedAt
    ) {
      continue;
    }

    const older = newest === deviceItem ? cloudItem : deviceItem;
    const messages = new Map(
      (older?.messages ?? []).map((message) => [message.id, message]),
    );
    for (const message of newest.messages) {
      messages.set(message.id, message);
    }

    merged.push({
      ...newest,
      messages: [...messages.values()]
        .filter(
          (message) =>
            (messageDeletionTimes.get(message.id) ?? -1) <
            message.createdAt,
        )
        .sort((left, right) => left.createdAt - right.createdAt),
    });
  }
  return merged;
}

export function reconcileKnowledgeLinks(clusters: VenomKnowledgeCluster[]) {
  const clusterById = new Map(clusters.map((cluster) => [cluster.id, cluster]));
  const linkedIds = new Map(
    clusters.map((cluster) => [cluster.id, new Set<string>()]),
  );

  for (const cluster of clusters) {
    for (const linkId of cluster.links) {
      const linkedCluster = clusterById.get(linkId);
      if (
        !linkedCluster ||
        linkedCluster.id === cluster.id ||
        linkedCluster.projectId !== cluster.projectId
      ) {
        continue;
      }
      linkedIds.get(cluster.id)?.add(linkedCluster.id);
      linkedIds.get(linkedCluster.id)?.add(cluster.id);
    }
  }

  return clusters.map((cluster) => ({
    ...cluster,
    links: [...(linkedIds.get(cluster.id) ?? [])],
  }));
}

export function mergeWorkspaceStates(
  cloudState: VenomWorkspaceState,
  deviceState: VenomWorkspaceState,
): VenomWorkspaceState {
  const tombstones = mergeTombstones(cloudState.tombstones, {
    ...normalizeTombstones(deviceState.tombstones),
  });
  const projects = mergeProjects(
    cloudState.projects,
    deviceState.projects,
    tombstones,
  );
  const conversations = mergeConversations(
    cloudState.conversations,
    deviceState.conversations,
    tombstones,
  );
  const clusterDeletionTimes = deletionTime(tombstones.clusters);
  const clusters = new Map(
    cloudState.clusters.map((cluster) => [cluster.id, cluster]),
  );
  for (const cluster of deviceState.clusters) {
    const existing = clusters.get(cluster.id);
    if (!existing || cluster.lastUpdatedAt >= existing.lastUpdatedAt) {
      clusters.set(cluster.id, cluster);
    }
  }

  const projectIds = new Set(projects.map((project) => project.id));
  const liveConversations = conversations.filter(
    (conversation) =>
      conversation.projectId === null ||
      projectIds.has(conversation.projectId),
  );
  const conversationIds = new Set(
    liveConversations.map((conversation) => conversation.id),
  );
  const liveClusters = reconcileKnowledgeLinks(
    [...clusters.values()].filter(
      (cluster) =>
        (cluster.projectId === null || projectIds.has(cluster.projectId)) &&
        (clusterDeletionTimes.get(cluster.id) ?? -1) <
          cluster.lastUpdatedAt,
    ),
  );
  const preferredProjectId =
    deviceState.activeProjectId &&
    projectIds.has(deviceState.activeProjectId)
      ? deviceState.activeProjectId
      : cloudState.activeProjectId &&
          projectIds.has(cloudState.activeProjectId)
        ? cloudState.activeProjectId
        : null;
  const preferredConversationId =
    deviceState.activeConversationId &&
    conversationIds.has(deviceState.activeConversationId)
      ? deviceState.activeConversationId
      : cloudState.activeConversationId &&
          conversationIds.has(cloudState.activeConversationId)
        ? cloudState.activeConversationId
        : null;

  return {
    projects,
    conversations: liveConversations,
    clusters: liveClusters,
    activeProjectId: preferredProjectId,
    activeConversationId: preferredConversationId,
    tombstones,
  };
}

export function isCurrentWorkspaceSync(
  controller: SyncController,
  currentController: SyncController,
  syncUserId: string,
  activeUserId: string | null,
) {
  return (
    controller === currentController &&
    controller.userId === syncUserId &&
    activeUserId === syncUserId
  );
}

export async function flushWorkspaceState({
  nextState,
  syncUserId,
  controller,
  getCurrentController,
  getActiveUserId,
  getLatestState,
  getRevision,
  setRevision,
  getToken,
  saveState,
  classifyFailure,
  onSyncing,
  onSaved,
  onConflictMerged,
  onTooLarge,
  onError,
  onRetryableFailure,
}: FlushWorkspaceStateOptions) {
  const isCurrent = () =>
    isCurrentWorkspaceSync(
      controller,
      getCurrentController(),
      syncUserId,
      getActiveUserId(),
    );
  const retainForRetry = (stateToSave: VenomWorkspaceState) => {
    controller.queued = controller.queued
      ? mergeWorkspaceStates(stateToSave, controller.queued)
      : stateToSave;
    onError();
    onRetryableFailure?.();
  };
  if (!isCurrent()) return;

  controller.queued = nextState;
  if (controller.inFlight) return;

  controller.inFlight = true;
  try {
    let candidate: VenomWorkspaceState | null = controller.queued;
    controller.queued = null;
    let conflictCount = 0;

    while (candidate && isCurrent()) {
      const stateToSave: VenomWorkspaceState = candidate;
      const serialized = JSON.stringify(stateToSave);
      onSyncing();

      try {
        const token = await getToken();
        if (!isCurrent()) return;
        if (!token) {
          retainForRetry(stateToSave);
          return;
        }

        const saved = await saveState(
          stateToSave,
          getRevision(),
          token,
        );
        if (!isCurrent()) return;

        setRevision(saved.revision);
        await onSaved({ state: stateToSave, serialized, snapshot: saved });
        controller.retryAttempt = 0;

        const queued = controller.queued;
        controller.queued = null;
        candidate = queued
          ? mergeWorkspaceStates(stateToSave, queued)
          : null;
      } catch (error) {
        if (!isCurrent()) return;

        const failure = classifyFailure(error);
        if (failure.kind === 'too_large') {
          controller.queued = null;
          onTooLarge();
          candidate = null;
          continue;
        }
        if (
          failure.kind === 'conflict' &&
          failure.snapshot?.state &&
          conflictCount < 4
        ) {
          conflictCount += 1;
          const mostRecentDeviceState =
            controller.queued ?? getLatestState();
          controller.queued = null;
          candidate = mergeWorkspaceStates(
            normalizeWorkspaceState(failure.snapshot.state),
            mostRecentDeviceState,
          );
          setRevision(failure.snapshot.revision);
          onConflictMerged(candidate, failure.snapshot);
          continue;
        }

        retainForRetry(stateToSave);
        candidate = null;
      }
    }
  } finally {
    controller.inFlight = false;
  }
}

export function resolveSuccessfulWorkspaceHydration({
  cloudState,
  localState,
  legacyState,
  hasScopedState,
  createFreshState,
}: {
  cloudState: VenomWorkspaceState | null;
  localState: VenomWorkspaceState;
  legacyState: VenomWorkspaceState | null;
  hasScopedState: boolean;
  createFreshState: () => VenomWorkspaceState;
}): SuccessfulWorkspaceHydration {
  if (cloudState) {
    return {
      state: cloudState,
      pendingLegacyImport: false,
      shouldUpload: false,
      syncStatus: 'synced',
    };
  }

  if (!hasScopedState && legacyState) {
    return {
      state: createFreshState(),
      pendingLegacyImport: true,
      shouldUpload: false,
      syncStatus: 'pending',
    };
  }

  return {
    state: localState,
    pendingLegacyImport: false,
    shouldUpload: true,
    syncStatus: 'syncing',
  };
}