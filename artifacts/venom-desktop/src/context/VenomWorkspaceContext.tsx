/**
 * VenomWorkspaceProvider / useVenomWorkspace
 *
 * Browser sync layer for Venom Desktop. Uses Clerk cookie-based auth only
 * (no getToken, no Authorization headers). Persists state in a user-scoped
 * localStorage key. Implements the same revision/conflict/debounce/queue
 * semantics as the mobile VenomContext.
 */

import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useAuth } from '@clerk/react';
import {
  ApiError,
  getGetVenomWorkspaceQueryKey,
  saveVenomWorkspace,
  useGetVenomWorkspace,
  type VenomMessage,
  type VenomMessageStatus,
  type VenomConversationBlend,
  type VenomResponseMode,
  type VenomTask,
  type VenomTaskStatus,
  type VenomWorkspaceSnapshot,
} from '@workspace/api-client-react';
import {
  applyFiledClustersToState,
  applyKnowledgeInsightsToState,
  clearConversationKnowledge,
  createDefaultState,
  createDeletionMarkers,
  createEmptyTombstones,
  generateId,
  isWorkspaceState,
  mergeKnowledgeSources,
  mergeWorkspaceStates,
  mergeTombstones,
  normalizeLabel,
  normalizeModelPreferences,
  normalizeVoicePreferences,
  normalizeWorkspaceState,
  prepareWorkspaceStateForSave,
  reconcileKnowledgeLinks,
  stageIdForTaskStatus,
  updateProjectKnowledgeSourceCount,
  type Conversation,
  type KnowledgeCluster,
  type KnowledgeInsight,
  type KnowledgeSource,
  type ModelPreferences,
  type Project,
  type SyncStatus,
  type VenomModelId,
  type VoicePreferences,
  type WorkspaceState,
} from '@/lib/workspaceState';
import { IS_UI_TEST } from '@/lib/ui-test';

export type VenomWorkspaceContextType = {
  state: WorkspaceState;
  isReady: boolean;
  syncStatus: SyncStatus;
  lastSyncedAt: string | null;
  retrySync: () => void;
  refreshWorkspace: () => void;

  // Project ops
  setActiveProject: (id: string | null) => void;

  // Conversation ops
  setActiveConversation: (id: string | null) => void;
  createNewConversation: (projectId: string | null) => string;
  addMessage: (
    conversationId: string | null,
    message: Omit<VenomMessage, 'id' | 'createdAt'> & { id?: string },
  ) => string;
  updateMessage: (conversationId: string, messageId: string, updates: Partial<VenomMessage>) => void;
  clearConversation: (id: string) => void;

  // Task ops
  addTask: (projectId: string, title: string) => void;
  updateTaskStatus: (projectId: string, taskId: string, status: VenomTaskStatus) => void;
  deleteTask: (projectId: string, taskId: string) => void;

  // Knowledge ops
  applyKnowledgeInsights: (
    conversation: Pick<Conversation, 'id' | 'title' | 'projectId'>,
    insights: KnowledgeInsight[],
  ) => void;
  applyFiledKnowledge: (
    conversation: Pick<Conversation, 'id' | 'title' | 'projectId'>,
    filed: KnowledgeCluster[],
  ) => void;
  renameKnowledgeCluster: (clusterId: string, label: string) => void;
  deleteKnowledgeCluster: (clusterId: string) => void;
  mergeKnowledgeClusters: (targetClusterId: string, sourceClusterId: string) => void;

  // Response mode & blend prefs (per conversation, synced across devices)
  setConversationResponsePrefs: (
    conversationId: string,
    prefs: {
      responseMode?: VenomResponseMode;
      /** New pad position; null clears the stored blend. */
      blend?: VenomConversationBlend | null;
    },
  ) => void;

  // Model preference ops
  setModelPreferences: (updates: Partial<ModelPreferences>) => void;
  setActiveModelId: (modelId: VenomModelId) => void;

  // Voice preference ops (hands-free voice mode on the phone; synced account-wide)
  setVoicePreferences: (
    updates: Partial<Pick<VoicePreferences, 'presetId' | 'talkativeness'>>,
  ) => void;
};

const VenomWorkspaceContext = createContext<VenomWorkspaceContextType | null>(null);

