import type {
  VenomArchivedCitation,
  VenomConversation,
  VenomDeletionMarker,
  VenomKnowledgeCluster,
  VenomModelId,
  VenomModelPreferences,
  VenomProject,
  VenomVoicePreferences,
  VenomVoicePresetId,
  VenomVoiceTalkativeness,
  VenomWorkspaceState,
  VenomWorkspaceTombstones,
} from '@workspace/api-client-react';
import {
  mergeProjectBoardSnapshots,
  normalizeProjectBoard,
} from './boardState.ts';
import {
  mergeProjectSources,
  mergeSourceDeletionMarkers,
} from './sourceState.ts';
import {
  citationUrlIdentity,
  citedCitationIds,
} from './messageCitations.ts';
import {
  mergeConversationResponsePrefs,
  normalizeConversationResponsePrefs,
} from './responsePrefs.ts';

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
  sources: 2000,
};

/**
 * Bounds the retired-citation archive so it cannot grow without limit or push
 * the workspace payload over the server's size limit. Matches the maxItems of
 * VenomWorkspaceState.archivedCitations in the API schema; the oldest entries
 * are evicted first.
 */
export const ARCHIVED_CITATION_LIMIT = 500;

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
  /**
   * The synced-project baseline the device should persist after this
   * hydration, or null when the hydration learned nothing new about what the
   * cloud has seen (an offline start, or a legacy import still awaiting a
   * choice).
   */
  syncedProjectIds: string[] | null;
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
    sources: [],
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
    sources: mergeSourceDeletionMarkers(
      TOMBSTONE_LIMITS.sources,
      tombstones.sources ?? [],
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
    sources: mergeSourceDeletionMarkers(
      TOMBSTONE_LIMITS.sources,
      normalized.sources,
      additions.sources ?? [],
    ),
  };
}

/**
 * Merges retired-citation archives from any number of snapshots. Entries are
 * deduplicated by citation id (newest retirement wins), sorted newest first,
 * and capped so the archive stays bounded.
 */
