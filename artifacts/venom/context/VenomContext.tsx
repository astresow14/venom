import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useAuth } from '@clerk/expo';
import {
  applyKnowledgeInsightsToState,
  clearConversationKnowledge,
} from './knowledgeState';
import {
  ApiError,
  getGetVenomWorkspaceQueryKey,
  saveVenomWorkspace,
  useGetVenomWorkspace,
  type KnowledgeCandidate,
  type VenomConversation,
  type VenomDeletionMarker,
  type VenomKnowledgeCluster,
  type VenomKnowledgeSource,
  type VenomMessage,
  type VenomProject,
  type VenomTask,
  type VenomTaskStatus,
  type VenomWorkspaceSnapshot,
  type VenomWorkspaceState,
  type VenomWorkspaceTombstones,
} from '@workspace/api-client-react';

export type Project = VenomProject;
export type Task = VenomTask;
export type TaskStatus = VenomTaskStatus;
export type Message = VenomMessage;
export type Conversation = VenomConversation;
export type KnowledgeCluster = VenomKnowledgeCluster;
export type KnowledgeSource = VenomKnowledgeSource;
export type KnowledgeInsight = KnowledgeCandidate;
export type VenomState = VenomWorkspaceState;
type WorkspaceTombstones = VenomWorkspaceTombstones;
type TombstoneCollection = keyof WorkspaceTombstones;
export type SyncStatus =
  | 'loading'
  | 'pending'
  | 'syncing'
  | 'synced'
  | 'offline'
  | 'too_large'
  | 'error';

type VenomContextType = {
  state: VenomState;
  isReady: boolean;
  syncStatus: SyncStatus;
  lastSyncedAt: string | null;
  hasPendingLegacyImport: boolean;
  importDeviceWorkspace: () => void;
  startFreshWorkspace: () => void;
  addProject: (
    project: Omit<Project, 'id' | 'updatedAt' | 'tasks'>,
  ) => void;
  updateProject: (id: string, project: Partial<Project>) => void;
  deleteProject: (id: string) => void;
  setActiveProject: (id: string | null) => void;
  addTask: (projectId: string, title: string) => void;
  updateTaskStatus: (
    projectId: string,
    taskId: string,
    status: TaskStatus,
  ) => void;
  deleteTask: (projectId: string, taskId: string) => void;
  addMessage: (
    conversationId: string | null,
    message: Omit<Message, 'id' | 'createdAt'> & { id?: string },
  ) => string;
  updateMessage: (
    conversationId: string,
    messageId: string,
    updates: Partial<Message>,
  ) => void;
  setActiveConversation: (id: string | null) => void;
  clearConversation: (id: string) => void;
  createNewConversation: (projectId: string | null) => string;
  applyKnowledgeInsights: (
    conversation: Pick<Conversation, 'id' | 'title' | 'projectId'>,
    insights: KnowledgeInsight[],
  ) => void;
  renameKnowledgeCluster: (clusterId: string, label: string) => void;
  deleteKnowledgeCluster: (clusterId: string) => void;
  mergeKnowledgeClusters: (
    targetClusterId: string,
    sourceClusterId: string,
  ) => void;
};

const defaultClusters: KnowledgeCluster[] = [
  {
    id: '1',
    projectId: 'proj_default',
    label: 'Core Intelligence',
    category: 'core',
    strength: 1,
    x: 50,
    y: 50,
    links: ['2', '3'],
    description: 'System design and structural patterns for the workspace.',
    summary: 'System design and structural patterns for the workspace.',
    mentionCount: 1,
    lastUpdatedAt: 0,
    sources: [],
  },
  {
    id: '2',
    projectId: 'proj_default',
    label: 'Tactical Subsystem',
    category: 'tactical',
    strength: 0.8,
    x: 120,
    y: -30,
    links: ['1', '4'],
    description: 'Active capabilities, execution plans, and project tactics.',
    summary: 'Active capabilities, execution plans, and project tactics.',
    mentionCount: 1,
    lastUpdatedAt: 0,
    sources: [],
  },
  {
    id: '3',
    projectId: 'proj_default',
    label: 'Memory Matrix',
    category: 'memory',
    strength: 0.9,
    x: -80,
    y: 60,
    links: ['1'],
    description: 'Persisted decisions and context from prior work.',
    summary: 'Persisted decisions and context from prior work.',
    mentionCount: 1,
    lastUpdatedAt: 0,
    sources: [],
  },
  {
    id: '4',
    projectId: 'proj_default',
    label: 'External APIs',
    category: 'external',
    strength: 0.5,
    x: 200,
    y: 10,
    links: ['2'],
    description: 'Connected services, APIs, and external project sources.',
    summary: 'Connected services, APIs, and external project sources.',
    mentionCount: 1,
    lastUpdatedAt: 0,
    sources: [],
  },
  {
    id: '5',
    projectId: 'proj_default',
    label: 'User Persona',
    category: 'memory',
    strength: 0.7,
    x: -40,
    y: -90,
    links: ['3', '1'],
    description: 'Working preferences and context learned from collaboration.',
    summary: 'Working preferences and context learned from collaboration.',
    mentionCount: 1,
    lastUpdatedAt: 0,
    sources: [],
  },
];