// ---------------------------------------------------------------------------
// Storage helpers – browser localStorage, user-scoped
// ---------------------------------------------------------------------------

const STORAGE_KEY_PREFIX = '@venom_desktop_v1:';
const storageKeyFor = (userId: string) => `${STORAGE_KEY_PREFIX}${userId}`;

function readLocalState(userId: string): WorkspaceState | null {
  try {
    const raw = localStorage.getItem(storageKeyFor(userId));
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (isWorkspaceState(parsed)) return normalizeWorkspaceState(parsed);
    return null;
  } catch {
    return null;
  }
}

function writeLocalState(userId: string, state: WorkspaceState): void {
  try {
    localStorage.setItem(storageKeyFor(userId), JSON.stringify(state));
  } catch {
    // localStorage full – non-fatal
  }
}

// ---------------------------------------------------------------------------
// Sync controller
// ---------------------------------------------------------------------------

type SyncController = {
  /** The userId this controller was created for */
  userId: string;
  inFlight: boolean;
  queued: WorkspaceState | null;
};

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export function VenomWorkspaceProvider({ children }: { children: React.ReactNode }) {
  const { userId: authenticatedUserId } = useAuth();
  const userId = IS_UI_TEST ? UI_TEST_USER_ID : authenticatedUserId;

  // ── core state ────────────────────────────────────────────────────────────
  const [state, setState] = useState<WorkspaceState>(createInitialWorkspaceState);
  const [isReady, setIsReady] = useState(IS_UI_TEST);
  const [syncStatus, setSyncStatus] = useState<SyncStatus>(
    IS_UI_TEST ? 'synced' : 'loading',
  );
  const [lastSyncedAt, setLastSyncedAt] = useState<string | null>(null);

  // ── refs that must survive re-renders without triggering them ─────────────
  const latestStateRef = useRef(state);
  latestStateRef.current = state;

  const revisionRef = useRef(0);
  /** The serialized state that was last successfully pushed to the cloud */
  const lastSyncedSerialRef = useRef('');
  /** userId of the account whose state we've fully initialised */
  const hydratedUserRef = useRef<string | null>(null);
  /** Mirror of userId so we can read it synchronously inside callbacks */
  const activeUserIdRef = useRef<string | null>(userId ?? null);

  const syncControllerRef = useRef<SyncController | null>(null);

  // ── reset on user change ──────────────────────────────────────────────────
  // Run this synchronously during render so stale completions are rejected
  // immediately when the userId reference changes.
  if (activeUserIdRef.current !== (userId ?? null)) {
    activeUserIdRef.current = userId ?? null;
    // Invalidate any in-flight controller so its completion is rejected
    syncControllerRef.current = null;
  }

  // ── cloud query – enabled only when signed in ─────────────────────────────
  const workspaceQuery = useGetVenomWorkspace({
    query: {
      enabled: Boolean(userId) && !IS_UI_TEST,
      queryKey: [...getGetVenomWorkspaceQueryKey(), userId ?? 'signed-out'],
      retry: 2,
      refetchOnMount: 'always',
    },
  });

  // ── flush state to cloud ─────────────────────────────────────────────────
  const flushCloudState = useCallback(
    async (nextState: WorkspaceState, controller: SyncController) => {
      const syncUserId = controller.userId;

      controller.queued = nextState;
      if (controller.inFlight) return;
      controller.inFlight = true;

      try {
        let candidate: WorkspaceState | null = controller.queued;
        controller.queued = null;
        let conflictCount = 0;

        while (
          candidate !== null &&
          syncControllerRef.current === controller &&
          activeUserIdRef.current === syncUserId
        ) {
          const prepared = prepareWorkspaceStateForSave(candidate);
          if (!prepared.success) {
            controller.queued = null;
            setSyncStatus('too_large');
            candidate = null;
            continue;
          }
          const stateToSave = prepared.state;
          const serialized = JSON.stringify(stateToSave);
          setSyncStatus('syncing');

          try {
            // Staleness guard: check after any await
            if (
              syncControllerRef.current !== controller ||
              activeUserIdRef.current !== syncUserId
            ) {
              return;
            }

            const saved = await saveVenomWorkspace({
              state: stateToSave,
              baseRevision: revisionRef.current,
            });

            if (
              syncControllerRef.current !== controller ||
              activeUserIdRef.current !== syncUserId
            ) {
              return;
            }

            revisionRef.current = saved.revision;
            lastSyncedSerialRef.current = serialized;
            setLastSyncedAt(saved.updatedAt);
            setSyncStatus('synced');
            writeLocalState(syncUserId, stateToSave);

            const queued = controller.queued;
            controller.queued = null;
            candidate = queued ? mergeWorkspaceStates(stateToSave, queued) : null;
          } catch (err) {
            if (err instanceof ApiError && err.status === 413) {
              controller.queued = null;
              setSyncStatus('too_large');
              candidate = null;
              continue;
            }

            if (err instanceof ApiError && err.status === 409) {
              const latest = err.data as VenomWorkspaceSnapshot | null;
              if (latest?.state && conflictCount < 4) {
                conflictCount += 1;
                const mostRecentDevice = controller.queued ?? latestStateRef.current;
                controller.queued = null;
                candidate = mergeWorkspaceStates(
                  normalizeWorkspaceState(latest.state),
                  mostRecentDevice,
                );
                revisionRef.current = latest.revision;
                latestStateRef.current = candidate;
                setState(candidate);
                setLastSyncedAt(latest.updatedAt);
                continue;
              }
            }

            const isOffline =
              typeof navigator !== 'undefined' && navigator.onLine === false;
            setSyncStatus(isOffline || err instanceof TypeError ? 'offline' : 'error');
            controller.queued = null;
            candidate = null;
          }
        }
      } finally {
        controller.inFlight = false;
      }
    },
    [],
  );

  // ── initialise / reset when userId changes ────────────────────────────────
  useEffect(() => {
    if (IS_UI_TEST) return;

    if (!userId) {
      // Signed out – reset everything immediately
      hydratedUserRef.current = null;
      revisionRef.current = 0;
      lastSyncedSerialRef.current = '';
      syncControllerRef.current = null;
      setState(createDefaultState());
      setIsReady(false);
      setSyncStatus('loading');
      setLastSyncedAt(null);
      return;
    }

    // New user account – reset in-memory state before we load their data
    hydratedUserRef.current = null;
    revisionRef.current = 0;
    lastSyncedSerialRef.current = '';
    syncControllerRef.current = null;
    setState(createDefaultState());
    setIsReady(false);
    setSyncStatus('loading');
    setLastSyncedAt(null);
  }, [userId]);

  // ── hydrate once cloud query settles ─────────────────────────────────────
  useEffect(() => {
    if (IS_UI_TEST) return;

    if (
      !userId ||
      hydratedUserRef.current === userId ||
      workspaceQuery.isPending
    ) {
      return;
    }

    // Mark as hydrated so we don't run this again for the same user
    hydratedUserRef.current = userId;

    // Ensure a controller exists for this user
    if (!syncControllerRef.current || syncControllerRef.current.userId !== userId) {
      syncControllerRef.current = { userId, inFlight: false, queued: null };
    }
    const controller = syncControllerRef.current;

    if (workspaceQuery.isSuccess) {
      const cloud = workspaceQuery.data;
      revisionRef.current = cloud.revision;
      setLastSyncedAt(cloud.updatedAt);
      setIsReady(true);

      if (cloud.state) {
        // A browser change is stored locally before the debounced cloud write.
        // Merge it even when the cloud already has a snapshot so a refresh
        // during that debounce cannot discard a just-created message, task, or
        // deletion tombstone.
        const restoredCloud = normalizeWorkspaceState(cloud.state);
        const local = readLocalState(userId);
        const restored = local
          ? mergeWorkspaceStates(restoredCloud, local)
          : restoredCloud;
        const cloudSerial = JSON.stringify(restoredCloud);
        const restoredSerial = JSON.stringify(restored);

        lastSyncedSerialRef.current = cloudSerial;
        latestStateRef.current = restored;
        setState(restored);
        writeLocalState(userId, restored);
        setSyncStatus(restoredSerial === cloudSerial ? 'synced' : 'pending');

        if (restoredSerial !== cloudSerial) {
          void flushCloudState(restored, controller);
        }
        return;
      }

      // Cloud empty – try localStorage then fall back to default
      const local = readLocalState(userId);
      const seed = local ?? createDefaultState();
      lastSyncedSerialRef.current = JSON.stringify(seed);
      latestStateRef.current = seed;
      setState(seed);
      setSyncStatus('syncing');
      void flushCloudState(seed, controller);
      return;
    }

    // Cloud fetch failed (offline / error) – use localStorage
    const local = readLocalState(userId);
    const seed = local ?? createDefaultState();
    latestStateRef.current = seed;
    setState(seed);
    lastSyncedSerialRef.current = JSON.stringify(seed);
    setSyncStatus('offline');
    setIsReady(true);
  }, [
    flushCloudState,
    userId,
    workspaceQuery.data,
    workspaceQuery.isPending,
    workspaceQuery.isSuccess,
  ]);

  // ── browser-test persistence ─────────────────────────────────────────────
  // The UI-test build has no account and no cloud sync, but reloading must
  // still keep the session. Mirror state into the same local store the cloud
  // path writes through, so a refresh rehydrates rather than resets.
  useEffect(() => {
    if (!IS_UI_TEST) return;
    writeLocalState(UI_TEST_USER_ID, state);
  }, [state]);

  // ── debounced sync on state changes ──────────────────────────────────────
  useEffect(() => {
    if (IS_UI_TEST) return;
    if (!isReady || !userId || hydratedUserRef.current !== userId) return;

    const serialized = JSON.stringify(state);

    // Always persist locally
    writeLocalState(userId, state);

    // Only push to cloud when state actually changed
    if (serialized === lastSyncedSerialRef.current) return;

    setSyncStatus('pending');
    const timeout = setTimeout(() => {
      if (!syncControllerRef.current || syncControllerRef.current.userId !== userId) {
        syncControllerRef.current = { userId, inFlight: false, queued: null };
      }
      void flushCloudState(state, syncControllerRef.current);
    }, 700);

    return () => clearTimeout(timeout);
  }, [flushCloudState, isReady, state, userId]);

  // ── retrySync ─────────────────────────────────────────────────────────────
  const retrySync = useCallback(() => {
    if (!userId || !isReady) return;
    if (!syncControllerRef.current || syncControllerRef.current.userId !== userId) {
      syncControllerRef.current = { userId, inFlight: false, queued: null };
    }
    void flushCloudState(latestStateRef.current, syncControllerRef.current);
  }, [flushCloudState, isReady, userId]);

  // ── refreshWorkspace ──────────────────────────────────────────────────────
  const refreshWorkspace = useCallback(() => {
    if (!userId || !isReady) return;
    const refreshUserId = userId;

    void workspaceQuery.refetch().then((result) => {
      if (
        activeUserIdRef.current !== refreshUserId ||
        hydratedUserRef.current !== refreshUserId
      ) {
        return;
      }

      if (!result.data) {
        const isOffline =
          typeof navigator !== 'undefined' && navigator.onLine === false;
        setSyncStatus(isOffline ? 'offline' : 'error');
        return;
      }

      const cloud = result.data;
      revisionRef.current = cloud.revision;
      setLastSyncedAt(cloud.updatedAt);

      if (!cloud.state) {
        retrySync();
        return;
      }

      const cloudState = normalizeWorkspaceState(cloud.state);
      const localState = latestStateRef.current;
      const localHasChanges =
        JSON.stringify(localState) !== lastSyncedSerialRef.current;
      const nextState = localHasChanges
        ? mergeWorkspaceStates(cloudState, localState)
        : cloudState;

      latestStateRef.current = nextState;
      setState(nextState);
      lastSyncedSerialRef.current = JSON.stringify(cloudState);
      writeLocalState(refreshUserId, nextState);

      if (JSON.stringify(nextState) === lastSyncedSerialRef.current) {
        setSyncStatus('synced');
      } else {
        setSyncStatus('pending');
      }
    });
  }, [isReady, retrySync, userId, workspaceQuery]);

  // ── state mutation helpers ────────────────────────────────────────────────

  const setActiveProject = useCallback((id: string | null) => {
    setState((current) => ({ ...current, activeProjectId: id }));
  }, []);

  const setActiveConversation = useCallback((id: string | null) => {
    setState((current) => ({ ...current, activeConversationId: id }));
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

  const addMessage = useCallback(
    (
      conversationId: string | null,
      message: Omit<VenomMessage, 'id' | 'createdAt'> & { id?: string },
    ) => {
      const targetId = conversationId ?? generateId('conv');
      const newMessage: VenomMessage = {
        ...message,
        id: message.id ?? generateId('msg'),
        createdAt: Date.now(),
      };

      setState((current) => {
        const existing = current.conversations.find((c) => c.id === targetId);
        const conversation: Conversation = existing ?? {
          id: targetId,
          title: 'New Session',
          projectId: current.activeProjectId,
          updatedAt: Date.now(),
          messages: [],
        };
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
            ? current.conversations.map((c) => (c.id === targetId ? updated : c))
            : [...current.conversations, updated],
          activeConversationId: targetId,
        };
      });

      return targetId;
    },
    [],
  );

  const updateMessage = useCallback(
    (conversationId: string, messageId: string, updates: Partial<VenomMessage>) => {
      setState((current) => ({
        ...current,
        conversations: current.conversations.map((c) =>
          c.id === conversationId
            ? {
                ...c,
                updatedAt: Date.now(),
                messages: c.messages.map((m) =>
                  m.id === messageId ? { ...m, ...updates } : m,
                ),
              }
            : c,
        ),
      }));
    },
    [],
  );

  const clearConversation = useCallback((id: string) => {
    setState((current) => {
      const deletedAt = Date.now();
      const conversation = current.conversations.find((c) => c.id === id);
      const cleared = clearConversationKnowledge(current, id);
      const liveClusterIds = new Set(cleared.clusters.map((c) => c.id));
      const removedClusterIds = current.clusters
        .filter((c) => !liveClusterIds.has(c.id))
        .map((c) => c.id);

      return {
        ...cleared,
        conversations: cleared.conversations.map((c) =>
          c.id === id ? { ...c, updatedAt: deletedAt } : c,
        ),
        clusters: cleared.clusters.map((c) => {
          const prevLen = current.clusters.find((x) => x.id === c.id)?.sources.length;
          return c.sources.length !== prevLen ? { ...c, lastUpdatedAt: deletedAt } : c;
        }),
        tombstones: mergeTombstones(current.tombstones, {
          messages: createDeletionMarkers(
            conversation?.messages.map((m) => m.id) ?? [],
            deletedAt,
          ),
          clusters: createDeletionMarkers(removedClusterIds, deletedAt),
        }),
      };
    });
  }, []);

  const addTask = useCallback((projectId: string, title: string) => {
    const now = Date.now();
    setState((current) => ({
      ...current,
      projects: current.projects.map((project) => {
        if (project.id !== projectId) return project;
        const stageId = stageIdForTaskStatus(project, 'todo');
        if (!stageId) return project;
        const position =
          Math.max(
            -1,
            ...project.tasks
              .filter((task) => task.stageId === stageId)
              .map((task) => task.position),
          ) + 1;
        const task: VenomTask = {
          id: generateId('task'),
          title,
          stageId,
          position,
          createdAt: now,
          updatedAt: now,
          values: {},
        };
        return { ...project, updatedAt: now, tasks: [...project.tasks, task] };
      }),
    }));
  }, []);

  const updateTaskStatus = useCallback(
    (projectId: string, taskId: string, status: VenomTaskStatus) => {
      setState((current) => {
        const updatedAt = Date.now();
        return {
          ...current,
          projects: current.projects.map((project) => {
            if (project.id !== projectId) return project;
            const stageId = stageIdForTaskStatus(project, status);
            if (!stageId) return project;
            const task = project.tasks.find((candidate) => candidate.id === taskId);
            if (!task || task.stageId === stageId) return project;
            const position =
              Math.max(
                -1,
                ...project.tasks
                  .filter(
                    (candidate) =>
                      candidate.id !== taskId && candidate.stageId === stageId,
                  )
                  .map((candidate) => candidate.position),
              ) + 1;
            return {
              ...project,
              updatedAt,
              tasks: project.tasks.map((candidate) =>
                candidate.id === taskId
                  ? { ...candidate, stageId, position, updatedAt }
                  : candidate,
              ),
            };
          }),
        };
      });
    },
    [],
  );

  const deleteTask = useCallback((projectId: string, taskId: string) => {
    setState((current) => {
      const deletedAt = Date.now();
      return {
        ...current,
        projects: current.projects.map((p) =>
          p.id === projectId
            ? { ...p, updatedAt: deletedAt, tasks: p.tasks.filter((t) => t.id !== taskId) }
            : p,
        ),
        tombstones: mergeTombstones(current.tombstones, {
          tasks: createDeletionMarkers([taskId], deletedAt),
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
        applyKnowledgeInsightsToState({ state: current, conversation, insights, now, generateId }),
      );
    },
    [],
  );

  const applyFiledKnowledge = useCallback(
    (
      conversation: Pick<Conversation, 'id' | 'title' | 'projectId'>,
      filed: KnowledgeCluster[],
    ) => {
      const now = Date.now();
      setState((current) =>
        applyFiledClustersToState({ state: current, conversation, filed, now }),
      );
    },
    [],
  );

  const renameKnowledgeCluster = useCallback((clusterId: string, label: string) => {
    const cleanedLabel = label.trim();
    if (!cleanedLabel) return;
    const updatedAt = Date.now();

    setState((current) => {
      const cluster = current.clusters.find((c) => c.id === clusterId);
      if (!cluster) return current;

      const conflicts = current.clusters.some(
        (c) =>
          c.id !== clusterId &&
          c.projectId === cluster.projectId &&
          normalizeLabel(c.label) === normalizeLabel(cleanedLabel),
      );
      if (conflicts) return current;

      return {
        ...current,
        clusters: current.clusters.map((c) =>
          c.id === clusterId ? { ...c, label: cleanedLabel, lastUpdatedAt: updatedAt } : c,
        ),
      };
    });
  }, []);

  const deleteKnowledgeCluster = useCallback((clusterId: string) => {
    const updatedAt = Date.now();
    setState((current) => {
      const cluster = current.clusters.find((c) => c.id === clusterId);
      if (!cluster) return current;

      const clusters = reconcileKnowledgeLinks(
        current.clusters.filter((c) => c.id !== clusterId),
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

  const setConversationResponsePrefs = useCallback(
    (
      conversationId: string,
      prefs: {
        responseMode?: VenomResponseMode;
        blend?: VenomConversationBlend | null;
      },
    ) => {
      setState((current) => {
        const conversation = current.conversations.find(
          (item) => item.id === conversationId,
        );
        if (!conversation) return current;

        // The preference block keeps its own clock (modeUpdatedAt) so a mode
        // change on one device never outranks newer chat content elsewhere:
        // conversation.updatedAt stays untouched here on purpose.
        const next: Conversation = { ...conversation, modeUpdatedAt: Date.now() };
        if (prefs.responseMode !== undefined) next.responseMode = prefs.responseMode;
        if (prefs.blend === null) {
          delete next.blend;
        } else if (prefs.blend !== undefined) {
          next.blend = prefs.blend;
        }
        return {
          ...current,
          conversations: current.conversations.map((item) =>
            item.id === conversationId ? next : item,
          ),
        };
      });
    },
    [],
  );

  const setModelPreferences = useCallback((updates: Partial<ModelPreferences>) => {
    setState((current) => {
      const merged = normalizeModelPreferences({
        ...current.modelPreferences,
        ...updates,
        updatedAt: Date.now(),
      });
      return { ...current, modelPreferences: merged };
    });
  }, []);

  const setActiveModelId = useCallback((modelId: VenomModelId) => {
    setState((current) => {
      const prefs = current.modelPreferences;
      if (!prefs?.enabledModelIds.includes(modelId)) return current;
      return {
        ...current,
        modelPreferences: normalizeModelPreferences({
          ...prefs,
          activeModelId: modelId,
          updatedAt: Date.now(),
        }),
      };
    });
  }, []);

  /**
   * Voice preferences (speaking voice + talkativeness) are one synced block
   * with a single clock: every write stamps a fresh updatedAt so the freshest
   * device wins the cross-device merge, and normalization keeps unknown
   * values from ever entering the snapshot.
   */
  const setVoicePreferences = useCallback(
    (updates: Partial<Pick<VoicePreferences, 'presetId' | 'talkativeness'>>) => {
      setState((current) => ({
        ...current,
        voicePreferences: normalizeVoicePreferences({
          ...current.voicePreferences,
          ...updates,
          updatedAt: Date.now(),
        }),
      }));
    },
    [],
  );

  const mergeKnowledgeClusters = useCallback(
    (targetClusterId: string, sourceClusterId: string) => {
      if (targetClusterId === sourceClusterId) return;
      const updatedAt = Date.now();

      setState((current) => {
        const target = current.clusters.find((c) => c.id === targetClusterId);
        const source = current.clusters.find((c) => c.id === sourceClusterId);
        if (!target || !source || target.projectId !== source.projectId) return current;

        const mergedTarget: KnowledgeCluster = {
          ...target,
          sources: mergeKnowledgeSources(target.sources, source.sources),
          links: [...new Set([...target.links, ...source.links])].filter(
            (id) => id !== target.id && id !== source.id,
          ),
          strength: Math.max(target.strength, source.strength),
          mentionCount: target.mentionCount + source.mentionCount,
          lastUpdatedAt: updatedAt,
        };

        const clusters = reconcileKnowledgeLinks(
          current.clusters
            .filter((c) => c.id !== sourceClusterId)
            .map((c) => {
              if (c.id === targetClusterId) return mergedTarget;
              return {
                ...c,
                links: c.links.map((id) => (id === sourceClusterId ? targetClusterId : id)),
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
            clusters: createDeletionMarkers([sourceClusterId], updatedAt),
          }),
        };
      });
    },
    [],
  );

  // ── memoised context value ────────────────────────────────────────────────
  const value = useMemo<VenomWorkspaceContextType>(
    () => ({
      state,
      isReady,
      syncStatus,
      lastSyncedAt,
      retrySync,
      refreshWorkspace,
      setActiveProject,
      setActiveConversation,
      createNewConversation,
      addMessage,
      updateMessage,
      clearConversation,
      addTask,
      updateTaskStatus,
      deleteTask,
      applyKnowledgeInsights,
      applyFiledKnowledge,
      renameKnowledgeCluster,
      deleteKnowledgeCluster,
      mergeKnowledgeClusters,
      setConversationResponsePrefs,
      setModelPreferences,
      setActiveModelId,
      setVoicePreferences,
    }),
    [
      state,
      isReady,
      syncStatus,
      lastSyncedAt,
      retrySync,
      refreshWorkspace,
      setActiveProject,
      setActiveConversation,
      createNewConversation,
      addMessage,
      updateMessage,
      clearConversation,
      addTask,
      updateTaskStatus,
      deleteTask,
      applyKnowledgeInsights,
      applyFiledKnowledge,
      renameKnowledgeCluster,
      deleteKnowledgeCluster,
      mergeKnowledgeClusters,
      setConversationResponsePrefs,
      setModelPreferences,
      setActiveModelId,
      setVoicePreferences,
    ],
  );

  return (
    <VenomWorkspaceContext.Provider value={value}>
      {children}
    </VenomWorkspaceContext.Provider>
  );
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useVenomWorkspace(): VenomWorkspaceContextType {
  const context = useContext(VenomWorkspaceContext);
  if (!context) {
    throw new Error('useVenomWorkspace must be used within VenomWorkspaceProvider');
  }
  return context;
}
export const UI_TEST_USER_ID = 'venom-desktop-ui-test';

function createInitialWorkspaceState(): WorkspaceState {
  const state = createDefaultState();
  if (!IS_UI_TEST) return state;

  const brainFixture = new URLSearchParams(window.location.search).get(
    'brainFixture',
  );
  if (brainFixture === 'sparse') {
    const clusterIds = new Set(state.clusters.slice(0, 2).map(({ id }) => id));
    return {
      ...state,
      clusters: state.clusters.slice(0, 2).map((cluster) => ({
        ...cluster,
        links: cluster.links.filter((id) => clusterIds.has(id)),
      })),
    };
  }

  // Browser tests sign nobody in, so there is no cloud snapshot to hydrate
  // from. Read the same local mirror a signed-in account keeps, so a reload
  // restores the session instead of silently starting over.
  return readLocalState(UI_TEST_USER_ID) ?? state;
}