export function mergeArchivedCitations(
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
  return [...merged.values()]
    .sort((left, right) => right.retiredAt - left.retiredAt)
    .slice(0, ARCHIVED_CITATION_LIMIT);
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

export function createDeletionMarkers(
  ids: string[],
  deletedAt: number,
  options: { replaced?: boolean } = {},
): VenomDeletionMarker[] {
  // `replaced` marks an entity a newer snapshot took the place of (a refreshed
  // source), which is a permanent retirement rather than a plain deletion.
  return [...new Set(ids)].map((id) => ({
    id,
    deletedAt,
    ...(options.replaced ? { replaced: true as const } : {}),
  }));
}

function deletionTime(markers: VenomDeletionMarker[]) {
  return new Map(markers.map((marker) => [marker.id, marker.deletedAt]));
}

// Inlined to avoid a runtime import of @workspace/api-client-react in this module.
// Must be kept in sync with the VenomModelId enum in the generated schema.
const ALL_MODEL_IDS: VenomModelId[] = ['venom-gpt', 'venom-claude', 'venom-gemini', 'venom-grok'];
const DEFAULT_MODEL_ID: VenomModelId = 'venom-gpt';

/**
 * Returns a valid VenomModelId if the value is one of the known enum members,
 * otherwise null. Safe to call with unknown/legacy values.
 */
function toValidModelId(value: unknown): VenomModelId | null {
  if (typeof value === 'string' && (ALL_MODEL_IDS as string[]).includes(value)) {
    return value as VenomModelId;
  }
  return null;
}

/**
 * Normalize raw modelPreferences from storage or network. Applies legacy-safe
 * defaults: falls back to the system default when ids are missing/invalid,
 * preserves at least one enabled model, recovers broken active/default to the
 * current default.
 */
export function normalizeModelPreferences(
  raw: unknown,
): VenomModelPreferences {
  const fallback: VenomModelPreferences = {
    enabledModelIds: [DEFAULT_MODEL_ID],
    defaultModelId: DEFAULT_MODEL_ID,
    activeModelId: DEFAULT_MODEL_ID,
    updatedAt: 0,
  };

  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return fallback;
  const candidate = raw as Partial<VenomModelPreferences>;

  const rawEnabled = candidate.enabledModelIds;
  const enabledModelIds: VenomModelId[] = Array.isArray(rawEnabled)
    ? rawEnabled.flatMap((id) => {
        const v = toValidModelId(id);
        return v ? [v] : [];
      })
    : [];
  // Must have at least one enabled model.
  if (enabledModelIds.length === 0) enabledModelIds.push(DEFAULT_MODEL_ID);

  const defaultModelId =
    toValidModelId(candidate.defaultModelId) ?? DEFAULT_MODEL_ID;
  // If specified default is not enabled, recover to first enabled.
  const resolvedDefault = enabledModelIds.includes(defaultModelId)
    ? defaultModelId
    : enabledModelIds[0];

  const activeModelId =
    toValidModelId(candidate.activeModelId) ?? resolvedDefault;
  // If active is not enabled, recover to the resolved default.
  const resolvedActive = enabledModelIds.includes(activeModelId)
    ? activeModelId
    : resolvedDefault;

  return {
    enabledModelIds,
    defaultModelId: resolvedDefault,
    activeModelId: resolvedActive,
    updatedAt: typeof candidate.updatedAt === 'number' && candidate.updatedAt >= 0
      ? Math.floor(candidate.updatedAt)
      : 0,
  };
}

/**
 * Merge two modelPreferences snapshots. Whichever has the higher updatedAt
 * wins completely (cloud/device merge); fallback to device-side if equal.
 */
function mergeModelPreferences(
  cloud: VenomModelPreferences | undefined,
  device: VenomModelPreferences | undefined,
): VenomModelPreferences {
  const normalizedCloud = cloud ? normalizeModelPreferences(cloud) : null;
  const normalizedDevice = device ? normalizeModelPreferences(device) : null;

  if (!normalizedCloud && !normalizedDevice) {
    return normalizeModelPreferences(undefined);
  }
  if (!normalizedCloud) return normalizedDevice!;
  if (!normalizedDevice) return normalizedCloud;

  // Higher updatedAt wins; device wins on tie.
  return normalizedDevice.updatedAt >= normalizedCloud.updatedAt
    ? normalizedDevice
    : normalizedCloud;
}

// Inlined to avoid a runtime import of @workspace/api-client-react in this module.
// Must be kept in sync with the VenomVoicePresetId enum in the generated schema.
const ALL_VOICE_PRESET_IDS: VenomVoicePresetId[] = [
  'sam',
  'marcus',
  'rowan',
  'elijah',
  'maya',
  'isla',
];
export const DEFAULT_VOICE_PRESET_ID: VenomVoicePresetId = 'sam';

export const ALL_VOICE_TALKATIVENESS_LEVELS: VenomVoiceTalkativeness[] = [
  'chatty',
  'balanced',
  'reserved',
];
/**
 * Normalize raw voicePreferences from storage or network. Unknown or legacy
 * preset ids recover to the default voice; the timestamp is clamped to a
 * non-negative integer so a corrupt value cannot win every merge forever.
 */
export function normalizeVoicePreferences(raw: unknown): VenomVoicePreferences {
  const fallback: VenomVoicePreferences = {
    presetId: DEFAULT_VOICE_PRESET_ID,
    talkativeness: DEFAULT_VOICE_TALKATIVENESS,
    updatedAt: 0,
  };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return fallback;
  const candidate = raw as Partial<VenomVoicePreferences>;
  const presetId =
    typeof candidate.presetId === 'string' &&
    (ALL_VOICE_PRESET_IDS as string[]).includes(candidate.presetId)
      ? (candidate.presetId as VenomVoicePresetId)
      : DEFAULT_VOICE_PRESET_ID;
  return {
    presetId,
    // Unknown values (older app versions, hand-edited storage) recover to
    // the balanced default rather than surviving as junk.
    talkativeness:
      typeof candidate.talkativeness === 'string' &&
      (ALL_VOICE_TALKATIVENESS_LEVELS as string[]).includes(
        candidate.talkativeness,
      )
        ? (candidate.talkativeness as VenomVoiceTalkativeness)
        : DEFAULT_VOICE_TALKATIVENESS,
    updatedAt:
      typeof candidate.updatedAt === 'number' &&
      Number.isFinite(candidate.updatedAt) &&
      candidate.updatedAt >= 0
        ? Math.floor(candidate.updatedAt)
        : 0,
  };
}

/**
 * Merge two voicePreferences snapshots. Whichever has the higher updatedAt
 * wins (cloud/device merge); the device side wins on a tie.
 */
export function mergeVoicePreferences(
  cloud: VenomVoicePreferences | undefined,
  device: VenomVoicePreferences | undefined,
): VenomVoicePreferences {
  const normalizedCloud = cloud ? normalizeVoicePreferences(cloud) : null;
  const normalizedDevice = device ? normalizeVoicePreferences(device) : null;

  if (!normalizedCloud && !normalizedDevice) {
    return normalizeVoicePreferences(undefined);
  }
  if (!normalizedCloud) return normalizedDevice!;
  if (!normalizedDevice) return normalizedCloud;

  return normalizedDevice.updatedAt >= normalizedCloud.updatedAt
    ? normalizedDevice
    : normalizedCloud;
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
    conversations: value.conversations.map((conversation) =>
      normalizeConversationResponsePrefs(conversation),
    ),
    sources: Array.isArray(value.sources) ? value.sources : [],
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
    modelPreferences: normalizeModelPreferences(value.modelPreferences),
    voicePreferences: normalizeVoicePreferences(value.voicePreferences),
    archivedCitations: mergeArchivedCitations(
      Array.isArray(value.archivedCitations) ? value.archivedCitations : [],
    ),
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

    // The response-mode preference block merges by its own stamp, not by
    // conversation.updatedAt, so a mode change on one device never loses to
    // an unrelated content edit on another.
    merged.push(
      mergeConversationResponsePrefs(
        {
          ...newest,
          messages: [...messages.values()]
            .filter(
              (message) =>
                (messageDeletionTimes.get(message.id) ?? -1) <
                message.createdAt,
            )
            .sort((left, right) => left.createdAt - right.createdAt),
        },
        cloudItem,
        deviceItem,
      ),
    );
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
  const liveSources = mergeProjectSources(
    cloudState.sources ?? [],
    deviceState.sources ?? [],
    tombstones.sources,
  ).filter((source) => projectIds.has(source.projectId));
  // The bounded archive exists only so retired markers keep their titles, and
  // the merged snapshot says exactly which markers those are. Recomputing the
  // local prune rules against the merged state keeps a cleanup one device
  // already ran from being undone by a device that still holds the stale
  // entries — a plain union would re-upload what the other side dropped and
  // the archive would grow back on every sync. An entry survives only while a
  // merged answer still cites it and no merged source serves its citation
  // live again (the renderer always prefers the live citation for an id), so
  // live rendering is unchanged. Pruning runs before the size cap so stale
  // entries cannot evict evidence answers still need.
  const stillCitedIds = citedCitationIds(liveConversations);
  const isStillCited = (citationId: string) => stillCitedIds.has(citationId);
  const archivedCitations = mergeArchivedCitations(
    dropUncitedArchivedCitations(
      dropRestoredArchivedCitations(
        [
          ...(cloudState.archivedCitations ?? []),
          ...(deviceState.archivedCitations ?? []),
        ],
        liveSources.flatMap((source) => source.citations ?? []),
        isStillCited,
      ),
      isStillCited,
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
    sources: liveSources,
    activeProjectId: preferredProjectId,
    activeConversationId: preferredConversationId,
    tombstones,
    modelPreferences: mergeModelPreferences(
      cloudState.modelPreferences,
      deviceState.modelPreferences,
    ),
    voicePreferences: mergeVoicePreferences(
      cloudState.voicePreferences,
      deviceState.voicePreferences,
    ),
    archivedCitations,
  };
}

/**
 * The projects the cloud is known to have seen from this device: everything a
 * successful save uploaded, plus everything a restored cloud snapshot listed.
 * Persisting it is what lets a restore tell "created here, never uploaded"
 * apart from "deleted on another device" — both look alike in the snapshot
 * itself, because either way the project is on the device and not in the cloud.
 */
export function workspaceProjectIds(state: VenomWorkspaceState): string[] {
  return [...new Set(state.projects.map((project) => project.id))];
}

/**
 * Reads a persisted baseline back. Returns null — meaning "this device has
 * never recorded one" — for anything that is not a list of ids, so a corrupt
 * or pre-upgrade entry falls back to the stricter cloud-only scoping instead
 * of treating every local project as newly created.
 */
export function parseSyncedProjectIds(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const ids = value.filter(
    (entry): entry is string => typeof entry === 'string' && entry.length > 0,
  );
  return [...new Set(ids)];
}

/**
 * The device snapshot a restore is allowed to merge forward. Work the device
 * saved locally but never got into the cloud — chat written offline, or after a
 * save that kept failing — has to survive the next reload, but a stale local
 * snapshot must not resurrect what the cloud says is gone.
 *
 * A project the cloud still lists always merges. A project it does not is kept
 * only when the synced baseline says the cloud has never seen it, which makes
 * it work this device created and never managed to upload; a project the
 * baseline does list is one the cloud dropped, so it stays gone. Without a
 * baseline (a device that has not recorded one yet) the older, stricter rule
 * applies and only the cloud's own projects merge. Everything carried forward
 * still answers to the merged tombstones.
 */
function scopeDeviceWorkToKnownProjects(
  cloudState: VenomWorkspaceState,
  deviceState: VenomWorkspaceState,
  syncedProjectIds: ReadonlySet<string> | null,
): VenomWorkspaceState {
  const cloudProjectIds = new Set(
    cloudState.projects.map((project) => project.id),
  );
  return {
    ...deviceState,
    projects: deviceState.projects.filter(
      (project) =>
        cloudProjectIds.has(project.id) ||
        (syncedProjectIds !== null && !syncedProjectIds.has(project.id)),
    ),
  };
}

/**
 * A device snapshot that contributes nothing of its own, used to run the cloud
 * snapshot through the same merge as the restore. Comparing the restored state
 * against that projection — rather than against the raw cloud payload — keeps
 * `shouldUpload` about real differences instead of the key order and sorting
 * the merge imposes.
 */
function emptyDeviceState(
  reference: VenomWorkspaceState,
): VenomWorkspaceState {
  return {
    projects: [],
    conversations: [],
    clusters: [],
    sources: [],
    activeProjectId: reference.activeProjectId,
    activeConversationId: reference.activeConversationId,
    tombstones: createEmptyTombstones(),
    modelPreferences: reference.modelPreferences,
    voicePreferences: reference.voicePreferences,
    archivedCitations: [],
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
  syncedProjectIds = null,
  createFreshState,
}: {
  cloudState: VenomWorkspaceState | null;
  localState: VenomWorkspaceState;
  legacyState: VenomWorkspaceState | null;
  hasScopedState: boolean;
  /**
   * The projects this device knows the cloud has seen, or null when it has
   * never recorded a baseline.
   */
  syncedProjectIds?: readonly string[] | null;
  createFreshState: () => VenomWorkspaceState;
}): SuccessfulWorkspaceHydration {
  if (cloudState) {
    const normalizedCloud = normalizeWorkspaceState(cloudState);
    const localTombstones = normalizeTombstones(localState.tombstones);
    const knownProjectIds = syncedProjectIds
      ? new Set(syncedProjectIds)
      : null;
    // Only this account's own saved snapshot may be merged forward. Without a
    // scoped snapshot the device is holding freshly seeded starter content,
    // which is not work anybody wrote — merging it would graft a demo project
    // and its chat onto a real restored workspace.
    const deviceState: VenomWorkspaceState = hasScopedState
      ? localState
      : {
          ...emptyDeviceState(normalizedCloud),
          sources: localState.sources ?? [],
          tombstones: {
            ...createEmptyTombstones(),
            sources: localTombstones.sources,
          },
          modelPreferences: localState.modelPreferences,
          voicePreferences: localState.voicePreferences,
        };
    const state = mergeWorkspaceStates(
      normalizedCloud,
      scopeDeviceWorkToKnownProjects(
        normalizedCloud,
        deviceState,
        knownProjectIds,
      ),
    );
    const shouldUpload =
      JSON.stringify(state) !==
      JSON.stringify(
        mergeWorkspaceStates(
          normalizedCloud,
          emptyDeviceState(normalizedCloud),
        ),
      );
    return {
      state,
      pendingLegacyImport: false,
      shouldUpload,
      syncStatus: shouldUpload ? 'syncing' : 'synced',
      // Everything the cloud snapshot listed is now known to have reached it.
      // Earlier baseline entries are kept while the device still holds the
      // project, so a reload that never got as far as persisting this merge
      // cannot mistake a project the cloud dropped for one created here.
      syncedProjectIds: [
        ...new Set([
          ...workspaceProjectIds(normalizedCloud),
          ...(syncedProjectIds ?? []).filter((projectId) =>
            deviceState.projects.some(
              (project) => project.id === projectId,
            ),
          ),
        ]),
      ],
    };
  }

  if (!hasScopedState && legacyState) {
    return {
      state: createFreshState(),
      pendingLegacyImport: true,
      shouldUpload: false,
      syncStatus: 'pending',
      syncedProjectIds: null,
    };
  }

  return {
    state: localState,
    pendingLegacyImport: false,
    shouldUpload: true,
    syncStatus: 'syncing',
    syncedProjectIds: null,
  };
}

export const DEFAULT_VOICE_TALKATIVENESS: VenomVoiceTalkativeness = 'balanced';
