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
import { Platform } from 'react-native';
import { fetch as expoFetch } from 'expo/fetch';
import { useAuth } from '@clerk/expo';
import {
  applyFiledClustersToState,
  applyKnowledgeInsightsToState,
  clearConversationKnowledge,
  fileKnowledgeNoteToState,
  type FileKnowledgeNoteStatus,
} from './knowledgeState';
import {
  compactBoardPositions,
  createDefaultBoardStages,
  normalizeBoardValue,
  normalizeProjectBoard,
  type BoardValue,
} from './boardState';
import {
  createFallbackWorkspaceProject,
  mostRecentlyUpdatedProjectId,
} from './projectLifecycle';
import {
  applyOrgProjectSync,
  captureProjectRestoreSnapshot,
  createDeletionMarkers,
  createEmptyTombstones,
  dropRestoredArchivedCitations,
  dropUncitedArchivedCitations,
  fileConversationToProjectInState,
  flushWorkspaceState,
  isWorkspaceState,
  mergeArchivedCitations,
  mergeTombstones,
  normalizeModelPreferences,
  normalizeVoicePreferences,
  normalizeWorkspaceState,
  parseSyncedProjectIds,
  PROJECT_RESTORE_WINDOW_MS,
  reconcileKnowledgeLinks,
  resolveSuccessfulWorkspaceHydration,
  restoreProjectFromSnapshot,
  workspaceProjectIds,
  type ProjectRestoreSnapshot,
  type SyncController,
} from './workspaceSync';
import { workspaceSyncRetryDelay } from './workspaceSyncRetry';
import {
  initializeWorkspaceSyncTestHarness,
  IS_WORKSPACE_SYNC_UI_TEST,
  loadWorkspaceForSyncTest,
  saveWorkspaceForSyncTest,
  WORKSPACE_SYNC_UI_TEST_USER_ID,
} from './workspaceSyncTestHarness';
import {
  claimScheduledSync,
  mergeProjectSources,
  recordScheduledSyncFailure,
  releaseScheduledSyncClaim,
  replaceRefreshedSource,
  setSourceSchedule as applySourceSchedule,
  type SourceScheduleCadence,
} from './sourceState';
import {
  archivedCitationsFromRemovedSource,
  archivedCitationsFromRetired,
  citedCitationIds,
  remapConversationCitations,
  restoredCitationRemap,
  retiredCitationRemap,
} from './messageCitations';
import {
  ApiError,
  getGetVenomWorkspaceQueryKey,
  getVenomOrgProjects,
  getVenomOrgs,
  saveVenomWorkspace,
  useGetVenomWorkspace,
  VenomModelId as VenomModelIdEnum,
  type KnowledgeCandidate,
  type VenomConversation,
  type VenomKnowledgeCluster,
  type VenomKnowledgeSource,
  type VenomKanbanField,
  type VenomKanbanFieldType,
  type VenomKanbanStage,
  type VenomConversationBlend,
  type VenomMessage,
  type VenomModelId,
  type VenomModelPreferences,
  type VenomModelSelectionPolicy,
  type VenomResponseMode,
  type VenomVoicePreferences,
  type VenomVoicePresetId,
  type VenomVoiceTalkativeness,
  type VenomProject,
  type ProjectSource,
  type SourceCitation,
  type SourceCluster,
  type VenomTask,
  type VenomTaskStatus,
  type VenomOrg,
  type VenomOrgInviteForMe,
  type VenomOrgSharedProject,
  type VenomWorkspaceSnapshot,
  type VenomWorkspaceState,
} from '@workspace/api-client-react';
import {
  isResponseMode,
  normalizeConversationBlend,
} from './responsePrefs';

export type { ProjectSource, SourceCitation, SourceCluster };
export type { VenomModelId, VenomModelPreferences, VenomModelSelectionPolicy };
export type { VenomVoicePreferences, VenomVoicePresetId, VenomVoiceTalkativeness };

export type Project = VenomProject;
export type Task = VenomTask;
export type TaskStatus = VenomTaskStatus;

export type KanbanStage = VenomKanbanStage;
export type Message = VenomMessage;
export type Conversation = VenomConversation;
export type KnowledgeCluster = VenomKnowledgeCluster;
export type KnowledgeSource = VenomKnowledgeSource;
export type KnowledgeInsight = KnowledgeCandidate;
export type VenomState = VenomWorkspaceState;