const LEGACY_STORAGE_KEYS = ['@venom_state_v3', '@venom_state_v1'] as const;
const storageKeyFor = (userId: string) => `@venom_state_v2:${userId}`;
const generateId = (prefix: string) =>
  `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`;
const normalizeLabel = (label: string) => label.trim().toLocaleLowerCase();

const TOMBSTONE_LIMITS: Record<TombstoneCollection, number> = {
  projects: 1000,
  tasks: 5000,
  conversations: 1000,
  messages: 10000,
  clusters: 2000,
};

function createEmptyTombstones(): WorkspaceTombstones {
  return {
    projects: [],
    tasks: [],
    conversations: [],
    messages: [],
    clusters: [],
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

function normalizeTombstones(
  tombstones: VenomState['tombstones'],
): WorkspaceTombstones {
  const empty = createEmptyTombstones();
  if (!tombstones) return empty;

  return {
    projects: mergeDeletionMarkers(
      TOMBSTONE_LIMITS.projects,
      tombstones.projects,
    ),
    tasks: mergeDeletionMarkers(TOMBSTONE_LIMITS.tasks, tombstones.tasks),
    conversations: mergeDeletionMarkers(
      TOMBSTONE_LIMITS.conversations,
      tombstones.conversations,
    ),
    messages: mergeDeletionMarkers(
      TOMBSTONE_LIMITS.messages,
      tombstones.messages,
    ),
    clusters: mergeDeletionMarkers(
      TOMBSTONE_LIMITS.clusters,
      tombstones.clusters,
    ),
  };
}

function mergeTombstones(
  current: VenomState['tombstones'],
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
  };
}

function createDeletionMarkers(ids: string[], deletedAt: number) {
  return [...new Set(ids)].map((id) => ({ id, deletedAt }));
}

function deletionTime(markers: VenomDeletionMarker[]) {
  return new Map(markers.map((marker) => [marker.id, marker.deletedAt]));
}

function positionForLabel(label: string, index: number) {
  const hash = [...label].reduce(
    (value, char) => (value * 31 + char.charCodeAt(0)) >>> 0,
    17,
  );
  const angle = (hash % 360) * (Math.PI / 180);
  const radius = 80 + ((hash >>> 8) % 4) * 42 + (index % 3) * 18;
  return {
    x: Math.round(Math.cos(angle) * radius),
    y: Math.round(Math.sin(angle) * radius),
  };
}

function pruneKnowledgeSources(
  clusters: KnowledgeCluster[],
  shouldRemove: (source: KnowledgeSource) => boolean,
) {
  const withLiveSources = clusters
    .map((cluster) => {
      if (cluster.sources.length === 0) return cluster;
      return {
        ...cluster,
        sources: cluster.sources.filter((source) => !shouldRemove(source)),
      };
    })
    .filter((cluster) => cluster.sources.length > 0 || cluster.mentionCount > 0);
  const liveClusterIds = new Set(
    withLiveSources.map((cluster) => cluster.id),
  );
  return withLiveSources.map((cluster) => ({
    ...cluster,
    links: cluster.links.filter((linkId) => liveClusterIds.has(linkId)),
  }));
}

function createDefaultState(): VenomState {
  const now = Date.now();
  return {
    projects: [
      {
        id: 'proj_default',
        name: 'Global Workspace',
        description: 'Uncategorized intelligence',
        accent: '#b4f536',
        sourceCount: 0,
        updatedAt: now,
        tasks: [
          {
            id: 'task_1',
            title: 'Define data schema',
            status: 'done',
            createdAt: now - 100000,
          },
          {
            id: 'task_2',
            title: 'Implement authentication',
            status: 'in_progress',
            createdAt: now - 50000,
          },
          {
            id: 'task_3',
            title: 'Design onboarding flow',
            status: 'todo',
            createdAt: now,
          },
        ],
      },
    ],
    conversations: [
      {
        id: 'conv_default',
        title: 'New Session',
        projectId: 'proj_default',
        updatedAt: now,
        messages: [],
      },
    ],
    clusters: defaultClusters,
    activeProjectId: 'proj_default',
    activeConversationId: 'conv_default',
    tombstones: createEmptyTombstones(),
  };
}

function isWorkspaceState(value: unknown): value is VenomState {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<VenomState>;
  return (
    Array.isArray(candidate.projects) &&
    Array.isArray(candidate.conversations) &&
    Array.isArray(candidate.clusters)
  );
}

function normalizeWorkspaceState(value: VenomState): VenomState {
  return {
    ...value,
    projects: value.projects.map((project) => ({
      ...project,
      tasks: Array.isArray(project.tasks) ? project.tasks : [],
    })),
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
  cloudItems: Project[],
  deviceItems: Project[],
  tombstones: WorkspaceTombstones,
): Project[] {
  const projectDeletionTimes = deletionTime(tombstones.projects);
  const taskDeletionTimes = deletionTime(tombstones.tasks);
  const cloudById = new Map(cloudItems.map((item) => [item.id, item]));
  const deviceById = new Map(deviceItems.map((item) => [item.id, item]));
  const projectIds = new Set([...cloudById.keys(), ...deviceById.keys()]);
  const merged: Project[] = [];

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

    const older = newest === deviceItem ? cloudItem : deviceItem;
    const tasks = new Map(
      (older?.tasks ?? []).map((task) => [task.id, task]),
    );
    for (const task of newest.tasks) {
      tasks.set(task.id, task);
    }

    merged.push({
      ...newest,
      tasks: [...tasks.values()].filter(
        (task) =>
          (taskDeletionTimes.get(task.id) ?? -1) < task.createdAt,
      ),
    });
  }

  return merged;
}

function mergeConversations(
  cloudItems: Conversation[],
  deviceItems: Conversation[],
  tombstones: WorkspaceTombstones,
): Conversation[] {
  const conversationDeletionTimes = deletionTime(tombstones.conversations);
  const messageDeletionTimes = deletionTime(tombstones.messages);
  const cloudById = new Map(cloudItems.map((item) => [item.id, item]));
  const deviceById = new Map(deviceItems.map((item) => [item.id, item]));
  const conversationIds = new Set([
    ...cloudById.keys(),
    ...deviceById.keys(),
  ]);
  const merged: Conversation[] = [];

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

function mergeWorkspaceStates(
  cloudState: VenomState,
  deviceState: VenomState,
): VenomState {
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

type SyncController = {
  userId: string | null;
  inFlight: boolean;
  queued: VenomState | null;
};

const VenomContext = createContext<VenomContextType | null>(null);

export function VenomProvider({ children }: { children: React.ReactNode }) {
  const { getToken, userId } = useAuth();
  const [state, setState] = useState<VenomState>(() => createDefaultState());
  const [localState, setLocalState] = useState<VenomState | null>(null);
  const [legacyState, setLegacyState] = useState<VenomState | null>(null);
  const [hasScopedState, setHasScopedState] = useState(false);
  const [hasPendingLegacyImport, setHasPendingLegacyImport] = useState(false);
  const [localUserId, setLocalUserId] = useState<string | null>(null);
  const [isReady, setIsReady] = useState(false);
  const [syncStatus, setSyncStatus] = useState<SyncStatus>('loading');
  const [lastSyncedAt, setLastSyncedAt] = useState<string | null>(null);
  const latestStateRef = useRef(state);
  latestStateRef.current = state;

  const revisionRef = useRef(0);
  const hydratedUserRef = useRef<string | null>(null);
  const lastSerializedRef = useRef('');
  const activeUserIdRef = useRef<string | null>(userId ?? null);
  const syncControllerRef = useRef<SyncController>({
    userId: userId ?? null,
    inFlight: false,
    queued: null,
  });

  if (activeUserIdRef.current !== (userId ?? null)) {
    activeUserIdRef.current = userId ?? null;
    syncControllerRef.current = {
      userId: userId ?? null,
      inFlight: false,
      queued: null,
    };
  }

  const workspaceQuery = useGetVenomWorkspace({
    query: {
      enabled: Boolean(userId),
      queryKey: [
        ...getGetVenomWorkspaceQueryKey(),
        userId ?? 'signed-out',
      ],
      retry: 2,
      refetchOnMount: 'always',
    },
  });
  useEffect(() => {
    let cancelled = false;

    if (!userId) {
      hydratedUserRef.current = null;
      revisionRef.current = 0;
      lastSerializedRef.current = '';
      setLocalState(null);
      setLegacyState(null);
      setHasScopedState(false);
      setHasPendingLegacyImport(false);
      setLocalUserId(null);
      setState(createDefaultState());
      setIsReady(false);
      setSyncStatus('loading');
      setLastSyncedAt(null);
      return;
    }

    setIsReady(false);
    setSyncStatus('loading');
    setLocalState(null);
    setLegacyState(null);
    setHasScopedState(false);
    setHasPendingLegacyImport(false);
    setLocalUserId(null);
    hydratedUserRef.current = null;
    revisionRef.current = 0;
    lastSerializedRef.current = '';

    void (async () => {
      const [scopedData, legacyEntries] = await Promise.all([
        AsyncStorage.getItem(storageKeyFor(userId)),
        AsyncStorage.multiGet([...LEGACY_STORAGE_KEYS]),
      ]);
      const legacyData =
        legacyEntries.find(([, storedValue]) => storedValue !== null)?.[1] ??
        null;
      let restored = createDefaultState();
      let restoredLegacy: VenomState | null = null;
      let scopedStateIsValid = false;

      if (scopedData) {
        try {
          const parsed: unknown = JSON.parse(scopedData);
          if (isWorkspaceState(parsed)) {
            restored = normalizeWorkspaceState(parsed);
            scopedStateIsValid = true;
          }
        } catch {
          setSyncStatus('error');
        }
      }

      if (legacyData) {
        try {
          const parsed: unknown = JSON.parse(legacyData);
          if (isWorkspaceState(parsed)) {
            restoredLegacy = normalizeWorkspaceState(parsed);
          }
        } catch {
          setSyncStatus('error');
        }
      }

      if (!cancelled) {
        setLocalState(restored);
        setLegacyState(restoredLegacy);
        setHasScopedState(scopedStateIsValid);
        setLocalUserId(userId);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [userId]);

  const flushCloudState = useCallback(
    async (nextState: VenomState) => {
      if (!userId) return;

      const syncUserId = userId;
      const controller = syncControllerRef.current;
      if (controller.userId !== syncUserId) return;

      controller.queued = nextState;
      if (controller.inFlight) return;

      controller.inFlight = true;
      try {
        let candidate: VenomState | null = controller.queued;
        controller.queued = null;
        let conflictCount = 0;

        while (
          candidate &&
          syncControllerRef.current === controller &&
          activeUserIdRef.current === syncUserId
        ) {
          const stateToSave = candidate;
          const serialized = JSON.stringify(stateToSave);
          setSyncStatus('syncing');

          try {
            const token = await getToken();
            if (
              !token ||
              syncControllerRef.current !== controller ||
              activeUserIdRef.current !== syncUserId
            ) {
              return;
            }

            const saved = await saveVenomWorkspace(
              {
                state: stateToSave,
                baseRevision: revisionRef.current,
              },
              {
                headers: { Authorization: `Bearer ${token}` },
              },
            );
            if (
              syncControllerRef.current !== controller ||
              activeUserIdRef.current !== syncUserId
            ) {
              return;
            }

            revisionRef.current = saved.revision;
            lastSerializedRef.current = serialized;
            setLastSyncedAt(saved.updatedAt);
            setSyncStatus('synced');
            await AsyncStorage.setItem(
              storageKeyFor(syncUserId),
              serialized,
            );

            const queued = controller.queued;
            controller.queued = null;
            if (queued) {
              candidate = mergeWorkspaceStates(stateToSave, queued);
            } else {
              candidate = null;
            }
          } catch (error) {
            if (error instanceof ApiError && error.status === 413) {
              controller.queued = null;
              setSyncStatus('too_large');
              candidate = null;
              continue;
            }
            if (error instanceof ApiError && error.status === 409) {
              const latest = error.data as VenomWorkspaceSnapshot | null;
              if (latest?.state && conflictCount < 4) {
                conflictCount += 1;
                const mostRecentDeviceState =
                  controller.queued ?? latestStateRef.current;
                controller.queued = null;
                candidate = mergeWorkspaceStates(
                  normalizeWorkspaceState(latest.state),
                  mostRecentDeviceState,
                );
                revisionRef.current = latest.revision;
                latestStateRef.current = candidate;
                setState(candidate);
                setLastSyncedAt(latest.updatedAt);
                continue;
              }
            }

            controller.queued = null;
            setSyncStatus('error');
            candidate = null;
          }
        }
      } finally {
        controller.inFlight = false;
      }
    },
    [getToken, userId],
  );

  useEffect(() => {
    if (
      !userId ||
      localUserId !== userId ||
      !localState ||
      hydratedUserRef.current === userId ||
      workspaceQuery.isPending
    ) {
      return;
    }

    hydratedUserRef.current = userId;

    if (workspaceQuery.isSuccess) {
      const cloud = workspaceQuery.data;
      revisionRef.current = cloud.revision;
      setLastSyncedAt(cloud.updatedAt);
      setIsReady(true);

      if (cloud.state) {
        const restoredCloud = normalizeWorkspaceState(cloud.state);
        lastSerializedRef.current = JSON.stringify(restoredCloud);
        latestStateRef.current = restoredCloud;
        setState(restoredCloud);
        setSyncStatus('synced');
        return;
      }

      if (!hasScopedState && legacyState) {
        const freshState = createDefaultState();
        lastSerializedRef.current = JSON.stringify(freshState);
        latestStateRef.current = freshState;
        setState(freshState);
        setHasPendingLegacyImport(true);
        setSyncStatus('pending');
        return;
      }

      lastSerializedRef.current = JSON.stringify(localState);
      latestStateRef.current = localState;
      setState(localState);
      setSyncStatus('syncing');
      void flushCloudState(localState);
      return;
    }

    latestStateRef.current = localState;
    setState(localState);
    lastSerializedRef.current = JSON.stringify(localState);
    if (!hasScopedState && legacyState) {
      setHasPendingLegacyImport(true);
      setSyncStatus('pending');
    } else {
      setSyncStatus('offline');
    }
    setIsReady(true);
  }, [
    flushCloudState,
    hasScopedState,
    legacyState,
    localState,
    localUserId,
    userId,
    workspaceQuery.data,
    workspaceQuery.isPending,
    workspaceQuery.isSuccess,
  ]);

  useEffect(() => {
    if (
      !isReady ||
      !userId ||
      hasPendingLegacyImport ||
      hydratedUserRef.current !== userId
    ) {
      return;
    }

    const serialized = JSON.stringify(state);
    void AsyncStorage.setItem(storageKeyFor(userId), serialized);

    if (serialized === lastSerializedRef.current) return;

    const timeout = setTimeout(() => {
      void flushCloudState(state);
    }, 700);

    return () => clearTimeout(timeout);
  }, [
    flushCloudState,
    hasPendingLegacyImport,
    isReady,
    state,
    userId,
  ]);

  const importDeviceWorkspace = useCallback(() => {
    if (!userId || !legacyState) return;

    setHasPendingLegacyImport(false);
    latestStateRef.current = legacyState;
    setState(legacyState);
    lastSerializedRef.current = '';
    void Promise.all(
      LEGACY_STORAGE_KEYS.map((storageKey) =>
        AsyncStorage.removeItem(storageKey),
      ),
    );
    void AsyncStorage.setItem(
      storageKeyFor(userId),
      JSON.stringify(legacyState),
    );
    void flushCloudState(legacyState);
  }, [flushCloudState, legacyState, userId]);

  const startFreshWorkspace = useCallback(() => {
    if (!userId) return;

    const freshState = createDefaultState();
    setHasPendingLegacyImport(false);
    latestStateRef.current = freshState;
    setState(freshState);
    lastSerializedRef.current = '';
    void Promise.all(
      LEGACY_STORAGE_KEYS.map((storageKey) =>
        AsyncStorage.removeItem(storageKey),
      ),
    );
    void AsyncStorage.setItem(
      storageKeyFor(userId),
      JSON.stringify(freshState),
    );
    void flushCloudState(freshState);
  }, [flushCloudState, userId]);

  const addProject = useCallback(
    (project: Omit<Project, 'id' | 'updatedAt' | 'tasks'>) => {
      const newProject: Project = {
        ...project,
        id: generateId('proj'),
        updatedAt: Date.now(),
        tasks: [],
      };
      setState((current) => ({
        ...current,
        projects: [...current.projects, newProject],
      }));
    },
    [],
  );

  const updateProject = useCallback(
    (id: string, updates: Partial<Project>) => {
      setState((current) => ({
        ...current,
        projects: current.projects.map((project) =>
          project.id === id
            ? { ...project, ...updates, updatedAt: Date.now() }
            : project,
        ),
      }));
    },
    [],
  );

  const deleteProject = useCallback((id: string) => {
    setState((current) => {
      const deletedAt = Date.now();
      const project = current.projects.find((item) => item.id === id);
      const removedConversations = current.conversations.filter(
        (conversation) => conversation.projectId === id,
      );
      const removedClusters = current.clusters.filter(
        (cluster) => cluster.projectId === id,
      );
      const conversations = current.conversations.filter(
        (conversation) => conversation.projectId !== id,
      );
      const activeConversationExists = conversations.some(
        (conversation) => conversation.id === current.activeConversationId,
      );

      return {
        ...current,
        projects: current.projects.filter((project) => project.id !== id),
        conversations,
        clusters: current.clusters.filter(
          (cluster) => cluster.projectId !== id,
        ),
        activeProjectId:
          current.activeProjectId === id ? null : current.activeProjectId,
        activeConversationId: activeConversationExists
          ? current.activeConversationId
          : null,
        tombstones: mergeTombstones(current.tombstones, {
          projects: createDeletionMarkers([id], deletedAt),
          tasks: createDeletionMarkers(
            project?.tasks.map((task) => task.id) ?? [],
            deletedAt,
          ),
          conversations: createDeletionMarkers(
            removedConversations.map((conversation) => conversation.id),
            deletedAt,
          ),
          messages: createDeletionMarkers(
            removedConversations.flatMap((conversation) =>
              conversation.messages.map((message) => message.id),
            ),
            deletedAt,
          ),
          clusters: createDeletionMarkers(
            removedClusters.map((cluster) => cluster.id),
            deletedAt,
          ),
        }),
      };
    });
  }, []);

  const setActiveProject = useCallback((id: string | null) => {
    setState((current) => ({ ...current, activeProjectId: id }));
  }, []);

  const addTask = useCallback((projectId: string, title: string) => {
    const now = Date.now();
    const task: Task = {
      id: generateId('task'),
      title,
      status: 'todo',
      createdAt: now,
    };
    setState((current) => ({
      ...current,
      projects: current.projects.map((project) =>
        project.id === projectId
          ? {
              ...project,
              updatedAt: now,
              tasks: [...project.tasks, task],
            }
          : project,
      ),
    }));
  }, []);

  const updateTaskStatus = useCallback(
    (projectId: string, taskId: string, status: TaskStatus) => {
      setState((current) => ({
        ...current,
        projects: current.projects.map((project) =>
          project.id === projectId
            ? {
                ...project,
                updatedAt: Date.now(),
                tasks: project.tasks.map((task) =>
                  task.id === taskId ? { ...task, status } : task,
                ),
              }
            : project,
        ),
      }));
    },
    [],
  );

  const deleteTask = useCallback((projectId: string, taskId: string) => {
    setState((current) => {
      const deletedAt = Date.now();
      return {
        ...current,
        projects: current.projects.map((project) =>
          project.id === projectId
            ? {
                ...project,
                updatedAt: deletedAt,
                tasks: project.tasks.filter((task) => task.id !== taskId),
              }
            : project,
        ),
        tombstones: mergeTombstones(current.tombstones, {
          tasks: createDeletionMarkers([taskId], deletedAt),
        }),
      };
    });
  }, []);

  const createNewConversation = useCallback((projectId: string | null) => {
    const id = generateId('conv');
    const conversation: Conversation = {
      id,
      title: 'New Session',
      projectId,
      updatedAt: Date.now(),
      messages: [],
    };

    setState((current) => ({
      ...current,
      conversations: [...current.conversations, conversation],
      activeConversationId: id,
    }));
    return id;
  }, []);

  const setActiveConversation = useCallback((id: string | null) => {
    setState((current) => ({ ...current, activeConversationId: id }));
  }, []);

  const addMessage = useCallback(
    (
      conversationId: string | null,
      message: Omit<Message, 'id' | 'createdAt'> & { id?: string },
    ) => {
      const targetId = conversationId ?? generateId('conv');
      const newMessage: Message = {
        ...message,
        id: message.id ?? generateId('msg'),
        createdAt: Date.now(),
      };

      setState((current) => {
        const existing = current.conversations.find(
          (conversation) => conversation.id === targetId,
        );
        const conversation: Conversation =
          existing ??
          ({
            id: targetId,
            title: 'New Session',
            projectId: current.activeProjectId,
            updatedAt: Date.now(),
            messages: [],
          } satisfies Conversation);
        const messages = [...conversation.messages, newMessage];
        const updated: Conversation = {
          ...conversation,
          title:
            messages.length === 1 && newMessage.role === 'user'
              ? `${newMessage.content.slice(0, 30)}${newMessage.content.length > 30 ? '…' : ''}`
              : conversation.title,
          updatedAt: Date.now(),
          messages,
        };

        return {
          ...current,
          conversations: existing
            ? current.conversations.map((item) =>
                item.id === targetId ? updated : item,
              )
            : [...current.conversations, updated],
          activeConversationId: targetId,
        };
      });

      return targetId;
    },
    [],
  );

  const updateMessage = useCallback(
    (
      conversationId: string,
      messageId: string,
      updates: Partial<Message>,
    ) => {
      setState((current) => ({
        ...current,
        conversations: current.conversations.map((conversation) =>
          conversation.id === conversationId
            ? {
                ...conversation,
                updatedAt: Date.now(),
                messages: conversation.messages.map((message) =>
                  message.id === messageId
                    ? { ...message, ...updates }
                    : message,
                ),
              }
            : conversation,
        ),
      }));
    },
    [],
  );

  const clearConversation = useCallback((id: string) => {
    setState((current) => {
      const deletedAt = Date.now();
      const conversation = current.conversations.find(
        (item) => item.id === id,
      );
      const cleared = clearConversationKnowledge(current, id);
      const liveClusterIds = new Set(
        cleared.clusters.map((cluster) => cluster.id),
      );
      const removedClusterIds = current.clusters
        .filter((cluster) => !liveClusterIds.has(cluster.id))
        .map((cluster) => cluster.id);

      return {
        ...cleared,
        conversations: cleared.conversations.map((item) =>
          item.id === id ? { ...item, updatedAt: deletedAt } : item,
        ),
        clusters: cleared.clusters.map((cluster) =>
          cluster.sources.length !==
          current.clusters.find((item) => item.id === cluster.id)?.sources
            .length
            ? { ...cluster, lastUpdatedAt: deletedAt }
            : cluster,
        ),
        tombstones: mergeTombstones(current.tombstones, {
          messages: createDeletionMarkers(
            conversation?.messages.map((message) => message.id) ?? [],
            deletedAt,
          ),
          clusters: createDeletionMarkers(removedClusterIds, deletedAt),
        }),
      };
    });
  }, []);

  const applyKnowledgeInsights = useCallback(
    (
      conversation: Pick<Conversation, 'id' | 'title' | 'projectId'>,
      insights: KnowledgeInsight[],
    ) => {
      const now = Date.now();
      setState((current) =>
        applyKnowledgeInsightsToState({
          state: current,
          conversation,
          insights,
          now,
          generateId,
        }),
      );
    },
    [],
  );

  const renameKnowledgeCluster = useCallback(
    (clusterId: string, label: string) => {
      const cleanedLabel = label.trim();
      if (!cleanedLabel) return;
      const updatedAt = Date.now();

      setState((current) => {
        const cluster = current.clusters.find(
          (item) => item.id === clusterId,
        );
        if (!cluster) return current;

        const conflictsWithExistingLabel = current.clusters.some(
          (item) =>
            item.id !== clusterId &&
            item.projectId === cluster.projectId &&
            normalizeLabel(item.label) === normalizeLabel(cleanedLabel),
        );
        if (conflictsWithExistingLabel) return current;

        return {
          ...current,
          clusters: current.clusters.map((item) =>
            item.id === clusterId
              ? { ...item, label: cleanedLabel, lastUpdatedAt: updatedAt }
              : item,
          ),
        };
      });
    },
    [],
  );

  const deleteKnowledgeCluster = useCallback((clusterId: string) => {
    const updatedAt = Date.now();

    setState((current) => {
      const cluster = current.clusters.find(
        (item) => item.id === clusterId,
      );
      if (!cluster) return current;

      const clusters = reconcileKnowledgeLinks(
        current.clusters.filter((item) => item.id !== clusterId),
      );
      return {
        ...current,
        clusters,
        projects: updateProjectKnowledgeSourceCount(
          current.projects,
          clusters,
          cluster.projectId,
          updatedAt,
        ),
        tombstones: mergeTombstones(current.tombstones, {
          clusters: createDeletionMarkers([clusterId], updatedAt),
        }),
      };
    });
  }, []);

  const mergeKnowledgeClusters = useCallback(
    (targetClusterId: string, sourceClusterId: string) => {
      if (targetClusterId === sourceClusterId) return;
      const updatedAt = Date.now();

      setState((current) => {
        const target = current.clusters.find(
          (item) => item.id === targetClusterId,
        );
        const source = current.clusters.find(
          (item) => item.id === sourceClusterId,
        );
        if (!target || !source || target.projectId !== source.projectId) {
          return current;
        }

        const mergedTarget: KnowledgeCluster = {
          ...target,
          sources: mergeKnowledgeSources(target.sources, source.sources),
          links: [...new Set([...target.links, ...source.links])].filter(
            (linkId) => linkId !== target.id && linkId !== source.id,
          ),
          strength: Math.max(target.strength, source.strength),
          mentionCount: target.mentionCount + source.mentionCount,
          lastUpdatedAt: updatedAt,
        };

        const clusters = reconcileKnowledgeLinks(
          current.clusters
            .filter((item) => item.id !== sourceClusterId)
            .map((item) => {
              if (item.id === targetClusterId) return mergedTarget;
              return {
                ...item,
                links: item.links.map((linkId) =>
                  linkId === sourceClusterId ? targetClusterId : linkId,
                ),
              };
            }),
        );

        return {
          ...current,
          clusters,
          projects: updateProjectKnowledgeSourceCount(
            current.projects,
            clusters,
            target.projectId,
            updatedAt,
          ),
          tombstones: mergeTombstones(current.tombstones, {
            clusters: createDeletionMarkers(
              [sourceClusterId],
              updatedAt,
            ),
          }),
        };
      });
    },
    [],
  );

  const value = useMemo<VenomContextType>(
    () => ({
      state,
      isReady,
      syncStatus,
      lastSyncedAt,
      hasPendingLegacyImport,
      importDeviceWorkspace,
      startFreshWorkspace,
      addProject,
      updateProject,
      deleteProject,
      setActiveProject,
      addTask,
      updateTaskStatus,
      deleteTask,
      addMessage,
      updateMessage,
      setActiveConversation,
      clearConversation,
      createNewConversation,
      applyKnowledgeInsights,
      renameKnowledgeCluster,
      deleteKnowledgeCluster,
      mergeKnowledgeClusters,
    }),
    [
      addMessage,
      addProject,
      addTask,
      applyKnowledgeInsights,
      clearConversation,
      createNewConversation,
      deleteProject,
      deleteTask,
      hasPendingLegacyImport,
      importDeviceWorkspace,
      isReady,
      lastSyncedAt,
      mergeKnowledgeClusters,
      renameKnowledgeCluster,
      setActiveConversation,
      setActiveProject,
      state,
      startFreshWorkspace,
      syncStatus,
      deleteKnowledgeCluster,
      updateMessage,
      updateProject,
      updateTaskStatus,
    ],
  );

  return (
    <VenomContext.Provider value={value}>{children}</VenomContext.Provider>
  );
}

function updateProjectKnowledgeSourceCount(
  projects: Project[],
  clusters: KnowledgeCluster[],
  projectId: string | null,
  updatedAt: number,
) {
  if (!projectId) return projects;

  const conversationIds = new Set(
    clusters
      .filter((cluster) => cluster.projectId === projectId)
      .flatMap((cluster) =>
        cluster.sources.map((source) => source.conversationId),
      ),
  );

  return projects.map((project) =>
    project.id === projectId
      ? {
          ...project,
          sourceCount: conversationIds.size,
          updatedAt,
        }
      : project,
  );
}

function reconcileKnowledgeLinks(clusters: KnowledgeCluster[]) {
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

function mergeKnowledgeSources(
  targetSources: KnowledgeSource[],
  sourceSources: KnowledgeSource[],
) {
  const sourcesByConversation = new Map<string, KnowledgeSource>();

  for (const source of [...targetSources, ...sourceSources]) {
    const existing = sourcesByConversation.get(source.conversationId);
    if (!existing) {
      sourcesByConversation.set(source.conversationId, {
        ...source,
        messageIds: [...new Set(source.messageIds)],
      });
      continue;
    }

    const newerSource =
      source.updatedAt >= existing.updatedAt ? source : existing;
    sourcesByConversation.set(source.conversationId, {
      ...newerSource,
      messageIds: [...new Set([...existing.messageIds, ...source.messageIds])],
      updatedAt: Math.max(existing.updatedAt, source.updatedAt),
    });
  }

  return [...sourcesByConversation.values()].sort(
    (left, right) => right.updatedAt - left.updatedAt,
  );
}

export function useVenom() {
  const context = useContext(VenomContext);
  if (!context) {
    throw new Error('useVenom must be used within VenomProvider');
  }
  return context;
}