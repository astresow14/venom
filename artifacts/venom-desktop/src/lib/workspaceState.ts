/**
 * Pure state utilities for VenomWorkspace – no React, no I/O.
 * Mirrors mobile knowledgeState.ts + VenomContext.tsx merge helpers,
 * re-typed against the generated VenomWorkspaceState contract.
 *
 * The cross-device merge rules (deletion markers, tombstones, connected
 * sources, scheduled-sync claims) are NOT defined here: they live in
 * @workspace/venom-workspace-merge, shared with the phone app, and are
 * re-exported below. workspaceMergeRules.test.mjs fails if these bindings
 * stop pointing at the shared implementations.
 */

import {
  createDeletionMarkers,
  createEmptyTombstones,
  mergeProjectSources,
  mergeTombstones,
  normalizeTombstones,
  positionForNewCluster,
  separateStackedClusters,
} from '@workspace/venom-workspace-merge';
import type {
  VenomArchivedCitation,
  VenomConversation,
  VenomDeletionMarker,
  VenomKnowledgeCluster,
  VenomKnowledgeSource,
  VenomProject,
  VenomWorkspaceState,
  VenomWorkspaceTombstones,
  KnowledgeCandidate,
  VenomModelPreferences,
  VenomModelId,
  VenomVoicePreferences,
  VenomVoicePresetId,
  VenomVoiceTalkativeness,
  VenomOrg,
  VenomOrgSharedProject,
} from '@workspace/api-client-react';
import {
  availableTaskStatuses,
  createDefaultBoardStages,
  mergeProjectBoardSnapshots,
  normalizeProjectBoard,
  stageIdForTaskStatus,
  taskStatusForProject,
} from './boardState.ts';
import {
  mergeConversationResponsePrefs,
  normalizeConversationResponsePrefs,
} from './blend.ts';
import {
  citationUrlIdentity,
  citedCitationIds,
} from './messageCitations.ts';
import {
  createFallbackWorkspaceProject,
  mostRecentlyUpdatedProjectId,
} from './projectLifecycle.ts';

export {
  availableTaskStatuses,
  createDefaultBoardStages,
  stageIdForTaskStatus,
  taskStatusForProject,
};

// ---------------------------------------------------------------------------
// Re-exported type aliases (keep callers from importing the schema directly)
// ---------------------------------------------------------------------------

export type WorkspaceState = VenomWorkspaceState;
export type Project = VenomProject;
export type Conversation = VenomConversation;
export type KnowledgeCluster = VenomKnowledgeCluster;
export type KnowledgeSource = VenomKnowledgeSource;
export type KnowledgeInsight = KnowledgeCandidate;
export type WorkspaceTombstones = VenomWorkspaceTombstones;
export type DeletionMarker = VenomDeletionMarker;
export type TombstoneCollection = keyof WorkspaceTombstones;
export type ModelPreferences = VenomModelPreferences;
export type { VenomModelId };

export type VoicePreferences = VenomVoicePreferences;
const DEFAULT_MODEL_ID: VenomModelId = 'venom-gpt';

/** All known model IDs in display order */
export const ALL_MODEL_IDS: VenomModelId[] = [
  'venom-gpt',
  'venom-claude',
  'venom-gemini',
  'venom-grok',
];

export function createDefaultModelPreferences(): ModelPreferences {
  return {
    enabledModelIds: [DEFAULT_MODEL_ID],
    defaultModelId: DEFAULT_MODEL_ID,
    activeModelId: DEFAULT_MODEL_ID,
    updatedAt: 0,
  };
}

/**
 * Normalize model preferences, guarding against stale / missing data.
 * Keeps the contract: at least one enabled model, active/default are enabled.
 */
export function normalizeModelPreferences(
  raw: Partial<ModelPreferences> | null | undefined,
): ModelPreferences {
  if (!raw) return createDefaultModelPreferences();

  const validIds = new Set<string>(ALL_MODEL_IDS);
  const enabled = (raw.enabledModelIds ?? []).filter((id) =>
    validIds.has(id),
  ) as VenomModelId[];
  if (enabled.length === 0) enabled.push(DEFAULT_MODEL_ID);

  const defaultId: VenomModelId = validIds.has(raw.defaultModelId ?? '')
    ? (raw.defaultModelId as VenomModelId)
    : enabled[0];
  const effectiveDefault = enabled.includes(defaultId) ? defaultId : enabled[0];

  const activeId: VenomModelId = validIds.has(raw.activeModelId ?? '')
    ? (raw.activeModelId as VenomModelId)
    : effectiveDefault;
  const effectiveActive = enabled.includes(activeId) ? activeId : effectiveDefault;

  // Selection policy is optional and additive: valid values are kept
  // verbatim (so cross-device merges never drop them), anything unknown is
  // dropped, and absence means manual — exactly today's behavior.
  const selectionPolicy =
    raw.selectionPolicy === 'manual' ||
    raw.selectionPolicy === 'auto-cheapest' ||
    raw.selectionPolicy === 'auto-max-power'
      ? raw.selectionPolicy
      : undefined;

  return {
    enabledModelIds: enabled,
    defaultModelId: effectiveDefault,
    activeModelId: effectiveActive,
    ...(selectionPolicy ? { selectionPolicy } : {}),
    updatedAt: typeof raw.updatedAt === 'number' ? raw.updatedAt : 0,
  };
}

/**
 * Merge two ModelPreferences snapshots. The one with higher `updatedAt`
 * wins, but we always ensure at least one enabled model survives.
 */
export function mergeModelPreferences(
  cloud: ModelPreferences | undefined,
  device: ModelPreferences | undefined,
): ModelPreferences {
  if (!cloud && !device) return createDefaultModelPreferences();
  if (!cloud) return normalizeModelPreferences(device);
  if (!device) return normalizeModelPreferences(cloud);

  // Higher updatedAt wins
  const winner = device.updatedAt >= cloud.updatedAt ? device : cloud;
  return normalizeModelPreferences(winner);
}

const DEFAULT_VOICE_PRESET_ID: VenomVoicePresetId = 'sam';
export type SyncStatus =
  | 'loading'
  | 'pending'
  | 'syncing'
  | 'synced'
  | 'offline'
  | 'too_large'
  | 'error';

