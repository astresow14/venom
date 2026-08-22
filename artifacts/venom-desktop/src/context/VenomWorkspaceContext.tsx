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
  getVenomOrgProjects,
  getVenomOrgs,
  saveVenomWorkspace,
  useGetVenomWorkspace,
  type VenomOrg,
  type VenomOrgInviteForMe,
  type VenomOrgSharedProject,
  type VenomMessage,
  type VenomMessageStatus,
  type VenomConversationBlend,
  type VenomResponseMode,
  type VenomTask,
  type VenomVoiceModelPick,
  type VenomTaskStatus,
  type VenomWorkspaceSnapshot,
} from '@workspace/api-client-react';
import {
  applyFiledClustersToState,
  applyKnowledgeInsightsToState,
  applyOrgProjectSync,
  captureProjectRestoreSnapshot,
  clearConversationKnowledge,
  createDefaultBoardStages,
  createDefaultState,
  createDeletionMarkers,
  createEmptyTombstones,
  deleteProjectFromState,
  fileConversationToProjectInState,
  generateId,
  PROJECT_RESTORE_WINDOW_MS,
  restoreProjectFromSnapshot,
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
  type ProjectRestoreSnapshot,
  type SyncStatus,
  type VenomModelId,
  type VoicePreferences,
  type WorkspaceState,
} from '@/lib/workspaceState';
import { normalizeConversationVoiceModels } from '@/lib/blend';
import {
  IS_ORG_UI_TEST,
  IS_UI_TEST,
  IS_WORKSPACE_SYNC_UI_TEST,
} from '@/lib/ui-test';

// UI-test builds normally pin the workspace to a synced, local-only state so
// browser specs never wait on cloud endpoints. The workspace-sync opt-in
// (`?venomWorkspaceSyncTest=true`) lifts that pin: the real hydrate → debounce
// → save machinery runs against Playwright-stubbed endpoints, which is how
// failed-save UI (the chat device-only notice, the sidebar retry) is exercised
// end to end. Everything else about UI-test mode — the placeholder account,
// the quiet org machinery — stays as it is.
const SYNC_MACHINERY_STUBBED = IS_UI_TEST && !IS_WORKSPACE_SYNC_UI_TEST;