/** What the undo-delete affordance needs to render, nothing more. */
export type PendingProjectRestore = {
  /** Unique per deletion, so the UI can tell one pending undo from the next. */
  key: string;
  projectName: string;
  /** Epoch ms when the restore window closes and the snapshot is dropped. */
  expiresAt: number;
};

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

  // Company (organization) state
  orgs: VenomOrg[];
  orgInvites: VenomOrgInviteForMe[];
  refreshOrgs: () => void;
  /**
   * The workspace state most recently confirmed saved to the cloud for this
   * account. A device may only act on a scheduled-sync claim it can see in
   * here: local state says what this device wants, this says what the
   * account's other devices will actually be told.
   */
  lastSyncedState: VenomState | null;
  hasPendingLegacyImport: boolean;
  importDeviceWorkspace: () => void;
  startFreshWorkspace: () => void;
  addProject: (
    project: Omit<
      Project,
      'id' | 'updatedAt' | 'tasks' | 'boardStages' | 'fieldDefinitions'
    >,
  ) => string;
  updateProject: (id: string, project: Partial<Project>) => void;
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
  setActiveProject: (id: string | null) => void;
  addSource: (source: ProjectSource) => void;
  refreshSource: (previousSourceId: string, source: ProjectSource) => void;
  setSourceSchedule: (
    sourceId: string,
    cadence: SourceScheduleCadence | null,
  ) => void;
  recordSourceSyncFailure: (sourceId: string, message: string) => void;
  claimScheduledSourceSync: (sourceId: string, claimedBy: string) => void;
  releaseScheduledSourceSyncClaim: (
    sourceId: string,
    claimedBy: string,
  ) => void;
  removeSource: (sourceId: string) => void;
  addTask: (projectId: string, title: string, stageId?: string) => void;
  updateTask: (
    projectId: string,
    taskId: string,
    updates: {
      title?: string;
      stageId?: string;
      values?: Record<string, BoardValue>;
    },
  ) => void;
  moveTask: (
    projectId: string,
    taskId: string,
    stageId: string,
    position: number,
  ) => void;
  deleteTask: (projectId: string, taskId: string) => void;
  addStage: (projectId: string, name: string, isDone: boolean) => void;
  updateStage: (
    projectId: string,
    stageId: string,
    updates: { name?: string; isDone?: boolean },
  ) => void;
  reorderStage: (
    projectId: string,
    stageId: string,
    position: number,
  ) => void;
  removeStage: (
    projectId: string,
    stageId: string,
    reassignToStageId: string,
  ) => void;
  addFieldDefinition: (
    projectId: string,
    input: {
      name: string;
      type: KanbanFieldType;
      options?: string[];
      showOnCard?: boolean;
    },
  ) => void;
  updateFieldDefinition: (
    projectId: string,
    fieldId: string,
    updates: {
      name?: string;
      options?: string[];
      showOnCard?: boolean;
    },
  ) => void;
  reorderFieldDefinition: (
    projectId: string,
    fieldId: string,
    position: number,
  ) => void;
  removeFieldDefinition: (projectId: string, fieldId: string) => void;
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
  fileConversationToProject: (conversationId: string, projectId: string) => void;
  applyKnowledgeInsights: (
    conversation: Pick<Conversation, 'id' | 'title' | 'projectId'>,
    insights: KnowledgeInsight[],
  ) => void;
  applyFiledKnowledge: (
    conversation: Pick<Conversation, 'id' | 'title' | 'projectId'>,
    filed: KnowledgeCluster[],
  ) => void;
  fileKnowledgeNote: (input: {
    userId: string;
    projectId: string;
    note: string;
    insights: KnowledgeInsight[];
  }) => FileKnowledgeNoteStatus | 'account_changed';
  renameKnowledgeCluster: (clusterId: string, label: string) => void;
  markKnowledgeClusterSorted: (clusterId: string) => void;
  deleteKnowledgeCluster: (clusterId: string) => void;
  mergeKnowledgeClusters: (
    targetClusterId: string,
    sourceClusterId: string,
  ) => void;
  enableModel: (modelId: VenomModelId) => void;
  removeModel: (modelId: VenomModelId) => void;
  setDefaultModel: (modelId: VenomModelId) => void;
  setActiveModel: (modelId: VenomModelId) => void;
  setModelSelectionPolicy: (policy: VenomModelSelectionPolicy) => void;
  setVoicePreset: (presetId: VenomVoicePresetId) => void;
  setVoiceTalkativeness: (talkativeness: VenomVoiceTalkativeness) => void;
  setConversationResponsePrefs: (
    conversationId: string,
    prefs: {
      responseMode?: VenomResponseMode;
      blend?: VenomConversationBlend | null;
    },
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

/**
 * UI-test fixture: a Brain note written from an assistant answer, so its
 * summary and source excerpt carry the inline `[source:...]` markers the
 * answer stored. Browser tests use it to prove the raw marker never reaches
 * the screen, whether the cited source is connected or long gone.
 */
const CITED_FIXTURE_CITATION_ID = 'cite_repository_readme';
const citedFixtureClusters: KnowledgeCluster[] = [
  {
    ...defaultClusters[0],
    summary: `Structure follows [source:${CITED_FIXTURE_CITATION_ID}] for the mobile release.`,
    links: [],
    sources: [
      {
        conversationId: 'conv_cited_fixture',
        projectId: 'proj_default',
        conversationTitle: 'Release planning',
        messageIds: ['msg_cited_fixture'],
        excerpt: `The layout is described in [source:${CITED_FIXTURE_CITATION_ID}].`,
        updatedAt: 0,
      },
    ],
  },
];

const LEGACY_STORAGE_KEYS = ['@venom_state_v3', '@venom_state_v1'] as const;
const storageKeyFor = (userId: string) => `@venom_state_v2:${userId}`;
const sourcesKeyFor = (userId: string) => `@venom_sources_v1:${userId}`;
/**
 * The projects this device knows the cloud has seen. Kept outside the
 * workspace snapshot because that snapshot is what gets uploaded, and this is
 * device-local bookkeeping: it is what tells a restore that a project missing
 * from the cloud was created here offline rather than deleted elsewhere.
 */
const syncedProjectsKeyFor = (userId: string) =>
  `@venom_synced_projects_v1:${userId}`;
const generateId = (prefix: string) =>
  `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`;
const normalizeLabel = (label: string) => label.trim().toLocaleLowerCase();

const ALL_MODEL_IDS_CONST = Object.values(VenomModelIdEnum) as VenomModelId[];
const normalizeFieldOptions = (options: string[]) => {
  const seen = new Set<string>();
  return options.flatMap((option): string[] => {
    const cleaned = option.trim().slice(0, 80);
    const key = normalizeLabel(cleaned);
    if (!cleaned || seen.has(key) || seen.size >= 30) return [];
    seen.add(key);
    return [cleaned];
  });
};
const UI_TEST_QUERY_ENABLED =
  Platform.OS === 'web' &&
  typeof globalThis.location?.search === 'string' &&
  globalThis.location.search.includes('venomUiTest=true');

// The signed-out welcome/sign-in screens are unreachable while UI-test mode
// is on (the auth gate treats the placeholder user as signed in), and the
// browser suite's server bakes EXPO_PUBLIC_VENOM_UI_TEST=true into the
// bundle. This explicit opt-out lets a spec load the real Clerk-gated flow;
// it wins over both the env flag and the enabling query param, and — like
// UI-test mode itself — only exists in dev web bundles.
const UI_TEST_QUERY_DISABLED =
  Platform.OS === 'web' &&
  typeof globalThis.location?.search === 'string' &&
  globalThis.location.search.includes('venomUiTest=false');

export const IS_UI_TEST =
  __DEV__ &&
  Platform.OS === 'web' &&
  !UI_TEST_QUERY_DISABLED &&
  (process.env.EXPO_PUBLIC_VENOM_UI_TEST === 'true' ||
    UI_TEST_QUERY_ENABLED);
export const IS_READ_ONLY_UI_TEST = IS_UI_TEST;
export const UI_TEST_USER_ID = 'venom-ui-test';

/**
 * Opt-in for browser specs that exercise the live company directory +
 * membership event stream. Off by default so every other spec keeps the
 * org machinery quiet (no unstubbed background fetches to satisfy).
 */
export const IS_ORG_UI_TEST =
  IS_UI_TEST &&
  typeof globalThis.location?.search === 'string' &&
  new URLSearchParams(globalThis.location.search).has('venomUiTestOrgs');

// Map placement for chat-derived clusters lives in
// @workspace/venom-workspace-merge (via knowledgeState.ts); this file no
// longer keeps its own positionForLabel copy that could drift from it.

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
  const boardStages = createDefaultBoardStages('proj_default', now);
  const brainFixture =
    IS_UI_TEST && typeof globalThis.location?.search === 'string'
      ? new URLSearchParams(globalThis.location.search).get('brainFixture')
      : null;
  const fixtureClusters =
    brainFixture === 'sparse'
      ? defaultClusters.slice(0, 2).map((cluster) => ({
          ...cluster,
          links: cluster.links.filter((id) =>
            defaultClusters.slice(0, 2).some((candidate) => candidate.id === id),
          ),
        }))
      : brainFixture === 'cited'
        ? citedFixtureClusters
        : defaultClusters;
  const defaultModelPreferences: VenomModelPreferences = normalizeModelPreferences(undefined);
  const defaultVoicePreferences: VenomVoicePreferences = normalizeVoicePreferences(undefined);

  return {
    projects: [
      {
        id: 'proj_default',
        name: 'General',
        description: 'Uncategorized intelligence',
        accent: '#73736f',
        sourceCount: 0,
        updatedAt: now,
        boardStages,
        fieldDefinitions: [],
        tasks: [
          {
            id: 'task_1',
            title: 'Define data schema',
            stageId: boardStages[2].id,
            position: 0,
            createdAt: now - 100000,
            updatedAt: now - 100000,
            values: {},
          },
          {
            id: 'task_2',
            title: 'Implement authentication',
            stageId: boardStages[1].id,
            position: 0,
            createdAt: now - 50000,
            updatedAt: now - 50000,
            values: {},
          },
          {
            id: 'task_3',
            title: 'Design onboarding flow',
            stageId: boardStages[0].id,
            position: 0,
            createdAt: now,
            updatedAt: now,
            values: {},
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
    clusters: fixtureClusters,
    sources: [],
    activeProjectId: 'proj_default',
    activeConversationId: 'conv_default',
    tombstones: createEmptyTombstones(),
    modelPreferences: defaultModelPreferences,
    voicePreferences: defaultVoicePreferences,
    archivedCitations: [],
  };
}

function createSyncController(userId: string | null): SyncController {
  return {
    userId,
    inFlight: false,
    queued: null,
    retryAttempt: 0,
    retryTimer: null,
  };
}

function cancelSyncController(controller: SyncController) {
  if (controller.retryTimer) {
    clearTimeout(controller.retryTimer);
  }
  controller.retryTimer = null;
  controller.queued = null;
}

const VenomContext = createContext<VenomContextType | null>(null);

// hint: Logic changed on both sides. Requires understanding intent of each change.
export function VenomProvider({ children }: { children: React.ReactNode }) {
  const { getToken, userId: authenticatedUserId } = useAuth();
  const [workspaceSyncTestUserId, setWorkspaceSyncTestUserId] = useState(
    WORKSPACE_SYNC_UI_TEST_USER_ID,
  );
  const userId = IS_WORKSPACE_SYNC_UI_TEST
    ? workspaceSyncTestUserId
    : IS_UI_TEST
      ? UI_TEST_USER_ID
      : authenticatedUserId;
  const [state, setState] = useState<VenomState>(() => createDefaultState());
  const [localState, setLocalState] = useState<VenomState | null>(null);
  const [legacyState, setLegacyState] = useState<VenomState | null>(null);
  const [hasScopedState, setHasScopedState] = useState(false);
  const [syncedProjectIds, setSyncedProjectIds] = useState<string[] | null>(
    null,
  );
  const [hasPendingLegacyImport, setHasPendingLegacyImport] = useState(false);
  const [localUserId, setLocalUserId] = useState<string | null>(null);
  const [isReady, setIsReady] = useState(false);
  const [syncStatus, setSyncStatus] = useState<SyncStatus>('loading');
  const [lastSyncedAt, setLastSyncedAt] = useState<string | null>(null);
  const [lastSyncedState, setLastSyncedState] = useState<VenomState | null>(
    null,
  );
  const latestStateRef = useRef(state);
  latestStateRef.current = state;

  const revisionRef = useRef(0);
  const hydratedUserRef = useRef<string | null>(null);
  const lastSerializedRef = useRef('');
  const activeUserIdRef = useRef<string | null>(userId ?? null);
  const syncControllerRef = useRef<SyncController>(
    createSyncController(userId ?? null),
  );
  const flushCloudStateRef = useRef<(nextState: VenomState) => void>(() => {});

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

  useEffect(() => {
    if (!IS_WORKSPACE_SYNC_UI_TEST) return;

    initializeWorkspaceSyncTestHarness();
    const handleAccountChange = (event: Event) => {
      const nextUserId = (event as CustomEvent<{ userId?: unknown }>).detail
        ?.userId;
      if (typeof nextUserId === 'string' && nextUserId) {
        setWorkspaceSyncTestUserId(nextUserId);
      }
    };
    globalThis.addEventListener(
      'venom-workspace-sync-test-account-change',
      handleAccountChange,
    );
    return () => {
      globalThis.removeEventListener(
        'venom-workspace-sync-test-account-change',
        handleAccountChange,
      );
    };
  }, []);

  if (activeUserIdRef.current !== (userId ?? null)) {
    cancelSyncController(syncControllerRef.current);
    activeUserIdRef.current = userId ?? null;
    syncControllerRef.current = createSyncController(userId ?? null);
    // An undo window never crosses an account boundary.
    pendingRestoreRef.current = null;
  }

  // The render-phase reset above cannot touch React state; finish clearing
  // the undo affordance once the user change commits.
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

  const workspaceQuery = useGetVenomWorkspace({
    query: {
      enabled: Boolean(userId) && !IS_READ_ONLY_UI_TEST,
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
      setSyncedProjectIds(null);
      setHasPendingLegacyImport(false);
      setLocalUserId(null);
      setState(createDefaultState());
      setIsReady(false);
      setSyncStatus('loading');
      setLastSyncedAt(null);
      setLastSyncedState(null);
      return;
    }

    setIsReady(false);
    setSyncStatus('loading');
    setLastSyncedState(null);
    setLocalState(null);
    setLegacyState(null);
    setHasScopedState(false);
    setSyncedProjectIds(null);
    setHasPendingLegacyImport(false);
    setLocalUserId(null);
    hydratedUserRef.current = null;
    revisionRef.current = 0;
    lastSerializedRef.current = '';

    void (async () => {
      const [scopedData, legacyEntries, sourcesData, syncedProjectsData] =
        await Promise.all([
          AsyncStorage.getItem(storageKeyFor(userId)),
          AsyncStorage.multiGet([...LEGACY_STORAGE_KEYS]),
          AsyncStorage.getItem(sourcesKeyFor(userId)),
          AsyncStorage.getItem(syncedProjectsKeyFor(userId)),
        ]);
      const legacyData =
        legacyEntries.find(([, storedValue]) => storedValue !== null)?.[1] ??
        null;
      let restored = createDefaultState();
      let restoredLegacy: VenomState | null = null;
      let scopedStateIsValid = false;
      let migratedSources: ProjectSource[] = [];
      let restoredSyncedProjectIds: string[] | null = null;

      if (scopedData) {
        try {
          const parsed: unknown = JSON.parse(scopedData);
          if (isWorkspaceState(parsed)) {
            restored = normalizeWorkspaceState(parsed);
            scopedStateIsValid = true;
          }
        } catch {
          if (!cancelled && activeUserIdRef.current === userId) {
            setSyncStatus('error');
          }
        }
      }

      if (legacyData) {
        try {
          const parsed: unknown = JSON.parse(legacyData);
          if (isWorkspaceState(parsed)) {
            restoredLegacy = normalizeWorkspaceState(parsed);
          }
        } catch {
          if (!cancelled && activeUserIdRef.current === userId) {
            setSyncStatus('error');
          }
        }
      }

      if (sourcesData) {
        try {
          const parsedSources: unknown = JSON.parse(sourcesData);
          if (Array.isArray(parsedSources)) {
            migratedSources = parsedSources as ProjectSource[];
          }
        } catch {
          // Legacy connected-source storage is optional.
        }
      }

      if (syncedProjectsData) {
        try {
          restoredSyncedProjectIds = parseSyncedProjectIds(
            JSON.parse(syncedProjectsData) as unknown,
          );
        } catch {
          // An unreadable baseline falls back to cloud-only scoping.
        }
      }

      if (!cancelled) {
        setLocalState({
          ...restored,
          sources: mergeProjectSources(
            restored.sources,
            migratedSources,
            restored.tombstones?.sources ?? [],
          ),
        });
        setLegacyState(restoredLegacy);
        setHasScopedState(scopedStateIsValid);
        setSyncedProjectIds(restoredSyncedProjectIds);
        setLocalUserId(userId);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [userId]);

  const scheduleCloudRetry = useCallback(
    (controller: SyncController, syncUserId: string) => {
      if (
        controller.retryTimer ||
        syncControllerRef.current !== controller ||
        activeUserIdRef.current !== syncUserId
      ) {
        return;
      }

      const delay = workspaceSyncRetryDelay(controller.retryAttempt);
      controller.retryAttempt += 1;
      controller.retryTimer = setTimeout(() => {
        controller.retryTimer = null;
        if (
          syncControllerRef.current !== controller ||
          activeUserIdRef.current !== syncUserId ||
          !controller.queued
        ) {
          return;
        }
        flushCloudStateRef.current(controller.queued);
      }, delay);
    },
    [],
  );

  const flushCloudState = useCallback(
    async (nextState: VenomState) => {
      if (!userId || (IS_UI_TEST && !IS_WORKSPACE_SYNC_UI_TEST)) return;

      const syncUserId = userId;
      const controller = syncControllerRef.current;
      await flushWorkspaceState({
        nextState,
        syncUserId,
        controller,
        getCurrentController: () => syncControllerRef.current,
        getActiveUserId: () => activeUserIdRef.current,
        getLatestState: () => latestStateRef.current,
        getRevision: () => revisionRef.current,
        setRevision: (revision) => {
          revisionRef.current = revision;
        },
        getToken: IS_WORKSPACE_SYNC_UI_TEST
          ? async () => 'workspace-sync-test-token'
          : getToken,
        saveState: (stateToSave, baseRevision, token) =>
          IS_WORKSPACE_SYNC_UI_TEST
            ? saveWorkspaceForSyncTest(
                syncUserId,
                stateToSave,
                baseRevision,
              )
            : saveVenomWorkspace(
                { state: stateToSave, baseRevision },
                { headers: { Authorization: `Bearer ${token}` } },
              ),
        classifyFailure: (error) => {
          if (error instanceof ApiError && error.status === 413) {
            return { kind: 'too_large' };
          }
          if (error instanceof ApiError && error.status === 409) {
            return {
              kind: 'conflict',
              snapshot: error.data as VenomWorkspaceSnapshot | null,
            };
          }
          return { kind: 'other' };
        },
        onSyncing: () => setSyncStatus('syncing'),
        onSaved: async ({ state: savedState, serialized, snapshot }) => {
          lastSerializedRef.current = serialized;
          setLastSyncedAt(snapshot.updatedAt);
          setLastSyncedState(savedState);
          setSyncStatus('synced');
          // The cloud now holds exactly these projects, so the baseline both
          // gains what this save uploaded and forgets what it deleted.
          const savedProjectIds = workspaceProjectIds(savedState);
          setSyncedProjectIds(savedProjectIds);
          await Promise.all([
            AsyncStorage.setItem(storageKeyFor(syncUserId), serialized),
            AsyncStorage.setItem(
              syncedProjectsKeyFor(syncUserId),
              JSON.stringify(savedProjectIds),
            ),
          ]);
        },
        onConflictMerged: (candidate, snapshot) => {
          latestStateRef.current = candidate;
          setState(candidate);
          setLastSyncedAt(snapshot.updatedAt);
        },
        onTooLarge: () => setSyncStatus('too_large'),
        onError: () => setSyncStatus('error'),
        onRetryableFailure: () =>
          scheduleCloudRetry(controller, syncUserId),
      });
    },
    [getToken, scheduleCloudRetry, userId],
  );

  flushCloudStateRef.current = (nextState) => {
    void flushCloudState(nextState);
  };

  useEffect(() => {
    const effectUserId = userId ?? null;
    if (
      activeUserIdRef.current !== effectUserId ||
      syncControllerRef.current.userId !== effectUserId
    ) {
      cancelSyncController(syncControllerRef.current);
      activeUserIdRef.current = effectUserId;
      syncControllerRef.current = createSyncController(effectUserId);
    }
    const controller = syncControllerRef.current;

    return () => {
      cancelSyncController(controller);
      if (syncControllerRef.current === controller) {
        syncControllerRef.current = createSyncController(null);
      }
      if (activeUserIdRef.current === effectUserId) {
        activeUserIdRef.current = null;
      }
    };
  }, [userId]);

  useEffect(() => {
    if (
      !userId ||
      localUserId !== userId ||
      !localState ||
      hydratedUserRef.current === userId ||
      (!IS_UI_TEST && workspaceQuery.isPending)
    ) {
      return;
    }

    hydratedUserRef.current = userId;

    // The sync test mode restores from the harness's fake cloud so it runs the
    // same hydration a signed-in restore runs; an account that has never saved
    // has nothing to restore from.
    const cloud = IS_WORKSPACE_SYNC_UI_TEST
      ? loadWorkspaceForSyncTest(userId)
      : workspaceQuery.isSuccess
        ? workspaceQuery.data
        : null;

    if (IS_WORKSPACE_SYNC_UI_TEST && !cloud) {
      lastSerializedRef.current = JSON.stringify(localState);
      latestStateRef.current = localState;
      setState(localState);
      setSyncStatus('synced');
      setIsReady(true);
      return;
    }

    if (cloud) {
      revisionRef.current = cloud.revision;
      setLastSyncedAt(cloud.updatedAt);
      setIsReady(true);
      const hydration = resolveSuccessfulWorkspaceHydration({
        cloudState: cloud.state
          ? normalizeWorkspaceState(cloud.state)
          : null,
        localState,
        legacyState,
        hasScopedState,
        syncedProjectIds,
        createFreshState: createDefaultState,
      });
      lastSerializedRef.current = JSON.stringify(hydration.state);
      latestStateRef.current = hydration.state;
      setState(hydration.state);
      setHasPendingLegacyImport(hydration.pendingLegacyImport);
      setSyncStatus(hydration.syncStatus);
      if (hydration.syncedProjectIds) {
        setSyncedProjectIds(hydration.syncedProjectIds);
        void AsyncStorage.setItem(
          syncedProjectsKeyFor(userId),
          JSON.stringify(hydration.syncedProjectIds),
        );
      }
      if (hydration.shouldUpload) {
        void flushCloudState(hydration.state);
      }
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
    syncedProjectIds,
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

    if (IS_UI_TEST && !IS_WORKSPACE_SYNC_UI_TEST) {
      lastSerializedRef.current = serialized;
      setSyncStatus('offline');
      return;
    }
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

  // ── company (organization) directory + shared-project mirroring ──────────
  const [orgs, setOrgs] = useState<VenomOrg[]>([]);
  const [orgInvites, setOrgInvites] = useState<VenomOrgInviteForMe[]>([]);
  const [orgsNonce, setOrgsNonce] = useState(0);

  /** Re-poll the company directory now (after invites, removals, …). */
  const refreshOrgs = useCallback(() => setOrgsNonce((nonce) => nonce + 1), []);

  // Clerk can hand back a fresh getToken identity on any render; the poll
  // must not re-arm because of it, so ticks read the latest through a ref.
  const orgTokenRef = useRef(getToken);
  useEffect(() => {
    orgTokenRef.current = getToken;
  }, [getToken]);

  useEffect(() => {
    if ((IS_UI_TEST && !IS_ORG_UI_TEST) || !userId) {
      // Same-reference bailouts: an already-empty directory must not trigger
      // a re-render, or this effect would feed its own update loop.
      setOrgs((current) => (current.length === 0 ? current : []));
      setOrgInvites((current) => (current.length === 0 ? current : []));
      return;
    }
    let cancelled = false;

    const tick = async () => {
      const token = IS_UI_TEST
        ? null
        : await orgTokenRef.current().catch(() => null);
      if ((!token && !IS_UI_TEST) || cancelled) return;
      const auth = token
        ? { headers: { Authorization: `Bearer ${token}` } }
        : undefined;
      let directory;
      try {
        directory = await getVenomOrgs(auth);
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
            const list = await getVenomOrgProjects(org.id, auth);
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
        applyOrgProjectSync(
          current,
          directory.orgs,
          sharedByOrg,
          fetchedOrgIds,
        ),
      );
    };

    void tick();
    const interval = setInterval(() => void tick(), 25_000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [userId, isReady, orgsNonce]);

  // Live revocation push. Removal, leaving on another device, or company
  // deletion must clear this device NOW, not at the next 25s poll — the
  // Brain layer renders company concepts from memory, so the poll gap is a
  // real disclosure window. The optimistic drop hides the company instantly
  // (the layer falls back to My Brain and org state clears) and the
  // directory refetch that follows is authoritative — it also prunes the
  // mirrored shared projects. A dropped stream degrades to the poll; the
  // server stays the authorization fence either way. expo/fetch streams on
  // native and is globalThis.fetch on web.
  useEffect(() => {
    if ((IS_UI_TEST && !IS_ORG_UI_TEST) || !userId) return;
    const domain = process.env.EXPO_PUBLIC_DOMAIN;
    if (!IS_UI_TEST && !domain) return;
    const eventsUrl = IS_UI_TEST
      ? '/api/venom/orgs/events'
      : `https://${domain}/api/venom/orgs/events`;
    const controller = new AbortController();
    let retryTimer: ReturnType<typeof setTimeout> | undefined;

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
        const token = IS_UI_TEST
          ? null
          : await orgTokenRef.current().catch(() => null);
        if (!token && !IS_UI_TEST) throw new Error('no session token');
        const response = await expoFetch(eventsUrl, {
          headers: {
            accept: 'text/event-stream',
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
          },
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
        retryTimer = setTimeout(() => void connect(), 15_000);
      }
    };

    void connect();
    return () => {
      controller.abort();
      if (retryTimer !== undefined) clearTimeout(retryTimer);
    };
  }, [userId, refreshOrgs]);

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

  // The deletion commits immediately — the undo affordance works on a content
  // snapshot captured at the moment of the delete, and restoring rebuilds
  // that content under fresh ids. The tombstones written below are never
  // rolled back, so sync semantics stay exactly as they were.
  const deleteProject = useCallback((id: string) => {
    const deletedProject = latestStateRef.current.projects.find(
      (item) => item.id === id,
    );
    const deletedAt = Date.now();
    const restoreKey = generateId('restore');
    setState((current) => {
      const snapshot = captureProjectRestoreSnapshot(current, id, deletedAt);
      const project = current.projects.find((item) => item.id === id);
      const remainingProjects = current.projects.filter(
        (item) => item.id !== id,
      );
      // Deleting the workspace you are in must land somewhere sensible: the
      // next most recently updated project, or a fresh default workspace when
      // nothing else remains (a fresh id keeps the deleted project's
      // tombstone authoritative during sync).
      const fallbackProject =
        remainingProjects.length === 0
          ? createFallbackWorkspaceProject(generateId('proj'), deletedAt)
          : null;
      const nextActiveProjectId = fallbackProject
        ? fallbackProject.id
        : current.activeProjectId === id
          ? mostRecentlyUpdatedProjectId(remainingProjects)
          : current.activeProjectId;
      const removedConversations = current.conversations.filter(
        (conversation) => conversation.projectId === id,
      );
      const removedClusters = current.clusters.filter(
        (cluster) => cluster.projectId === id,
      );
      const removedSources = current.sources.filter(
        (source) => source.projectId === id,
      );
      const conversations = current.conversations.filter(
        (conversation) => conversation.projectId !== id,
      );
      const activeConversationExists = conversations.some(
        (conversation) => conversation.id === current.activeConversationId,
      );
      // The deleted project's answers are gone, so the evidence only they could
      // have named no longer belongs in the bounded archive.
      const stillCited = citedCitationIds(conversations);

      const next: VenomState = {
        ...current,
        projects: fallbackProject ? [fallbackProject] : remainingProjects,
        conversations,
        archivedCitations: dropUncitedArchivedCitations(
          current.archivedCitations,
          (citationId) => stillCited.has(citationId),
        ),
        clusters: current.clusters.filter(
          (cluster) => cluster.projectId !== id,
        ),
        sources: current.sources.filter((source) => source.projectId !== id),
        activeProjectId: nextActiveProjectId,
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
          stages: createDeletionMarkers(
            project?.boardStages.map((stage) => stage.id) ?? [],
            deletedAt,
          ),
          fields: createDeletionMarkers(
            project?.fieldDefinitions.map((field) => field.id) ?? [],
            deletedAt,
          ),
          sources: createDeletionMarkers(
            removedSources.map((source) => source.id),
            deletedAt,
          ),
        }),
      };
      if (snapshot) {
        // Assigned inside the updater so the snapshot is exactly what this
        // delete removed. StrictMode double-invokes updaters; the last run
        // wins and matches the committed state (same precedent as the
        // generateId call that seeds the fallback workspace above).
        pendingRestoreRef.current = {
          key: restoreKey,
          userId: activeUserIdRef.current,
          snapshot,
          // Deleting the last project seeds the fallback workspace above, so
          // it is the only project left standing.
          fallbackProjectId: snapshot.wasLastProject
            ? (fallbackProject?.id ?? null)
            : null,
        };
      }
      return next;
    });
    if (!deletedProject) return;
    setPendingProjectRestore({
      key: restoreKey,
      projectName: deletedProject.name,
      expiresAt: deletedAt + PROJECT_RESTORE_WINDOW_MS,
    });
    if (restoreExpiryTimerRef.current !== null) {
      clearTimeout(restoreExpiryTimerRef.current);
    }
    restoreExpiryTimerRef.current = setTimeout(() => {
      restoreExpiryTimerRef.current = null;
      clearPendingRestore(restoreKey);
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

  // A chat session belongs to the project it was written in, so switching
  // project has to move the chat too: otherwise the next message is filed under
  // the project that was selected when the session started, not the one on
  // screen. Switching back reopens that project's own latest session, and a
  // project with no session yet starts empty so the first message opens one
  // under it.
  const setActiveProject = useCallback((id: string | null) => {
    setState((current) => {
      if (current.activeProjectId === id) return current;

      const activeConversation = current.conversations.find(
        (conversation) => conversation.id === current.activeConversationId,
      );
      if (activeConversation && activeConversation.projectId === id) {
        return { ...current, activeProjectId: id };
      }

      const latestForProject = current.conversations.reduce<
        Conversation | null
      >((latest, conversation) => {
        if (conversation.projectId !== id) return latest;
        if (!latest || conversation.updatedAt > latest.updatedAt) {
          return conversation;
        }
        return latest;
      }, null);

      return {
        ...current,
        activeProjectId: id,
        activeConversationId: latestForProject?.id ?? null,
      };
    });
  }, []);

  const addSource = useCallback((source: ProjectSource) => {
    setState((current) => {
      const sources = mergeProjectSources(
        current.sources,
        [source],
        current.tombstones?.sources ?? [],
      );
      return {
        ...current,
        sources,
        projects: current.projects.map((project) =>
          project.id === source.projectId
            ? {
                ...project,
                sourceCount: sources.filter(
                  (item) => item.projectId === source.projectId,
                ).length,
                updatedAt: Date.now(),
              }
            : project,
        ),
      };
    });
  }, []);

  const refreshSource = useCallback(
    (previousSourceId: string, source: ProjectSource) => {
      setState((current) => {
        const previous = current.sources.find(
          (item) => item.id === previousSourceId,
        );
        const refreshedAt = Date.now();
        const replaced = replaceRefreshedSource(
          current.sources,
          previousSourceId,
          source,
          refreshedAt,
        );
        if (!replaced) return current;

        // Answers saved before the refresh still carry the retired citation
        // ids, so point them at the refreshed equivalent where one exists.
        const citationRemap = retiredCitationRemap(
          previous?.citations ?? [],
          source.citations,
        );
        // An item that had disappeared can come back (an issue reopened, a page
        // restored — possibly at a new address under the same title). Point
        // answers at the live citation again so the archived entry for it
        // becomes droppable.
        const restoredRemap = restoredCitationRemap(
          current.archivedCitations,
          source.citations,
        );
        const conversations = remapConversationCitations(
          current.conversations,
          source.projectId,
          new Map([...restoredRemap, ...citationRemap]),
        );
        const stillCited = citedCitationIds(conversations);
        // Citations with no refreshed equivalent are kept in a bounded archive
        // so older answers can still name the evidence they were based on, and
        // entries the refresh covers again are dropped from it.
        const archivedCitations = dropRestoredArchivedCitations(
          mergeArchivedCitations(
            (citationId) => stillCited.has(citationId),
            archivedCitationsFromRetired(
              previous?.citations ?? [],
              source.citations,
              citationRemap,
              refreshedAt,
            ),
            current.archivedCitations,
          ),
          source.citations,
          (citationId) => stillCited.has(citationId),
          new Set(restoredRemap.keys()),
        );
        return {
          ...current,
          sources: replaced.sources,
          archivedCitations,
          conversations,
          projects: current.projects.map((project) =>
            project.id === source.projectId
              ? {
                  ...project,
                  sourceCount: replaced.sources.filter(
                    (item) => item.projectId === source.projectId,
                  ).length,
                  updatedAt: refreshedAt,
                }
              : project,
          ),
          tombstones: replaced.retiredSourceId
            ? mergeTombstones(current.tombstones, {
                // Marked as replaced, not merely deleted: the refreshed
                // snapshot already stands in this source's place, so no other
                // device may hand the retired id back.
                sources: createDeletionMarkers(
                  [replaced.retiredSourceId],
                  refreshedAt,
                  { replaced: true },
                ),
              })
            : current.tombstones,
        };
      });
    },
    [],
  );

  const setSourceSchedule = useCallback(
    (sourceId: string, cadence: SourceScheduleCadence | null) => {
      setState((current) => {
        const sources = applySourceSchedule(current.sources, sourceId, cadence);
        return sources ? { ...current, sources } : current;
      });
    },
    [],
  );

  const recordSourceSyncFailure = useCallback(
    (sourceId: string, message: string) => {
      setState((current) => {
        const sources = recordScheduledSyncFailure(
          current.sources,
          sourceId,
          Date.now(),
          message,
        );
        return sources ? { ...current, sources } : current;
      });
    },
    [],
  );

  const claimScheduledSourceSync = useCallback(
    (sourceId: string, claimedBy: string) => {
      setState((current) => {
        const sources = claimScheduledSync(
          current.sources,
          sourceId,
          claimedBy,
          Date.now(),
        );
        return sources ? { ...current, sources } : current;
      });
    },
    [],
  );

  const releaseScheduledSourceSyncClaim = useCallback(
    (sourceId: string, claimedBy: string) => {
      setState((current) => {
        const sources = releaseScheduledSyncClaim(
          current.sources,
          sourceId,
          claimedBy,
        );
        return sources ? { ...current, sources } : current;
      });
    },
    [],
  );

  const removeSource = useCallback((sourceId: string) => {
    setState((current) => {
      const removed = current.sources.find((source) => source.id === sourceId);
      if (!removed) return current;

      const deletedAt = Date.now();
      const sources = current.sources.filter((source) => source.id !== sourceId);
      // Nothing replaces a disconnected source, so its citations go straight
      // into the bounded archive: answers written before the removal keep
      // naming the evidence instead of reading as a generic archived marker.
      // Nothing can cite the removed source any more, so archived evidence no
      // saved answer still points at is dead weight in the synced workspace.
      const stillCited = citedCitationIds(current.conversations);
      const archivedCitations = dropUncitedArchivedCitations(
        mergeArchivedCitations(
          (citationId) => stillCited.has(citationId),
          archivedCitationsFromRemovedSource(removed.citations, deletedAt),
          current.archivedCitations,
        ),
        (citationId) => stillCited.has(citationId),
      );
      return {
        ...current,
        sources,
        archivedCitations,
        projects: current.projects.map((project) =>
          project.id === removed.projectId
            ? {
                ...project,
                sourceCount: sources.filter(
                  (source) => source.projectId === removed.projectId,
                ).length,
                updatedAt: deletedAt,
              }
            : project,
        ),
        tombstones: mergeTombstones(current.tombstones, {
          sources: createDeletionMarkers([sourceId], deletedAt),
        }),
      };
    });
  }, []);

  const addTask = useCallback(
    (projectId: string, title: string, requestedStageId?: string) => {
      const cleanedTitle = title.trim().slice(0, 280);
      if (!cleanedTitle) return;
      const now = Date.now();
      setState((current) => ({
        ...current,
        projects: current.projects.map((project) => {
          if (project.id !== projectId) return project;
          if (project.tasks.length >= 2000) return project;
          const stageId = project.boardStages.some(
            (stage) => stage.id === requestedStageId,
          )
            ? requestedStageId!
            : project.boardStages[0].id;
          const position = project.tasks.filter(
            (task) => task.stageId === stageId,
          ).length;
          const task: Task = {
            id: generateId('task'),
            title: cleanedTitle,
            stageId,
            position,
            createdAt: now,
            updatedAt: now,
            values: {},
          };
          return {
            ...project,
            updatedAt: now,
            tasks: [...project.tasks, task],
          };
        }),
      }));
    },
    [],
  );

  const updateTask = useCallback(
    (
      projectId: string,
      taskId: string,
      updates: {
        title?: string;
        stageId?: string;
        values?: Record<string, BoardValue>;
      },
    ) => {
      const now = Date.now();
      setState((current) => ({
        ...current,
        projects: current.projects.map((project) => {
          if (project.id !== projectId) return project;
          const existing = project.tasks.find((task) => task.id === taskId);
          if (!existing) return project;
          const title =
            updates.title === undefined
              ? existing.title
              : updates.title.trim().slice(0, 280);
          if (!title) return project;
          const stageId =
            updates.stageId &&
            project.boardStages.some((stage) => stage.id === updates.stageId)
              ? updates.stageId
              : existing.stageId;
          const fieldById = new Map(
            project.fieldDefinitions.map((field) => [field.id, field]),
          );
          const values =
            updates.values === undefined
              ? existing.values
              : Object.fromEntries(
                  Object.entries(updates.values).flatMap(
                    ([fieldId, rawValue]) => {
                      const field = fieldById.get(fieldId);
                      if (!field) return [];
                      const normalized = normalizeBoardValue(field, rawValue);
                      return normalized === undefined
                        ? []
                        : [[fieldId, normalized]];
                    },
                  ),
                );
          const movedToNewStage = stageId !== existing.stageId;
          const nextTask: Task = {
            ...existing,
            title,
            stageId,
            position: movedToNewStage
              ? project.tasks.filter((task) => task.stageId === stageId).length
              : existing.position,
            values,
            updatedAt: now,
          };
          return compactBoardPositions({
            ...project,
            updatedAt: now,
            tasks: project.tasks.map((task) =>
              task.id === taskId ? nextTask : task,
            ),
          });
        }),
      }));
    },
    [],
  );

  const moveTask = useCallback(
    (
      projectId: string,
      taskId: string,
      requestedStageId: string,
      requestedPosition: number,
    ) => {
      const now = Date.now();
      setState((current) => ({
        ...current,
        projects: current.projects.map((project) => {
          if (project.id !== projectId) return project;
          const task = project.tasks.find((item) => item.id === taskId);
          if (
            !task ||
            !project.boardStages.some(
              (stage) => stage.id === requestedStageId,
            )
          ) {
            return project;
          }
          const otherTasks = project.tasks.filter(
            (item) =>
              item.id !== taskId && item.stageId === requestedStageId,
          );
          const position = Math.max(
            0,
            Math.min(Math.floor(requestedPosition), otherTasks.length),
          );
          otherTasks.splice(position, 0, {
            ...task,
            stageId: requestedStageId,
            updatedAt: now,
          });
          const movedIds = new Set(otherTasks.map((item) => item.id));
          const untouched = project.tasks.filter(
            (item) => !movedIds.has(item.id) && item.id !== taskId,
          );
          return compactBoardPositions({
            ...project,
            updatedAt: now,
            tasks: [
              ...untouched,
              ...otherTasks.map((item, index) => ({
                ...item,
                position: index,
                updatedAt:
                  item.position === index &&
                  item.stageId === requestedStageId &&
                  item.id !== taskId
                    ? item.updatedAt
                    : now,
              })),
            ],
          });
        }),
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

  const addStage = useCallback(
    (projectId: string, name: string, isDone: boolean) => {
      const cleanedName = name.trim().slice(0, 80);
      if (!cleanedName) return;
      const now = Date.now();
      setState((current) => ({
        ...current,
        projects: current.projects.map((project) =>
          project.id === projectId &&
          project.boardStages.length < 30 &&
          !project.boardStages.some(
            (stage) =>
              normalizeLabel(stage.name) === normalizeLabel(cleanedName),
          )
            ? {
                ...project,
                updatedAt: now,
                boardStages: [
                  ...project.boardStages,
                  {
                    id: generateId('stage'),
                    name: cleanedName,
                    position: project.boardStages.length,
                    isDone,
                    updatedAt: now,
                  },
                ],
              }
            : project,
        ),
      }));
    },
    [],
  );

  const updateStage = useCallback(
    (
      projectId: string,
      stageId: string,
      updates: { name?: string; isDone?: boolean },
    ) => {
      const cleanedName = updates.name?.trim().slice(0, 80);
      if (updates.name !== undefined && !cleanedName) return;
      const now = Date.now();
      setState((current) => ({
        ...current,
        projects: current.projects.map((project) => {
          if (project.id !== projectId) return project;
          if (
            cleanedName &&
            project.boardStages.some(
              (stage) =>
                stage.id !== stageId &&
                normalizeLabel(stage.name) === normalizeLabel(cleanedName),
            )
          ) {
            return project;
          }
          if (
            updates.isDone === false &&
            project.boardStages.find((stage) => stage.id === stageId)?.isDone &&
            project.boardStages.filter((stage) => stage.isDone).length === 1
          ) {
            return project;
          }
          return {
            ...project,
            updatedAt: now,
            boardStages: project.boardStages.map((stage) =>
              stage.id === stageId
                ? {
                    ...stage,
                    ...(cleanedName ? { name: cleanedName } : {}),
                    ...(updates.isDone === undefined
                      ? {}
                      : { isDone: updates.isDone }),
                    updatedAt: now,
                  }
                : stage,
            ),
          };
        }),
      }));
    },
    [],
  );

  const reorderStage = useCallback(
    (projectId: string, stageId: string, requestedPosition: number) => {
      const now = Date.now();
      setState((current) => ({
        ...current,
        projects: current.projects.map((project) => {
          if (project.id !== projectId) return project;
          const stages = [...project.boardStages].sort(
            (left, right) => left.position - right.position,
          );
          const index = stages.findIndex((stage) => stage.id === stageId);
          if (index < 0) return project;
          const [stage] = stages.splice(index, 1);
          const position = Math.max(
            0,
            Math.min(Math.floor(requestedPosition), stages.length),
          );
          stages.splice(position, 0, stage);
          return {
            ...project,
            updatedAt: now,
            boardStages: stages.map((item, nextPosition) =>
              item.position === nextPosition
                ? item
                : { ...item, position: nextPosition, updatedAt: now },
            ),
          };
        }),
      }));
    },
    [],
  );

  const removeStage = useCallback(
    (
      projectId: string,
      stageId: string,
      reassignToStageId: string,
    ) => {
      const now = Date.now();
      setState((current) => {
        const project = current.projects.find((item) => item.id === projectId);
        if (
          !project ||
          project.boardStages.length <= 1 ||
          stageId === reassignToStageId ||
          !project.boardStages.some(
            (stage) => stage.id === reassignToStageId,
          )
        ) {
          return current;
        }
        return {
          ...current,
          projects: current.projects.map((item) =>
            item.id === projectId
              ? compactBoardPositions({
                  ...item,
                  updatedAt: now,
                  boardStages: item.boardStages
                    .filter((stage) => stage.id !== stageId)
                    .map((stage) =>
                      stage.id === reassignToStageId &&
                      project.boardStages.find(
                        (candidate) => candidate.id === stageId,
                      )?.isDone &&
                      project.boardStages.filter((candidate) => candidate.isDone)
                        .length === 1
                        ? { ...stage, isDone: true, updatedAt: now }
                        : stage,
                    ),
                  tasks: item.tasks.map((task) =>
                    task.stageId === stageId
                      ? {
                          ...task,
                          stageId: reassignToStageId,
                          position: item.tasks.filter(
                            (candidate) =>
                              candidate.stageId === reassignToStageId,
                          ).length,
                          updatedAt: now,
                        }
                      : task,
                  ),
                })
              : item,
          ),
          tombstones: mergeTombstones(current.tombstones, {
            stages: createDeletionMarkers([stageId], now),
          }),
        };
      });
    },
    [],
  );

  const addFieldDefinition = useCallback(
    (
      projectId: string,
      input: {
        name: string;
        type: KanbanFieldType;
        options?: string[];
        showOnCard?: boolean;
      },
    ) => {
      const name = input.name.trim().slice(0, 80);
      if (!name) return;
      const now = Date.now();
      const options = normalizeFieldOptions(input.options ?? []);
      setState((current) => ({
        ...current,
        projects: current.projects.map((project) =>
          project.id === projectId &&
          project.fieldDefinitions.length < 40 &&
          !project.fieldDefinitions.some(
            (field) => normalizeLabel(field.name) === normalizeLabel(name),
          )
            ? {
                ...project,
                updatedAt: now,
                fieldDefinitions: [
                  ...project.fieldDefinitions,
                  {
                    id: generateId('field'),
                    name,
                    type: input.type,
                    options:
                      input.type === 'single_select' ? options : [],
                    position: project.fieldDefinitions.length,
                    showOnCard: input.showOnCard ?? true,
                    updatedAt: now,
                  },
                ],
              }
            : project,
        ),
      }));
    },
    [],
  );

  const updateFieldDefinition = useCallback(
    (
      projectId: string,
      fieldId: string,
      updates: {
        name?: string;
        options?: string[];
        showOnCard?: boolean;
      },
    ) => {
      const name = updates.name?.trim().slice(0, 80);
      if (updates.name !== undefined && !name) return;
      const now = Date.now();
      setState((current) => ({
        ...current,
        projects: current.projects.map((project) => {
          if (project.id !== projectId) return project;
          const existingField = project.fieldDefinitions.find(
            (field) => field.id === fieldId,
          );
          if (!existingField) return project;
          if (
            name &&
            project.fieldDefinitions.some(
              (field) =>
                field.id !== fieldId &&
                normalizeLabel(field.name) === normalizeLabel(name),
            )
          ) {
            return project;
          }
          const nextOptions =
            updates.options !== undefined &&
            existingField.type === 'single_select'
              ? normalizeFieldOptions(updates.options)
              : existingField.options;
          if (
            existingField.type === 'single_select' &&
            nextOptions.length === 0
          ) {
            return project;
          }
          return {
            ...project,
            updatedAt: now,
            fieldDefinitions: project.fieldDefinitions.map((field) =>
              field.id === fieldId
                ? {
                    ...field,
                    ...(name ? { name } : {}),
                    ...(updates.options === undefined ||
                    field.type !== 'single_select'
                      ? {}
                      : { options: nextOptions }),
                    ...(updates.showOnCard === undefined
                      ? {}
                      : { showOnCard: updates.showOnCard }),
                    updatedAt: now,
                  }
                : field,
            ),
            tasks:
              updates.options === undefined ||
              existingField.type !== 'single_select'
                ? project.tasks
                : project.tasks.map((task) => {
                    const currentValue = task.values[fieldId];
                    if (
                      typeof currentValue !== 'string' ||
                      nextOptions.includes(currentValue)
                    ) {
                      return task;
                    }
                    const values = { ...task.values };
                    delete values[fieldId];
                    return { ...task, values, updatedAt: now };
                  }),
          };
        }),
      }));
    },
    [],
  );

  const reorderFieldDefinition = useCallback(
    (projectId: string, fieldId: string, requestedPosition: number) => {
      const now = Date.now();
      setState((current) => ({
        ...current,
        projects: current.projects.map((project) => {
          if (project.id !== projectId) return project;
          const fields = [...project.fieldDefinitions].sort(
            (left, right) => left.position - right.position,
          );
          const index = fields.findIndex((field) => field.id === fieldId);
          if (index < 0) return project;
          const [field] = fields.splice(index, 1);
          const position = Math.max(
            0,
            Math.min(Math.floor(requestedPosition), fields.length),
          );
          fields.splice(position, 0, field);
          return {
            ...project,
            updatedAt: now,
            fieldDefinitions: fields.map((item, nextPosition) =>
              item.position === nextPosition
                ? item
                : { ...item, position: nextPosition, updatedAt: now },
            ),
          };
        }),
      }));
    },
    [],
  );

  const removeFieldDefinition = useCallback(
    (projectId: string, fieldId: string) => {
      const now = Date.now();
      setState((current) => {
        const project = current.projects.find((item) => item.id === projectId);
        if (!project) return current;
        return {
          ...current,
          projects: current.projects.map((item) =>
            item.id === projectId
              ? compactBoardPositions({
                  ...item,
                  updatedAt: now,
                  fieldDefinitions: item.fieldDefinitions.filter(
                    (field) => field.id !== fieldId,
                  ),
                  tasks: item.tasks.map((task) => {
                    const values = { ...task.values };
                    delete values[fieldId];
                    return {
                      ...task,
                      values,
                      updatedAt:
                        fieldId in task.values ? now : task.updatedAt,
                    };
                  }),
                })
              : item,
          ),
          tombstones: mergeTombstones(current.tombstones, {
            fields: createDeletionMarkers([fieldId], now),
          }),
        };
      });
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
  // desktop app's fileConversationToProject
  // (artifacts/venom-desktop/src/context/VenomWorkspaceContext.tsx).
  const fileConversationToProject = useCallback(
    (conversationId: string, projectId: string) => {
      setState((current) =>
        fileConversationToProjectInState(current, conversationId, projectId),
      );
    },
    [],
  );

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
        ...current,
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
      setState((current) => ({
        ...current,
        ...applyKnowledgeInsightsToState({
          state: current,
          conversation,
          insights,
          now,
          generateId,
        }),
      }));
    },
    [],
  );

  const applyFiledKnowledge = useCallback(
    (
      conversation: Pick<Conversation, 'id' | 'title' | 'projectId'>,
      filed: KnowledgeCluster[],
    ) => {
      const now = Date.now();
      setState((current) => ({
        ...current,
        ...applyFiledClustersToState({
          state: current,
          conversation,
          filed,
          now,
        }),
      }));
    },
    [],
  );

  const fileKnowledgeNote = useCallback(
    (input: {
      userId: string;
      projectId: string;
      note: string;
      insights: KnowledgeInsight[];
    }): FileKnowledgeNoteStatus | 'account_changed' => {
      if (
        activeUserIdRef.current !== input.userId ||
        hydratedUserRef.current !== input.userId
      ) {
        return 'account_changed';
      }

      const result = fileKnowledgeNoteToState({
        state: latestStateRef.current,
        projectId: input.projectId,
        note: input.note,
        insights: input.insights,
        now: Date.now(),
        generateId,
      });
      if (result.status === 'filed') {
        const filedState = {
          ...latestStateRef.current,
          ...result.state,
        };
        latestStateRef.current = filedState;
        setState(filedState);
      }
      return result.status;
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

  // "Keep personal" for an Unsorted item: clear the author-private holding
  // flag so the concept becomes ordinary personal knowledge. Bumping
  // lastUpdatedAt lets the cleared state win the cross-device merge and the
  // next snapshot sync, mirroring desktop exactly.
  const markKnowledgeClusterSorted = useCallback((clusterId: string) => {
    const updatedAt = Date.now();
    setState((current) => {
      const cluster = current.clusters.find((item) => item.id === clusterId);
      if (!cluster || cluster.unsorted !== true) return current;
      return {
        ...current,
        clusters: current.clusters.map((item) => {
          if (item.id !== clusterId) return item;
          const next = { ...item, lastUpdatedAt: updatedAt };
          delete next.unsorted;
          return next;
        }),
      };
    });
  }, []);

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

  const enableModel = useCallback((modelId: VenomModelId) => {
    if (!ALL_MODEL_IDS_CONST.includes(modelId)) return;
    const now = Date.now();
    setState((current) => {
      const prefs = normalizeModelPreferences(current.modelPreferences);
      if (prefs.enabledModelIds.includes(modelId)) return current;
      return {
        ...current,
        modelPreferences: normalizeModelPreferences({
          ...prefs,
          enabledModelIds: [...prefs.enabledModelIds, modelId],
          updatedAt: now,
        }),
      };
    });
  }, []);

  const removeModel = useCallback((modelId: VenomModelId) => {
    if (!ALL_MODEL_IDS_CONST.includes(modelId)) return;
    const now = Date.now();
    setState((current) => {
      const prefs = normalizeModelPreferences(current.modelPreferences);
      // Cannot remove the last enabled model.
      if (prefs.enabledModelIds.length <= 1) return current;
      if (!prefs.enabledModelIds.includes(modelId)) return current;
      const nextEnabled = prefs.enabledModelIds.filter((id) => id !== modelId);
      // Recover default and active if they pointed to the removed model.
      const nextDefault = nextEnabled.includes(prefs.defaultModelId)
        ? prefs.defaultModelId
        : nextEnabled[0];
      const nextActive = nextEnabled.includes(prefs.activeModelId)
        ? prefs.activeModelId
        : nextDefault;
      return {
        ...current,
        modelPreferences: normalizeModelPreferences({
          enabledModelIds: nextEnabled,
          defaultModelId: nextDefault,
          activeModelId: nextActive,
          updatedAt: now,
        }),
      };
    });
  }, []);

  const setDefaultModel = useCallback((modelId: VenomModelId) => {
    if (!ALL_MODEL_IDS_CONST.includes(modelId)) return;
    const now = Date.now();
    setState((current) => {
      const prefs = normalizeModelPreferences(current.modelPreferences);
      if (!prefs.enabledModelIds.includes(modelId)) return current;
      return {
        ...current,
        modelPreferences: normalizeModelPreferences({
          ...prefs,
          defaultModelId: modelId,
          updatedAt: now,
        }),
      };
    });
  }, []);

  const setActiveModel = useCallback((modelId: VenomModelId) => {
    if (!ALL_MODEL_IDS_CONST.includes(modelId)) return;
    const now = Date.now();
    setState((current) => {
      const prefs = normalizeModelPreferences(current.modelPreferences);
      if (!prefs.enabledModelIds.includes(modelId)) return current;
      return {
        ...current,
        modelPreferences: normalizeModelPreferences({
          ...prefs,
          activeModelId: modelId,
          updatedAt: now,
        }),
      };
    });
  }, []);

  const setModelSelectionPolicy = useCallback(
    (policy: VenomModelSelectionPolicy) => {
      if (
        policy !== 'manual' &&
        policy !== 'auto-cheapest' &&
        policy !== 'auto-max-power'
      ) {
        return;
      }
      const now = Date.now();
      setState((current) => {
        const prefs = normalizeModelPreferences(current.modelPreferences);
        if ((prefs.selectionPolicy ?? 'manual') === policy) return current;
        return {
          ...current,
          modelPreferences: normalizeModelPreferences({
            ...prefs,
            selectionPolicy: policy,
            updatedAt: now,
          }),
        };
      });
    },
    [],
  );

  const setVoicePreset = useCallback((presetId: VenomVoicePresetId) => {
    const now = Date.now();
    setState((current) => {
      const existing = normalizeVoicePreferences(current.voicePreferences);
      const next = normalizeVoicePreferences({
        ...existing,
        presetId,
        updatedAt: now,
      });
      // Reject unknown ids (normalize recovers them to the default voice,
      // which is only correct when the caller actually asked for it).
      if (next.presetId !== presetId) return current;
      if (existing.presetId === next.presetId) return current;
      return { ...current, voicePreferences: next };
    });
  }, []);

  const setVoiceTalkativeness = useCallback(
    (talkativeness: VenomVoiceTalkativeness) => {
      const now = Date.now();
      setState((current) => {
        const existing = normalizeVoicePreferences(current.voicePreferences);
        const next = normalizeVoicePreferences({
          ...existing,
          talkativeness,
          updatedAt: now,
        });
        // Reject unknown levels (normalize recovers them to balanced, which
        // is only correct when the caller actually asked for it).
        if (next.talkativeness !== talkativeness) return current;
        if (existing.talkativeness === next.talkativeness) return current;
        return { ...current, voicePreferences: next };
      });
    },
    [],
  );

  // Response-mode and blend preferences ride on the conversation but merge by
  // their own stamp, so setting them must NOT bump conversation.updatedAt —
  // that would distort the content merge between devices.
  const setConversationResponsePrefs = useCallback(
    (
      conversationId: string,
      prefs: {
        responseMode?: VenomResponseMode;
        blend?: VenomConversationBlend | null;
      },
    ) => {
      const now = Date.now();
      setState((current) => {
        const existing = current.conversations.find(
          (conversation) => conversation.id === conversationId,
        );
        if (!existing) return current;
        const next: Conversation = { ...existing };
        if (prefs.responseMode !== undefined && isResponseMode(prefs.responseMode)) {
          next.responseMode = prefs.responseMode;
        }
        if (prefs.blend === null) {
          delete next.blend;
        } else if (prefs.blend !== undefined) {
          const blend = normalizeConversationBlend(prefs.blend);
          if (blend) next.blend = blend;
        }
        next.modeUpdatedAt = now;
        return {
          ...current,
          conversations: current.conversations.map((conversation) =>
            conversation.id === conversationId ? next : conversation,
          ),
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
      lastSyncedState,
      hasPendingLegacyImport,
      importDeviceWorkspace,
      orgs,
      orgInvites,
      refreshOrgs,
      startFreshWorkspace,
      addProject,
      updateProject,
      deleteProject,
      pendingProjectRestore,
      restoreDeletedProject,
      dismissProjectRestore,
      setActiveProject,
      addSource,
      refreshSource,
      setSourceSchedule,
      recordSourceSyncFailure,
      claimScheduledSourceSync,
      releaseScheduledSourceSyncClaim,
      removeSource,
      addTask,
      updateTask,
      moveTask,
      deleteTask,
      addStage,
      updateStage,
      reorderStage,
      removeStage,
      addFieldDefinition,
      updateFieldDefinition,
      reorderFieldDefinition,
      removeFieldDefinition,
      addMessage,
      updateMessage,
      setActiveConversation,
      fileConversationToProject,
      clearConversation,
      createNewConversation,
      applyKnowledgeInsights,
      applyFiledKnowledge,
      fileKnowledgeNote,
      renameKnowledgeCluster,
      markKnowledgeClusterSorted,
      deleteKnowledgeCluster,
      mergeKnowledgeClusters,
      enableModel,
      removeModel,
      setDefaultModel,
      setActiveModel,
      setModelSelectionPolicy,
      setVoicePreset,
      setVoiceTalkativeness,
      setConversationResponsePrefs,
    }),
    [
      addMessage,
      addFieldDefinition,
      addProject,
      addSource,
      addStage,
      addTask,
      applyKnowledgeInsights,
      applyFiledKnowledge,
      claimScheduledSourceSync,
      clearConversation,
      createNewConversation,
      deleteProject,
      deleteTask,
      dismissProjectRestore,
      hasPendingLegacyImport,
      importDeviceWorkspace,
      isReady,
      lastSyncedAt,
      lastSyncedState,
      fileKnowledgeNote,
      mergeKnowledgeClusters,
      moveTask,
      orgs,
      orgInvites,
      pendingProjectRestore,
      refreshOrgs,
      recordSourceSyncFailure,
      refreshSource,
      releaseScheduledSourceSyncClaim,
      restoreDeletedProject,
      renameKnowledgeCluster,
      markKnowledgeClusterSorted,
      removeFieldDefinition,
      removeSource,
      removeStage,
      reorderFieldDefinition,
      reorderStage,
      setActiveConversation,
      fileConversationToProject,
      setActiveProject,
      setSourceSchedule,
      state,
      startFreshWorkspace,
      syncStatus,
      deleteKnowledgeCluster,
      updateMessage,
      updateFieldDefinition,
      updateProject,
      updateStage,
      updateTask,
      enableModel,
      removeModel,
      setDefaultModel,
      setActiveModel,
      setModelSelectionPolicy,
      setVoicePreset,
      setVoiceTalkativeness,
      setConversationResponsePrefs,
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

export type KanbanFieldType = VenomKanbanFieldType;

export type KanbanField = VenomKanbanField;