// ---------------------------------------------------------------------------
// ID generation
// ---------------------------------------------------------------------------

export function generateId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID()}`;
}

// ---------------------------------------------------------------------------
// Label normalisation
// ---------------------------------------------------------------------------

export const normalizeLabel = (label: string) => label.trim().toLocaleLowerCase();

// ---------------------------------------------------------------------------
// Tombstone helpers — shared cross-device merge rules
// ---------------------------------------------------------------------------
// Re-exported from @workspace/venom-workspace-merge so desktop callers keep
// this import path while both apps run the identical implementations.

export {
  createDeletionMarkers,
  createEmptyTombstones,
  isReplacementMarker,
  mergeDeletionMarkers,
  mergeProjectSources,
  mergeTombstones,
  normalizeTombstones,
  scheduleSyncClaim,
  SCHEDULED_SYNC_CLAIM_LEASE_MS,
  type ScheduledSyncClaim,
  CLUSTER_PLACEMENT_CLEARANCE,
  CLUSTER_SPACING_FLOOR,
  hashPositionForLabel,
  placeClusterPosition,
  positionForNewCluster,
  separateStackedClusters,
  type ClusterMapPoint,
  // Undo for project deletion: the capture/restore pair is shared with the
  // phone app so both platforms rebuild a deleted project under fresh ids by
  // exactly the same rules (the delete's tombstones stay authoritative).
  captureProjectRestoreSnapshot,
  restoreProjectFromSnapshot,
  PROJECT_RESTORE_WINDOW_MS,
  type ProjectRestoreSnapshot,
} from '@workspace/venom-workspace-merge';

function deletionTimeMap(markers: DeletionMarker[]): Map<string, number> {
  return new Map(markers.map((m) => [m.id, m.deletedAt]));
}

// ---------------------------------------------------------------------------
// Default state
// ---------------------------------------------------------------------------

const defaultClusters: KnowledgeCluster[] = [
  {
    id: '1',
    projectId: 'proj_default',
    label: 'Product Context',
    category: 'core',
    strength: 1,
    x: 50,
    y: 50,
    links: ['2', '3'],
    description: 'The main ideas and structure that shape this workspace.',
    summary: 'The main ideas and structure that shape this workspace.',
    mentionCount: 1,
    lastUpdatedAt: 0,
    sources: [],
  },
  {
    id: '2',
    projectId: 'proj_default',
    label: 'Active Work',
    category: 'tactical',
    strength: 0.8,
    x: 120,
    y: -30,
    links: ['1', '4'],
    description: 'Current capabilities, plans, and work in progress.',
    summary: 'Current capabilities, plans, and work in progress.',
    mentionCount: 1,
    lastUpdatedAt: 0,
    sources: [],
  },
  {
    id: '3',
    projectId: 'proj_default',
    label: 'Decisions and History',
    category: 'memory',
    strength: 0.9,
    x: -80,
    y: 60,
    links: ['1'],
    description: 'Decisions and context retained from earlier work.',
    summary: 'Decisions and context retained from earlier work.',
    mentionCount: 1,
    lastUpdatedAt: 0,
    sources: [],
  },
  {
    id: '4',
    projectId: 'proj_default',
    label: 'External Context',
    category: 'external',
    strength: 0.5,
    x: 200,
    y: 10,
    links: ['2'],
    description: 'Services, APIs, and other context referenced by the project.',
    summary: 'Services, APIs, and other context referenced by the project.',
    mentionCount: 1,
    lastUpdatedAt: 0,
    sources: [],
  },
  {
    id: '5',
    projectId: 'proj_default',
    label: 'Working Preferences',
    category: 'memory',
    strength: 0.7,
    x: -40,
    y: -90,
    links: ['3', '1'],
    description: 'Preferences and context learned through collaboration.',
    summary: 'Preferences and context learned through collaboration.',
    mentionCount: 1,
    lastUpdatedAt: 0,
    sources: [],
  },
];

export function createDefaultState(): WorkspaceState {
  const now = Date.now();
  const boardStages = createDefaultBoardStages('proj_default', now);
  return {
    projects: [
      {
        id: 'proj_default',
        name: 'General',
        description: 'Uncategorized intelligence',
        accent: '#e5e5e5',
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
    clusters: defaultClusters,
    sources: [],
    activeProjectId: 'proj_default',
    activeConversationId: 'conv_default',
    tombstones: createEmptyTombstones(),
    modelPreferences: createDefaultModelPreferences(),
    voicePreferences: createDefaultVoicePreferences(),
  };
}

// ---------------------------------------------------------------------------
// Retired-citation archive (mirrors artifacts/venom/context/workspaceSync.ts)
// ---------------------------------------------------------------------------

export const ARCHIVED_CITATION_LIMIT = 500;

/**
 * Merges retired-citation archives, deduplicated by citation id (newest
 * retirement wins) and sorted newest first. When the merged archive exceeds
 * the cap, entries a saved answer still cites survive eviction ahead of
 * uncited ones, oldest-first within each group — the uncited pile a refresh
 * archives wholesale must never push out evidence an answer still names.
 * Uncited entries are only deprioritized, never dropped while there is room:
 * another device's unsynced answers may cite ids this device considers
 * uncited. Must apply the same eviction order as the mobile copy in
 * artifacts/venom/context/workspaceSync.ts or the two apps' syncs would
 * flip-flop over which entries survive the cap.
 */
export function mergeArchivedCitations(
  isStillCited: (citationId: string) => boolean,
  ...archiveLists: (VenomArchivedCitation[] | undefined)[]
): VenomArchivedCitation[] {
  const merged = new Map<string, VenomArchivedCitation>();
  for (const entry of archiveLists.flatMap((list) => list ?? [])) {
    if (
      !entry ||
      typeof entry.id !== 'string' ||
      !entry.id ||
      typeof entry.title !== 'string' ||
      !entry.title ||
      typeof entry.url !== 'string' ||
      typeof entry.retiredAt !== 'number'
    ) {
      continue;
    }
    const existing = merged.get(entry.id);
    if (!existing || entry.retiredAt > existing.retiredAt) {
      merged.set(entry.id, entry);
    }
  }
  const newestFirst = [...merged.values()].sort(
    (left, right) => right.retiredAt - left.retiredAt,
  );
  if (newestFirst.length <= ARCHIVED_CITATION_LIMIT) return newestFirst;

  const cited: VenomArchivedCitation[] = [];
  const uncited: VenomArchivedCitation[] = [];
  for (const entry of newestFirst) {
    (isStillCited(entry.id) ? cited : uncited).push(entry);
  }
  if (cited.length >= ARCHIVED_CITATION_LIMIT) {
    return cited.slice(0, ARCHIVED_CITATION_LIMIT);
  }
  const kept = new Set<VenomArchivedCitation>([
    ...cited,
    ...uncited.slice(0, ARCHIVED_CITATION_LIMIT - cited.length),
  ]);
  return newestFirst.filter((entry) => kept.has(entry));
}

/**
 * Drops archive entries a refreshed source covers again, so evidence that came
 * back stops consuming the bounded archive and the workspace payload. An entry
 * whose id is live once more is pure dead weight: the renderer always prefers
 * the live citation for that id. An entry the refresh only covers under a new
 * id is dropped once nothing cites the archived id any more (a refresh remaps
 * those markers onto the live citation first), so no answer loses the title it
 * was rendering.
 */
export function dropRestoredArchivedCitations(
  archivedCitations: VenomArchivedCitation[] | undefined,
  refreshedCitations: readonly { id: string; url: string }[],
  isStillCited: (citationId: string) => boolean = () => false,
): VenomArchivedCitation[] {
  const restoredIds = new Set(
    refreshedCitations.map((citation) => citation.id),
  );
  const restoredUrls = new Set(
    refreshedCitations
      .map((citation) => citationUrlIdentity(citation.url))
      .filter(Boolean),
  );

  return (archivedCitations ?? []).filter((entry) => {
    if (!entry?.id) return false;
    if (restoredIds.has(entry.id)) return false;
    const identity = citationUrlIdentity(entry.url);
    if (identity && restoredUrls.has(identity) && !isStillCited(entry.id)) {
      return false;
    }
    return true;
  });
}

/**
 * Drops archive entries no saved answer can reference any more — the evidence
 * that only the conversations of a deleted project (or an unused source) ever
 * cited.
 */
export function dropUncitedArchivedCitations(
  archivedCitations: VenomArchivedCitation[] | undefined,
  isStillCited: (citationId: string) => boolean,
): VenomArchivedCitation[] {
  return (archivedCitations ?? []).filter(
    (entry) => Boolean(entry?.id) && isStillCited(entry.id),
  );
}

// ---------------------------------------------------------------------------
// State validation & normalisation
// ---------------------------------------------------------------------------

export function isWorkspaceState(value: unknown): value is WorkspaceState {
  if (!value || typeof value !== 'object') return false;
  const c = value as Partial<WorkspaceState>;
  return Array.isArray(c.projects) && Array.isArray(c.conversations) && Array.isArray(c.clusters);
}

export function normalizeWorkspaceState(value: WorkspaceState): WorkspaceState {
  const rawArchive = Array.isArray(value.archivedCitations)
    ? value.archivedCitations
    : [];
  // Cap eviction only consults citedness once the archive overflows, which a
  // payload written by any current path never does — so the conversation scan
  // is deferred until the one case that needs it, and every path that can cap
  // applies the same eviction order (mirrors the mobile normalize).
  const stillCited =
    rawArchive.length > ARCHIVED_CITATION_LIMIT
      ? citedCitationIds(
          value.conversations.filter((conversation) =>
            Array.isArray(conversation?.messages),
          ),
        )
      : null;
  return {
    ...value,
    projects: value.projects.map((project) =>
      normalizeDefaultProjectName(
        normalizeProjectOrgFields(normalizeProjectBoard(project)),
      ),
    ),
    conversations: value.conversations.map((conversation) =>
      normalizeConversationResponsePrefs(conversation),
    ),
    sources: Array.isArray(value.sources) ? value.sources : [],
    // Stored positions that bury each other are separated on every load path
    // (same rule on the phone), so a stack persisted by an older build heals
    // identically on both apps instead of surviving forever.
    clusters: separateStackedClusters(
      value.clusters.map((cluster) => {
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
          summary: typeof cluster.summary === 'string' ? cluster.summary : legacyDescription,
          mentionCount: typeof cluster.mentionCount === 'number' ? cluster.mentionCount : 1,
          lastUpdatedAt: typeof cluster.lastUpdatedAt === 'number' ? cluster.lastUpdatedAt : 0,
          sources: Array.isArray(cluster.sources) ? cluster.sources : [],
        };
      }),
    ),
    tombstones: normalizeTombstones(value.tombstones),
    modelPreferences: normalizeModelPreferences(value.modelPreferences),
    voicePreferences: normalizeVoicePreferences(value.voicePreferences),
    archivedCitations: mergeArchivedCitations(
      (citationId) => stillCited?.has(citationId) ?? false,
      rawArchive,
    ),
  };
}

const ORG_ID_MAX_LENGTH = 64;
export type PreparedWorkspaceState =
  | { success: true; state: WorkspaceState }
  | { success: false; reason: 'board_limits' };

export function prepareWorkspaceStateForSave(
  value: WorkspaceState,
): PreparedWorkspaceState {
  for (const project of value.projects) {
    const rawProject = project as unknown as Record<string, unknown>;
    const rawStages = rawProject.boardStages;
    const rawFields = rawProject.fieldDefinitions;
    const rawTasks = rawProject.tasks;
    if (
      (Array.isArray(rawStages) && rawStages.length > 30) ||
      (Array.isArray(rawFields) && rawFields.length > 40) ||
      (Array.isArray(rawTasks) && rawTasks.length > 2000)
    ) {
      return { success: false, reason: 'board_limits' };
    }
    if (
      Array.isArray(rawTasks) &&
      rawTasks.some((task) => {
        if (!task || typeof task !== 'object' || Array.isArray(task)) return false;
        const values = (task as Record<string, unknown>).values;
        return (
          values !== null &&
          typeof values === 'object' &&
          !Array.isArray(values) &&
          Object.keys(values).length > 40
        );
      })
    ) {
      return { success: false, reason: 'board_limits' };
    }
  }
  return { success: true, state: normalizeWorkspaceState(value) };
}

// ---------------------------------------------------------------------------
// Merge helpers
// ---------------------------------------------------------------------------

function mergeProjects(
  cloudItems: Project[],
  deviceItems: Project[],
  tombstones: WorkspaceTombstones,
): Project[] {
  const projectDeletionTimes = deletionTimeMap(tombstones.projects);
  const boardDeletionTimes = {
    tasks: deletionTimeMap(tombstones.tasks),
    stages: deletionTimeMap(tombstones.stages),
    fields: deletionTimeMap(tombstones.fields),
  };
  const cloudById = new Map(cloudItems.map((item) => [item.id, item]));
  const deviceById = new Map(deviceItems.map((item) => [item.id, item]));
  const projectIds = new Set([...cloudById.keys(), ...deviceById.keys()]);
  const merged: Project[] = [];

  for (const projectId of projectIds) {
    const cloudItem = cloudById.get(projectId);
    const deviceItem = deviceById.get(projectId);
    const newest =
      !cloudItem || (deviceItem && deviceItem.updatedAt >= cloudItem.updatedAt)
        ? deviceItem
        : cloudItem;
    if (!newest) continue;
    if ((projectDeletionTimes.get(projectId) ?? -1) >= newest.updatedAt) continue;

    merged.push(
      mergeProjectBoardSnapshots(
        cloudItem ?? newest,
        deviceItem ?? newest,
        boardDeletionTimes,
      ),
    );
  }
  return merged;
}

function mergeConversations(
  cloudItems: Conversation[],
  deviceItems: Conversation[],
  tombstones: WorkspaceTombstones,
): Conversation[] {
  const convDeletionTimes = deletionTimeMap(tombstones.conversations);
  const msgDeletionTimes = deletionTimeMap(tombstones.messages);
  const cloudById = new Map(cloudItems.map((item) => [item.id, item]));
  const deviceById = new Map(deviceItems.map((item) => [item.id, item]));
  const conversationIds = new Set([...cloudById.keys(), ...deviceById.keys()]);
  const merged: Conversation[] = [];

  for (const conversationId of conversationIds) {
    const cloudItem = cloudById.get(conversationId);
    const deviceItem = deviceById.get(conversationId);
    const newest =
      !cloudItem || (deviceItem && deviceItem.updatedAt >= cloudItem.updatedAt)
        ? deviceItem
        : cloudItem;
    if (!newest) continue;
    if ((convDeletionTimes.get(conversationId) ?? -1) >= newest.updatedAt) continue;

    const older = newest === deviceItem ? cloudItem : deviceItem;
    const messages = new Map((older?.messages ?? []).map((m) => [m.id, m]));
    for (const m of newest.messages) messages.set(m.id, m);

    // The response-mode preference block (mode, blend, stamp) merges on its
    // own clock: the copy that changed it last wins, independent of which
    // copy carried the newest message.
    merged.push(
      mergeConversationResponsePrefs(
        {
          ...newest,
          messages: [...messages.values()]
            .filter((m) => (msgDeletionTimes.get(m.id) ?? -1) < m.createdAt)
            .sort((a, b) => a.createdAt - b.createdAt),
        },
        cloudItem,
        deviceItem,
      ),
    );
  }
  return merged;
}

/**
 * Files a project-less conversation into an existing project.
 *
 * The one deliberate way a stranded session gains a home — reopening never
 * adopts. The new stamp is monotonic: strictly newer than the copy being
 * filed, even when that copy carries a future timestamp written by a
 * fast-clock device, because the newest-copy-wins conversation merge would
 * otherwise resurrect the stranded `projectId: null` copy and lose the
 * filing. The workspace also lands on the filed session (project first,
 * then conversation) so the filing is immediately visible. Returns the
 * input state unchanged when the conversation is missing, already filed,
 * or the target project does not exist. Mirrored in the mobile app's
 * workspaceSync module — keep the two in lockstep.
 */
export function fileConversationToProjectInState(
  state: WorkspaceState,
  conversationId: string,
  projectId: string,
  now: number = Date.now(),
): WorkspaceState {
  const conversation = state.conversations.find(
    (c) => c.id === conversationId,
  );
  if (!conversation || conversation.projectId !== null) return state;
  if (!state.projects.some((project) => project.id === projectId)) {
    return state;
  }
  const filedAt = Math.max(now, conversation.updatedAt + 1);
  return {
    ...state,
    conversations: state.conversations.map((c) =>
      c.id === conversationId
        ? { ...c, projectId, updatedAt: filedAt }
        : c,
    ),
    activeProjectId: projectId,
    activeConversationId: conversationId,
  };
}
export function mergeWorkspaceStates(
  cloudState: WorkspaceState,
  deviceState: WorkspaceState,
): WorkspaceState {
  const normalizedCloud = normalizeWorkspaceState(cloudState);
  const normalizedDevice = normalizeWorkspaceState(deviceState);
  const tombstones = mergeTombstones(normalizedCloud.tombstones, {
    ...normalizeTombstones(normalizedDevice.tombstones),
  });
  const projects = mergeProjects(
    normalizedCloud.projects,
    normalizedDevice.projects,
    tombstones,
  );
  const conversations = mergeConversations(
    normalizedCloud.conversations,
    normalizedDevice.conversations,
    tombstones,
  );
  const clusterDeletionTimes = deletionTimeMap(tombstones.clusters);
  const clusters = new Map(normalizedCloud.clusters.map((c) => [c.id, c]));
  for (const cluster of normalizedDevice.clusters) {
    const existing = clusters.get(cluster.id);
    if (!existing || cluster.lastUpdatedAt >= existing.lastUpdatedAt) {
      clusters.set(cluster.id, cluster);
    }
  }

  const projectIds = new Set(projects.map((p) => p.id));
  const liveConversations = conversations.filter(
    (c) => c.projectId === null || projectIds.has(c.projectId),
  );
  const conversationIds = new Set(liveConversations.map((c) => c.id));
  // The merged set can pair clusters that never coexisted on one device, so
  // the union is re-checked for buried positions. The repair never touches
  // lastUpdatedAt, and both apps compute identical coordinates, so a sync
  // cannot ping-pong a separation.
  const liveClusters = separateStackedClusters(
    reconcileKnowledgeLinks(
      [...clusters.values()].filter(
        (c) =>
          (c.projectId === null || projectIds.has(c.projectId)) &&
          (clusterDeletionTimes.get(c.id) ?? -1) < c.lastUpdatedAt,
      ),
    ),
  );
  const liveSources = mergeProjectSources(
    normalizedCloud.sources,
    normalizedDevice.sources,
    tombstones.sources,
  ).filter((source) => projectIds.has(source.projectId));

  // The bounded archive exists only so retired markers keep their titles, and
  // the merged snapshot says exactly which markers those are. Recomputing the
  // prune against the merged state (same rules as the mobile client) keeps a
  // cleanup one device already ran from being undone by a device that still
  // holds the stale entries. An entry survives only while a merged answer
  // still cites it and no merged source serves its citation live again, so
  // live rendering is unchanged. Pruning runs before the size cap so stale
  // entries cannot evict evidence answers still need.
  const stillCitedIds = citedCitationIds(liveConversations);
  const isStillCited = (citationId: string) => stillCitedIds.has(citationId);
  const archivedCitations = mergeArchivedCitations(
    isStillCited,
    dropUncitedArchivedCitations(
      dropRestoredArchivedCitations(
        [
          ...(normalizedCloud.archivedCitations ?? []),
          ...(normalizedDevice.archivedCitations ?? []),
        ],
        liveSources.flatMap((source) => source.citations ?? []),
        isStillCited,
      ),
      isStillCited,
    ),
  );

  const preferredProjectId =
    normalizedDevice.activeProjectId && projectIds.has(normalizedDevice.activeProjectId)
      ? normalizedDevice.activeProjectId
      : normalizedCloud.activeProjectId && projectIds.has(normalizedCloud.activeProjectId)
        ? normalizedCloud.activeProjectId
        : null;

  const preferredConversationId =
    normalizedDevice.activeConversationId &&
    conversationIds.has(normalizedDevice.activeConversationId)
      ? normalizedDevice.activeConversationId
      : normalizedCloud.activeConversationId &&
          conversationIds.has(normalizedCloud.activeConversationId)
        ? normalizedCloud.activeConversationId
        : null;

  return {
    projects,
    conversations: liveConversations,
    clusters: liveClusters,
    sources: liveSources,
    activeProjectId: preferredProjectId,
    activeConversationId: preferredConversationId,
    tombstones,
    modelPreferences: mergeModelPreferences(
      normalizedCloud.modelPreferences,
      normalizedDevice.modelPreferences,
    ),
    voicePreferences: mergeVoicePreferences(
      normalizedCloud.voicePreferences,
      normalizedDevice.voicePreferences,
    ),
    archivedCitations,
  };
}

// ---------------------------------------------------------------------------
// Knowledge link reconciliation
// ---------------------------------------------------------------------------

export function reconcileKnowledgeLinks(clusters: KnowledgeCluster[]): KnowledgeCluster[] {
  const clusterById = new Map(clusters.map((c) => [c.id, c]));
  const linkedIds = new Map(clusters.map((c) => [c.id, new Set<string>()]));

  for (const cluster of clusters) {
    for (const linkId of cluster.links) {
      const linked = clusterById.get(linkId);
      if (!linked || linked.id === cluster.id || linked.projectId !== cluster.projectId) continue;
      linkedIds.get(cluster.id)?.add(linked.id);
      linkedIds.get(linked.id)?.add(cluster.id);
    }
  }
  return clusters.map((c) => ({ ...c, links: [...(linkedIds.get(c.id) ?? [])] }));
}

// ---------------------------------------------------------------------------
// Knowledge source helpers
// ---------------------------------------------------------------------------

export function pruneKnowledgeSources(
  clusters: KnowledgeCluster[],
  shouldRemove: (source: KnowledgeSource) => boolean,
): KnowledgeCluster[] {
  const withLiveSources = clusters
    .map((cluster) => {
      if (cluster.sources.length === 0) return cluster;
      return { ...cluster, sources: cluster.sources.filter((s) => !shouldRemove(s)) };
    })
    .filter((c) => c.sources.length > 0 || c.mentionCount > 0);
  const liveIds = new Set(withLiveSources.map((c) => c.id));
  return withLiveSources.map((c) => ({ ...c, links: c.links.filter((id) => liveIds.has(id)) }));
}

export function mergeKnowledgeSources(
  targetSources: KnowledgeSource[],
  sourceSources: KnowledgeSource[],
): KnowledgeSource[] {
  const byConv = new Map<string, KnowledgeSource>();
  for (const source of [...targetSources, ...sourceSources]) {
    const existing = byConv.get(source.conversationId);
    if (!existing) {
      byConv.set(source.conversationId, { ...source, messageIds: [...new Set(source.messageIds)] });
      continue;
    }
    const newer = source.updatedAt >= existing.updatedAt ? source : existing;
    byConv.set(source.conversationId, {
      ...newer,
      messageIds: [...new Set([...existing.messageIds, ...source.messageIds])],
      updatedAt: Math.max(existing.updatedAt, source.updatedAt),
    });
  }
  return [...byConv.values()].sort((a, b) => b.updatedAt - a.updatedAt);
}

// ---------------------------------------------------------------------------
// Project source count helper
// ---------------------------------------------------------------------------

export function updateProjectKnowledgeSourceCount(
  projects: Project[],
  clusters: KnowledgeCluster[],
  projectId: string | null,
  updatedAt: number,
): Project[] {
  if (!projectId) return projects;
  const conversationIds = new Set(
    clusters
      .filter((c) => c.projectId === projectId)
      .flatMap((c) => c.sources.map((s) => s.conversationId)),
  );
  return projects.map((p) =>
    p.id === projectId ? { ...p, sourceCount: conversationIds.size, updatedAt } : p,
  );
}

// ---------------------------------------------------------------------------
// Clear conversation knowledge
// ---------------------------------------------------------------------------

export function clearConversationKnowledge(
  state: WorkspaceState,
  conversationId: string,
): WorkspaceState {
  return {
    ...state,
    conversations: state.conversations.map((c) =>
      c.id === conversationId ? { ...c, messages: [] } : c,
    ),
    clusters: pruneKnowledgeSources(state.clusters, (s) => s.conversationId === conversationId),
  };
}

// ---------------------------------------------------------------------------
// Project deletion
// ---------------------------------------------------------------------------

export type DeleteProjectOptions = {
  state: WorkspaceState;
  projectId: string;
  deletedAt: number;
  generateId: (prefix: string) => string;
};

/**
 * Removes a project and everything that lived inside it, writing the same
 * tombstones the mobile client writes (VenomContext.deleteProject) so the
 * deletion propagates across devices and nothing resurrects on merge.
 *
 * Landing rules mirror mobile: deleting the workspace you are in moves to the
 * most recently updated remaining project, and deleting the last project
 * seeds a fresh fallback workspace under a new id (reusing the deleted id
 * would fight its own tombstone during sync).
 */
export function deleteProjectFromState({
  state,
  projectId,
  deletedAt,
  generateId: genId,
}: DeleteProjectOptions): WorkspaceState {
  const project = state.projects.find((item) => item.id === projectId);
  const remainingProjects = state.projects.filter(
    (item) => item.id !== projectId,
  );
  const fallbackProject =
    remainingProjects.length === 0
      ? createFallbackWorkspaceProject(genId('proj'), deletedAt)
      : null;
  const nextActiveProjectId = fallbackProject
    ? fallbackProject.id
    : state.activeProjectId === projectId
      ? mostRecentlyUpdatedProjectId(remainingProjects)
      : state.activeProjectId;

  const sources = state.sources ?? [];
  const removedConversations = state.conversations.filter(
    (conversation) => conversation.projectId === projectId,
  );
  const removedClusters = state.clusters.filter(
    (cluster) => cluster.projectId === projectId,
  );
  const removedSources = sources.filter(
    (source) => source.projectId === projectId,
  );
  const conversations = state.conversations.filter(
    (conversation) => conversation.projectId !== projectId,
  );
  const activeConversationExists = conversations.some(
    (conversation) => conversation.id === state.activeConversationId,
  );
  // The deleted project's answers are gone, so the evidence only they could
  // have named no longer belongs in the bounded archive.
  const stillCited = citedCitationIds(conversations);

  return {
    ...state,
    projects: fallbackProject ? [fallbackProject] : remainingProjects,
    conversations,
    archivedCitations: dropUncitedArchivedCitations(
      state.archivedCitations,
      (citationId) => stillCited.has(citationId),
    ),
    clusters: state.clusters.filter(
      (cluster) => cluster.projectId !== projectId,
    ),
    sources: sources.filter((source) => source.projectId !== projectId),
    activeProjectId: nextActiveProjectId,
    activeConversationId: activeConversationExists
      ? state.activeConversationId
      : null,
    tombstones: mergeTombstones(state.tombstones, {
      projects: createDeletionMarkers([projectId], deletedAt),
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
}

// ---------------------------------------------------------------------------
// Apply knowledge insights
// ---------------------------------------------------------------------------
// New clusters are placed by the shared @workspace/venom-workspace-merge
// rules (legacy label-hash seed + clearance against every stored position),
// so this file no longer owns a positionForLabel copy that could drift from
// the phone app's.

export type ApplyKnowledgeOptions = {
  state: WorkspaceState;
  conversation: Pick<Conversation, 'id' | 'title' | 'projectId'>;
  insights: KnowledgeInsight[];
  now: number;
  generateId: (prefix: string) => string;
};

export function applyKnowledgeInsightsToState({
  state,
  conversation,
  insights,
  now,
  generateId: genId,
}: ApplyKnowledgeOptions): WorkspaceState {
  if (!insights.length) return state;

  const liveConversation = state.conversations.find((c) => c.id === conversation.id);
  if (!liveConversation || liveConversation.projectId !== conversation.projectId) return state;

  const liveMessageIds = new Set(liveConversation.messages.map((m) => m.id));
  const applicableInsights = insights
    .map((i) => ({ ...i, sourceMessageIds: i.sourceMessageIds.filter((id) => liveMessageIds.has(id)) }))
    .filter((i) => i.sourceMessageIds.length > 0);
  if (!applicableInsights.length) return state;

  const clusters = state.clusters.map((c) => ({
    ...c,
    links: [...c.links],
    sources: [...c.sources],
    strength:
      c.projectId === liveConversation.projectId ? Math.max(0.12, c.strength * 0.96) : c.strength,
  }));

  const clusterByLabel = new Map(
    clusters
      .filter((c) => c.projectId === liveConversation.projectId)
      .map((c) => [normalizeLabel(c.label), c]),
  );

  for (const insight of applicableInsights) {
    const label = insight.label.trim();
    const normalizedLabel = normalizeLabel(label);
    if (!label || !normalizedLabel) continue;

    const confidence = Math.max(0, Math.min(1, insight.confidence));
    const source: KnowledgeSource = {
      conversationId: liveConversation.id,
      projectId: liveConversation.projectId,
      conversationTitle: liveConversation.title,
      messageIds: [...new Set(insight.sourceMessageIds)].slice(0, 12),
      excerpt: insight.summary.trim(),
      updatedAt: now,
    };

    const existing = clusterByLabel.get(normalizedLabel);
    if (existing) {
      const priorSource = existing.sources.find((s) => s.conversationId === conversation.id);
      existing.category = insight.category.trim() || existing.category;
      existing.summary = insight.summary.trim() || existing.summary;
      existing.mentionCount += 1;
      existing.lastUpdatedAt = now;
      existing.strength = Math.min(1, existing.strength + 0.12 + confidence * 0.2);
      existing.sources = [
        {
          ...source,
          messageIds: [
            ...new Set([...(priorSource?.messageIds ?? []), ...source.messageIds]),
          ].slice(0, 12),
        },
        ...existing.sources.filter((s) => s.conversationId !== conversation.id),
      ].slice(0, 8);
    } else {
      const position = positionForNewCluster(label, clusters.length, clusters);
      const created: KnowledgeCluster = {
        id: genId('cluster'),
        projectId: liveConversation.projectId,
        label,
        category: insight.category.trim() || 'topic',
        summary: insight.summary.trim(),
        strength: Math.min(1, 0.34 + confidence * 0.42),
        mentionCount: 1,
        lastUpdatedAt: now,
        sources: [source],
        x: position.x,
        y: position.y,
        links: [],
      };
      clusters.push(created);
      clusterByLabel.set(normalizedLabel, created);
    }
  }

  // Build link graph
  for (const insight of applicableInsights) {
    const src = clusterByLabel.get(normalizeLabel(insight.label));
    if (!src) continue;
    for (const relatedLabel of insight.relatedLabels) {
      const tgt = clusterByLabel.get(normalizeLabel(relatedLabel));
      if (!tgt || tgt.id === src.id) continue;
      if (!src.links.includes(tgt.id)) src.links.push(tgt.id);
      if (!tgt.links.includes(src.id)) tgt.links.push(src.id);
    }
  }

  const projectConvIds = new Set(
    clusters
      .filter((c) => c.projectId === liveConversation.projectId)
      .flatMap((c) => c.sources.map((s) => s.conversationId)),
  );
  const projects = state.projects.map((p) =>
    p.id === liveConversation.projectId
      ? { ...p, sourceCount: projectConvIds.size, updatedAt: now }
      : p,
  );

  return { ...state, clusters, projects };
}

type ApplyFiledClustersOptions = {
  state: WorkspaceState;
  conversation: Pick<Conversation, 'id' | 'title' | 'projectId'>;
  filed: KnowledgeCluster[];
  now: number;
};

// Applies clusters the server already filed into the ontology store. The
// server runs the exact normalization and merge rules the local path uses,
// so its records are canonical: replace matching ids wholesale, add new
// ones, and decay untouched same-project clusters exactly like a local
// filing would so both sides stay aligned.
export function applyFiledClustersToState({
  state,
  conversation,
  filed,
  now,
}: ApplyFiledClustersOptions): WorkspaceState {
  if (!filed.length) return state;
  const liveConversation = state.conversations.find((c) => c.id === conversation.id);
  if (!liveConversation || liveConversation.projectId !== conversation.projectId) return state;

  const filedIds = new Set(filed.map((cluster) => cluster.id));
  const clusters = state.clusters
    .filter((cluster) => !filedIds.has(cluster.id))
    .map((cluster) =>
      cluster.projectId === liveConversation.projectId
        ? { ...cluster, strength: Math.max(0.12, cluster.strength * 0.96) }
        : cluster,
    );
  for (const cluster of filed) {
    clusters.push({
      ...cluster,
      links: [...cluster.links],
      sources: cluster.sources.map((source) => ({
        ...source,
        messageIds: [...source.messageIds],
      })),
    });
  }

  // Server-filed records are canonical for content, but an older server may
  // still file a position that buries an existing dot; separate here so the
  // new topic is tappable the moment it appears.
  const reconciled = separateStackedClusters(reconcileKnowledgeLinks(clusters));

  const projectConvIds = new Set(
    reconciled
      .filter((c) => c.projectId === liveConversation.projectId)
      .flatMap((c) => c.sources.map((s) => s.conversationId)),
  );
  const projects = state.projects.map((p) =>
    p.id === liveConversation.projectId
      ? { ...p, sourceCount: projectConvIds.size, updatedAt: now }
      : p,
  );

  return { ...state, clusters: reconciled, projects };
}

/** All known voice preset IDs in display order */
export const ALL_VOICE_PRESET_IDS: VenomVoicePresetId[] = [
  'sam',
  'marcus',
  'rowan',
  'elijah',
  'maya',
  'isla',
];

/** Talkativeness levels, mirrored from the mobile picker (chatty → reserved) */
export const ALL_VOICE_TALKATIVENESS_LEVELS: VenomVoiceTalkativeness[] = [
  'chatty',
  'balanced',
  'reserved',
];
/**
 * Normalize voice preferences, guarding against stale / missing data. An
 * unknown preset id recovers to the default voice; the timestamp is clamped
 * to a non-negative integer so a corrupt value cannot win merges forever.
 */
export function normalizeVoicePreferences(raw: unknown): VoicePreferences {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return createDefaultVoicePreferences();
  }
  const candidate = raw as Partial<VoicePreferences>;
  const presetId =
    typeof candidate.presetId === 'string' &&
    (ALL_VOICE_PRESET_IDS as string[]).includes(candidate.presetId)
      ? (candidate.presetId as VenomVoicePresetId)
      : DEFAULT_VOICE_PRESET_ID;
  const talkativeness =
    typeof candidate.talkativeness === 'string' &&
    (ALL_VOICE_TALKATIVENESS_LEVELS as string[]).includes(candidate.talkativeness)
      ? (candidate.talkativeness as VenomVoiceTalkativeness)
      : DEFAULT_VOICE_TALKATIVENESS;
  return {
    presetId,
    talkativeness,
    updatedAt:
      typeof candidate.updatedAt === 'number' &&
      Number.isFinite(candidate.updatedAt) &&
      candidate.updatedAt >= 0
        ? Math.floor(candidate.updatedAt)
        : 0,
  };
}

/**
 * Merge two VoicePreferences snapshots. The one with higher `updatedAt`
 * wins; the device side wins on a tie.
 */
export function mergeVoicePreferences(
  cloud: VoicePreferences | undefined,
  device: VoicePreferences | undefined,
): VoicePreferences {
  if (!cloud && !device) return createDefaultVoicePreferences();
  if (!cloud) return normalizeVoicePreferences(device);
  if (!device) return normalizeVoicePreferences(cloud);

  const winner = device.updatedAt >= cloud.updatedAt ? device : cloud;
  return normalizeVoicePreferences(winner);
}

export function createDefaultVoicePreferences(): VoicePreferences {
  return {
    presetId: DEFAULT_VOICE_PRESET_ID,
    talkativeness: DEFAULT_VOICE_TALKATIVENESS,
    updatedAt: 0,
  };
}

export const DEFAULT_VOICE_TALKATIVENESS: VenomVoiceTalkativeness = 'balanced';

/**
 * Company fields ride along on synced projects, so every load path must
 * normalize them — otherwise a device running an older build could strip
 * them from the whole account on its next save.
 */
function normalizeProjectOrgFields(project: Project): Project {
  const raw = project as unknown as Record<string, unknown>;
  const orgId =
    typeof raw.orgId === 'string' &&
    raw.orgId.trim().length > 0 &&
    raw.orgId.length <= ORG_ID_MAX_LENGTH
      ? raw.orgId
      : undefined;
  const orgMirror = orgId !== undefined && raw.orgMirror === true;
  const next: Project = { ...project };
  if (orgId !== undefined) next.orgId = orgId;
  else delete next.orgId;
  if (orgMirror) next.orgMirror = true;
  else delete next.orgMirror;
  return next;
}

/**
 * The seeded default project used to be called "Global Workspace", which read
 * like a second scope switcher next to the Personal/workspace picker (Task
 * #281 removed that axis from the nav). Heal the stored copy on every load
 * path. Deliberately narrow — only the untouched seeded name on the seeded id
 * is renamed, a user's own rename stays — and deliberately does NOT bump
 * `updatedAt`: both apps run the same deterministic repair, so sync cannot
 * ping-pong it, and the rename must not win merges it did not earn.
 */
function normalizeDefaultProjectName(project: Project): Project {
  if (project.id === 'proj_default' && project.name === 'Global Workspace') {
    return { ...project, name: 'General' };
  }
  return project;
}
/**
 * Reconcile local projects with the company shared-project registry.
 *
 * - Registered shared projects get their `orgId` stamped; teammates' shared
 *   projects appear as read-mostly mirror projects (`orgMirror`).
 * - When a company confirms a project is no longer shared — or membership
 *   itself ended — mirrors are dropped (their conversations survive,
 *   unfiled), and own projects lose their `orgId`.
 * - Orgs whose fetch failed this round (`fetchedOrgIds` misses them while
 *   membership persists) are left untouched, so a flaky request can never
 *   wipe mirrors.
 */
export function applyOrgProjectSync(
  state: WorkspaceState,
  memberships: Pick<VenomOrg, 'id'>[],
  sharedByOrg: Map<string, VenomOrgSharedProject[]>,
  fetchedOrgIds: Set<string>,
): WorkspaceState {
  const memberOrgIds = new Set(memberships.map((org) => org.id));
  const sharedById = new Map<string, VenomOrgSharedProject>();
  for (const records of sharedByOrg.values()) {
    for (const record of records) sharedById.set(record.projectId, record);
  }

  let changed = false;
  const droppedProjectIds = new Set<string>();
  const projects: Project[] = [];

  for (const project of state.projects) {
    const shared = sharedById.get(project.id);
    if (shared) {
      if (project.orgMirror) {
        if (
          project.orgId !== shared.orgId ||
          project.name !== shared.name ||
          project.description !== shared.description ||
          (shared.accent !== '' && project.accent !== shared.accent)
        ) {
          changed = true;
          projects.push({
            ...project,
            orgId: shared.orgId,
            orgMirror: true,
            name: shared.name,
            description: shared.description,
            accent: shared.accent !== '' ? shared.accent : project.accent,
            updatedAt: Math.max(project.updatedAt, shared.updatedAt),
          });
        } else {
          projects.push(project);
        }
      } else if (project.orgId !== shared.orgId) {
        changed = true;
        projects.push({ ...project, orgId: shared.orgId, updatedAt: Date.now() });
      } else {
        projects.push(project);
      }
      continue;
    }

    const orgId = project.orgId;
    const orgGone = orgId !== undefined && !memberOrgIds.has(orgId);
    const confirmedUnshared = orgId !== undefined && fetchedOrgIds.has(orgId);

    if (project.orgMirror) {
      if (orgId === undefined || orgGone || confirmedUnshared) {
        changed = true;
        droppedProjectIds.add(project.id);
      } else {
        projects.push(project);
      }
      continue;
    }

    if (orgId !== undefined && (orgGone || confirmedUnshared)) {
      changed = true;
      const next: Project = { ...project, updatedAt: Date.now() };
      delete next.orgId;
      delete next.orgMirror;
      projects.push(next);
      continue;
    }

    projects.push(project);
  }

  // Mirror shared projects this device does not have yet.
  const knownIds = new Set(projects.map((project) => project.id));
  const deletionTimes = new Map(
    (state.tombstones ?? createEmptyTombstones()).projects.map(
      (marker) => [marker.id, marker.deletedAt] as const,
    ),
  );
  for (const record of sharedById.values()) {
    if (knownIds.has(record.projectId) || droppedProjectIds.has(record.projectId)) {
      continue;
    }
    if ((deletionTimes.get(record.projectId) ?? -1) >= record.updatedAt) continue;
    changed = true;
    projects.push(
      normalizeProjectBoard({
        id: record.projectId,
        name: record.name,
        description: record.description,
        accent: record.accent !== '' ? record.accent : '#e5e5e5',
        sourceCount: 0,
        updatedAt: record.updatedAt,
        tasks: [],
        boardStages: createDefaultBoardStages(record.projectId, record.updatedAt),
        fieldDefinitions: [],
        orgId: record.orgId,
        orgMirror: true,
      }),
    );
  }

  if (!changed) return state;

  const conversations =
    droppedProjectIds.size === 0
      ? state.conversations
      : state.conversations.map((conversation) =>
          conversation.projectId !== null &&
          droppedProjectIds.has(conversation.projectId)
            ? { ...conversation, projectId: null }
            : conversation,
        );
  const clusters =
    droppedProjectIds.size === 0
      ? state.clusters
      : reconcileKnowledgeLinks(
          state.clusters.filter(
            (cluster) =>
              cluster.projectId === null ||
              !droppedProjectIds.has(cluster.projectId),
          ),
        );
  const sources =
    droppedProjectIds.size === 0
      ? state.sources
      : state.sources.filter((source) => !droppedProjectIds.has(source.projectId));

  return {
    ...state,
    projects,
    conversations,
    clusters,
    sources,
    activeProjectId:
      state.activeProjectId !== null && droppedProjectIds.has(state.activeProjectId)
        ? null
        : state.activeProjectId,
  };
}