/** What the undo-delete affordance needs to render, nothing more. */
export type PendingProjectRestore = {
  /** Unique per deletion, so the UI can tell one pending undo from the next. */
  key: string;
  projectName: string;
  /** Epoch ms when the restore window closes and the snapshot is dropped. */
  expiresAt: number;
};
export type VenomWorkspaceContextType = {
  state: WorkspaceState;
  isReady: boolean;
  syncStatus: SyncStatus;
  lastSyncedAt: string | null;
  retrySync: () => void;
  refreshWorkspace: () => void;

  // Company (organization) state
  orgs: VenomOrg[];
  orgInvites: VenomOrgInviteForMe[];
  refreshOrgs: () => void;

  // Project ops
  setActiveProject: (id: string | null) => void;
  addProject: (
    project: Omit<
      Project,
      'id' | 'updatedAt' | 'tasks' | 'boardStages' | 'fieldDefinitions'
    >,
  ) => string;
  deleteProject: (id: string) => void;
  /**
   * Undo affordance for the most recent project deletion, alive only while
   * its restore window is open. The deletion itself is already committed —
   * tombstones and all — so this is a fresh-id rebuild, not a rollback.
   */
  pendingProjectRestore: PendingProjectRestore | null;
  /**
   * Rebuilds the just-deleted project from its snapshot under fresh ids and
   * returns to it. The tombstoned ids stay dead everywhere, so the deletion
   * still propagates while the restored copy syncs as new work. Returns
   * false when the restore window has already closed.
   */
  restoreDeletedProject: () => boolean;
  /** Drops the pending snapshot early (the undo control was dismissed). */
  dismissProjectRestore: () => void;

  // Conversation ops
  setActiveConversation: (id: string | null) => void;
  createNewConversation: (projectId: string | null) => string;
  fileConversationToProject: (conversationId: string, projectId: string) => void;
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
  /** "Keep personal" on an Unsorted item: clear the holding-area flag so the
   * concept joins the sorted personal Brain on every device. */
  markKnowledgeClusterSorted: (clusterId: string) => void;
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
      /** Per-voice model picks for verify; null clears them. */
      voiceModels?: VenomVoiceModelPick[] | null;
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
  const [isReady, setIsReady] = useState(SYNC_MACHINERY_STUBBED);
  const [syncStatus, setSyncStatus] = useState<SyncStatus>(
    SYNC_MACHINERY_STUBBED ? 'synced' : 'loading',
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

  // ── undo-delete window ────────────────────────────────────────────────────
  // The heavy captured content lives in a ref (it never drives rendering);
  // the small render-facing descriptor lives in state. One pending restore at
  // a time: a newer delete simply replaces the previous snapshot.
  const [pendingProjectRestore, setPendingProjectRestore] =
    useState<PendingProjectRestore | null>(null);
  const pendingRestoreRef = useRef<{
    key: string;
    userId: string | null;
    snapshot: ProjectRestoreSnapshot;
    fallbackProjectId: string | null;
  } | null>(null);
  const restoreExpiryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );

  /** Drops the pending snapshot iff it is still the one `key` names. */
  const clearPendingRestore = useCallback((key: string) => {
    if (pendingRestoreRef.current?.key === key) {
      pendingRestoreRef.current = null;
    }
    setPendingProjectRestore((current) =>
      current?.key === key ? null : current,
    );
  }, []);

  // ── reset on user change ──────────────────────────────────────────────────
  // Run this synchronously during render so stale completions are rejected
  // immediately when the userId reference changes.
  if (activeUserIdRef.current !== (userId ?? null)) {
    activeUserIdRef.current = userId ?? null;
    // Invalidate any in-flight controller so its completion is rejected
    syncControllerRef.current = null;
    // An undo window never crosses an account boundary.
    pendingRestoreRef.current = null;
  }

  // The render-phase reset above cannot touch React state; finish clearing
  // the undo affordance (and its timer) once the user change commits.
  useEffect(() => {
    setPendingProjectRestore((current) =>
      current && pendingRestoreRef.current === null ? null : current,
    );
  }, [userId]);
  useEffect(
    () => () => {
      if (restoreExpiryTimerRef.current !== null) {
        clearTimeout(restoreExpiryTimerRef.current);
      }
    },
    [],
  );

  // ── cloud query – enabled only when signed in ─────────────────────────────
  const workspaceQuery = useGetVenomWorkspace({
    query: {
      enabled: Boolean(userId) && !SYNC_MACHINERY_STUBBED,
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
    if (SYNC_MACHINERY_STUBBED) return;

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
    if (SYNC_MACHINERY_STUBBED) return;

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
  // path writes through, so a refresh rehydrates rather than resets. (When
  // the sync machinery runs — real sessions or the workspace-sync test mode —
  // the debounced sync effect below writes this mirror itself.)
  useEffect(() => {
    if (!SYNC_MACHINERY_STUBBED) return;
    writeLocalState(UI_TEST_USER_ID, state);
  }, [state]);

  // ── debounced sync on state changes ──────────────────────────────────────
  useEffect(() => {
    if (SYNC_MACHINERY_STUBBED) return;
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

  // ── company (organization) directory + shared-project mirroring ──────────
  const [orgs, setOrgs] = useState<VenomOrg[]>([]);
  const [orgInvites, setOrgInvites] = useState<VenomOrgInviteForMe[]>([]);
  const [orgsNonce, setOrgsNonce] = useState(0);

  /** Re-poll the company directory now (after invites, removals, …). */
  const refreshOrgs = useCallback(() => setOrgsNonce((nonce) => nonce + 1), []);

  useEffect(() => {
    if ((IS_UI_TEST && !IS_ORG_UI_TEST) || !userId) {
      setOrgs([]);
      setOrgInvites([]);
      return;
    }
    let cancelled = false;

    const tick = async () => {
      let directory;
      try {
        directory = await getVenomOrgs();
      } catch {
        // Offline or a transient failure: keep the last known memberships
        // instead of flapping the layer switcher.
        return;
      }
      if (cancelled || activeUserIdRef.current !== userId) return;
      setOrgs(directory.orgs);
      setOrgInvites(directory.invites);

      const sharedByOrg = new Map<string, VenomOrgSharedProject[]>();
      const fetchedOrgIds = new Set<string>();
      await Promise.all(
        directory.orgs.map(async (org) => {
          try {
            const list = await getVenomOrgProjects(org.id);
            sharedByOrg.set(org.id, list.projects);
            fetchedOrgIds.add(org.id);
          } catch {
            // Transient failure: this company's mirrors stay untouched.
          }
        }),
      );
      if (cancelled || activeUserIdRef.current !== userId) return;
      if (hydratedUserRef.current !== userId) return;
      setState((current) =>
        applyOrgProjectSync(current, directory.orgs, sharedByOrg, fetchedOrgIds),
      );
    };

    void tick();
    const interval = window.setInterval(() => void tick(), 25_000);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [userId, isReady, orgsNonce]);

  // Live revocation push. Removal, leaving elsewhere, or company deletion
  // must clear this device NOW, not at the next 25s poll — the Brain layer
  // renders company concepts from memory, so the poll gap is a real
  // disclosure window. The optimistic drop hides the company instantly
  // (cascading: layer falls back to My Brain, org state clears) and the
  // directory refetch that follows is authoritative — it also prunes the
  // mirrored shared projects. A dropped stream degrades to the poll; the
  // server remains the authorization fence either way.
  useEffect(() => {
    if ((IS_UI_TEST && !IS_ORG_UI_TEST) || !userId) return;
    const controller = new AbortController();
    let retryTimer: number | undefined;

    const handleFrame = (frame: string) => {
      const data = frame
        .split(/\r?\n/)
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trim())
        .join('');
      if (!data) return;
      try {
        const event: unknown = JSON.parse(data);
        if (
          typeof event === 'object' &&
          event !== null &&
          (event as { type?: unknown }).type === 'membership-changed' &&
          typeof (event as { orgId?: unknown }).orgId === 'string'
        ) {
          const endedOrgId = (event as { orgId: string }).orgId;
          setOrgs((current) =>
            current.some((org) => org.id === endedOrgId)
              ? current.filter((org) => org.id !== endedOrgId)
              : current,
          );
          refreshOrgs();
        }
      } catch {
        // Malformed frame: ignore it; polling remains the fallback.
      }
    };

    const connect = async (): Promise<void> => {
      try {
        const response = await fetch('/api/venom/orgs/events', {
          credentials: 'include',
          headers: { accept: 'text/event-stream' },
          cache: 'no-store',
          signal: controller.signal,
        });
        if (!response.ok || !response.body) {
          throw new Error(`events unavailable (${response.status})`);
        }
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const frames = buffer.split(/\r?\n\r?\n/);
          buffer = frames.pop() ?? '';
          for (const frame of frames) handleFrame(frame);
        }
      } catch {
        // Aborted (unmount) or transport failure; the retry below decides.
      }
      if (!controller.signal.aborted) {
        retryTimer = window.setTimeout(() => void connect(), 15_000);
      }
    };

    void connect();
    return () => {
      controller.abort();
      if (retryTimer !== undefined) window.clearTimeout(retryTimer);
    };
  }, [userId, refreshOrgs]);

  // ── state mutation helpers ────────────────────────────────────────────────

  // A chat session belongs to the project it was written in, so switching
  // project has to move the chat too: otherwise the next message is filed
  // under the project that was selected when the session started, not the one
  // on screen. A session with no project stays out of every project — it is
  // never adopted by the one being opened. Switching back reopens that
  // project's own latest session, and a project with no session yet starts
  // empty so the first message opens one under it. Mirrors the mobile app's
  // setActiveProject (artifacts/venom/context/VenomContext.tsx).
  const setActiveProject = useCallback((id: string | null) => {
    setState((current) => {
      if (current.activeProjectId === id) return current;

      const activeConversation = current.conversations.find(
        (conversation) => conversation.id === current.activeConversationId,
      );
      if (activeConversation && activeConversation.projectId === id) {
        return { ...current, activeProjectId: id };
      }

      const latestForProject = current.conversations.reduce<Conversation | null>(
        (latest, conversation) => {
          if (conversation.projectId !== id) return latest;
          if (!latest || conversation.updatedAt > latest.updatedAt) {
            return conversation;
          }
          return latest;
        },
        null,
      );

      return {
        ...current,
        activeProjectId: id,
        activeConversationId: latestForProject?.id ?? null,
      };
    });
  }, []);

  // Same creation the phone performs (artifacts/venom/context/VenomContext.tsx
  // addProject): fresh id, updatedAt stamp, and default board stages seeded
  // under the new id, so the project merges cleanly across devices. Returns
  // the id so callers can switch straight into the new project.
  const addProject = useCallback(
    (
      project: Omit<
        Project,
        'id' | 'updatedAt' | 'tasks' | 'boardStages' | 'fieldDefinitions'
      >,
    ) => {
      const id = generateId('proj');
      const now = Date.now();
      const newProject: Project = {
        ...project,
        id,
        updatedAt: now,
        tasks: [],
        boardStages: createDefaultBoardStages(id, now),
        fieldDefinitions: [],
      };
      setState((current) => ({
        ...current,
        projects: [...current.projects, newProject],
      }));
      return id;
    },
    [],
  );

  // Same deletion the phone performs: tombstones for the project and every
  // record inside it, plus the mobile landing rules (most recently updated
  // remaining project, or a fresh fallback workspace when none remain).
  //
  // The deletion commits immediately — the undo affordance works on a content
  // snapshot captured at the moment of the delete, and restoring rebuilds
  // that content under fresh ids. The tombstones written here are never
  // rolled back, so sync semantics stay exactly as they were.
  const deleteProject = useCallback((id: string) => {
    const project = latestStateRef.current.projects.find(
      (entry) => entry.id === id,
    );
    const deletedAt = Date.now();
    const key = generateId('restore');
    setState((current) => {
      const snapshot = captureProjectRestoreSnapshot(current, id, deletedAt);
      const next = deleteProjectFromState({
        state: current,
        projectId: id,
        deletedAt,
        generateId,
      });
      if (snapshot) {
        // Assigned inside the updater so the snapshot is exactly what this
        // delete removed. StrictMode double-invokes updaters; the last run
        // wins and matches the committed state (same precedent as genId
        // inside deleteProjectFromState).
        pendingRestoreRef.current = {
          key,
          userId: activeUserIdRef.current,
          snapshot,
          // Deleting the last project seeds the fallback workspace inside
          // deleteProjectFromState, so the only project left standing is it.
          fallbackProjectId: snapshot.wasLastProject
            ? (next.projects[0]?.id ?? null)
            : null,
        };
      }
      return next;
    });
    if (!project) return;
    setPendingProjectRestore({
      key,
      projectName: project.name,
      expiresAt: deletedAt + PROJECT_RESTORE_WINDOW_MS,
    });
    if (restoreExpiryTimerRef.current !== null) {
      clearTimeout(restoreExpiryTimerRef.current);
    }
    restoreExpiryTimerRef.current = setTimeout(() => {
      restoreExpiryTimerRef.current = null;
      clearPendingRestore(key);
    }, PROJECT_RESTORE_WINDOW_MS);
  }, [clearPendingRestore]);

  const restoreDeletedProject = useCallback((): boolean => {
    const pending = pendingRestoreRef.current;
    if (!pending) return false;
    // An undo belongs to the account that deleted; never restore across a
    // sign-out/sign-in boundary, and never after the window lapsed.
    if (
      pending.userId !== activeUserIdRef.current ||
      Date.now() >= pending.snapshot.deletedAt + PROJECT_RESTORE_WINDOW_MS
    ) {
      clearPendingRestore(pending.key);
      return false;
    }
    clearPendingRestore(pending.key);
    setState(
      (current) =>
        restoreProjectFromSnapshot({
          state: current,
          snapshot: pending.snapshot,
          restoredAt: Date.now(),
          generateId,
          fallbackProjectId: pending.fallbackProjectId,
        }).state,
    );
    return true;
  }, [clearPendingRestore]);

  const dismissProjectRestore = useCallback(() => {
    const pending = pendingRestoreRef.current;
    if (pending) clearPendingRestore(pending.key);
  }, [clearPendingRestore]);

  const setActiveConversation = useCallback((id: string | null) => {
    setState((current) => ({ ...current, activeConversationId: id }));
  }, []);

  // A session with no project is never adopted implicitly — reopening it
  // leaves it project-less. Filing is the one deliberate way to give a
  // stranded session a home: it rewrites projectId through the same synced
  // state every other edit uses, with a monotonic updatedAt stamp so the
  // newest-copy-wins cross-device merge carries the new home instead of
  // reviving the stranded copy from another device (see
  // fileConversationToProjectInState for the rules and guards). Mirrors the
  // mobile app's fileConversationToProject
  // (artifacts/venom/context/VenomContext.tsx).
  const fileConversationToProject = useCallback(
    (conversationId: string, projectId: string) => {
      setState((current) =>
        fileConversationToProjectInState(current, conversationId, projectId),
      );
    },
    [],
  );

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

  // The author sorted an Unsorted item into their own Brain. Clearing the
  // flag locally and bumping `lastUpdatedAt` is the whole job: the server
  // deliberately lets `unsorted` survive snapshot round-trips, so this syncs
  // like any other cluster edit and wins the cross-device merge.
  const markKnowledgeClusterSorted = useCallback((clusterId: string) => {
    const updatedAt = Date.now();
    setState((current) => {
      const cluster = current.clusters.find((c) => c.id === clusterId);
      if (!cluster || cluster.unsorted !== true) return current;
      return {
        ...current,
        clusters: current.clusters.map((c) => {
          if (c.id !== clusterId) return c;
          const next = { ...c, lastUpdatedAt: updatedAt };
          delete next.unsorted;
          return next;
        }),
      };
    });
  }, []);

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
        voiceModels?: VenomVoiceModelPick[] | null;
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
        if (prefs.voiceModels === null) {
          delete next.voiceModels;
        } else if (prefs.voiceModels !== undefined) {
          // Store the canonical bounded form so a snapshot save can never be
          // rejected for an oversized or duplicated picks array.
          const picks = normalizeConversationVoiceModels(prefs.voiceModels);
          if (picks) {
            next.voiceModels = picks;
          } else {
            delete next.voiceModels;
          }
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
      orgs,
      orgInvites,
      refreshOrgs,
      setActiveProject,
      addProject,
      deleteProject,
      pendingProjectRestore,
      restoreDeletedProject,
      dismissProjectRestore,
      setActiveConversation,
      createNewConversation,
      fileConversationToProject,
      addMessage,
      updateMessage,
      clearConversation,
      addTask,
      updateTaskStatus,
      deleteTask,
      applyKnowledgeInsights,
      applyFiledKnowledge,
      markKnowledgeClusterSorted,
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
      orgs,
      orgInvites,
      refreshOrgs,
      setActiveProject,
      addProject,
      deleteProject,
      pendingProjectRestore,
      restoreDeletedProject,
      dismissProjectRestore,
      setActiveConversation,
      createNewConversation,
      fileConversationToProject,
      addMessage,
      updateMessage,
      clearConversation,
      addTask,
      updateTaskStatus,
      deleteTask,
      applyKnowledgeInsights,
      applyFiledKnowledge,
      markKnowledgeClusterSorted,
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
