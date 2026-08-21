/**
 * Pure state utilities for VenomWorkspace – no React, no I/O.
 * Mirrors mobile knowledgeState.ts + VenomContext.tsx merge helpers,
 * re-typed against the generated VenomWorkspaceState contract.
 */

import type {
  VenomArchivedCitation,
  VenomConversation,
  VenomDeletionMarker,
  VenomKnowledgeCluster,
  VenomKnowledgeSource,
  ProjectSource,
  ProjectSourceSchedule,
  VenomProject,
  VenomWorkspaceState,
  VenomWorkspaceTombstones,
  KnowledgeCandidate,
  VenomModelPreferences,
  VenomModelId,
  VenomVoicePreferences,
  VenomVoicePresetId,
  VenomVoiceTalkativeness,
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

export {
  availableTaskStatuses,
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

  return {
    enabledModelIds: enabled,
    defaultModelId: effectiveDefault,
    activeModelId: effectiveActive,
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
// Tombstone helpers
// ---------------------------------------------------------------------------

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
  ...markerLists: DeletionMarker[][]
): DeletionMarker[] {
  const merged = new Map<string, DeletionMarker>();
  for (const marker of markerLists.flat()) {
    const existing = merged.get(marker.id);
    const winner = !existing || marker.deletedAt > existing.deletedAt ? marker : existing;
    // A "replaced" tombstone (a source retired by a refresh) is permanent, so
    // the flag is sticky: a later plain deletion marker for the same id must
    // not downgrade it into one a stale snapshot can outlive.
    const replaced = isReplacementMarker(marker) || (!!existing && isReplacementMarker(existing));
    merged.set(
      marker.id,
      replaced === isReplacementMarker(winner) ? winner : { ...winner, replaced: true },
    );
  }
  return boundDeletionMarkers([...merged.values()], limit);
}

/**
 * Caps a tombstone list without dropping a permanent retirement. Plain
 * deletion markers are evicted oldest-first as before, but a "replaced" marker
 * outranks them: losing one would let a stale device hand back a source a
 * refresh already replaced. Only replacement markers filling the whole cap can
 * shed one, and then the newest survive.
 */
function boundDeletionMarkers(markers: DeletionMarker[], limit: number): DeletionMarker[] {
  const newestFirst = [...markers].sort((a, b) => b.deletedAt - a.deletedAt);
  if (newestFirst.length <= limit) return newestFirst;

  const replaced = newestFirst.filter(isReplacementMarker);
  if (replaced.length >= limit) return replaced.slice(0, limit);

  const deleted = newestFirst.filter((marker) => !isReplacementMarker(marker));
  const kept = new Set([...replaced, ...deleted.slice(0, limit - replaced.length)]);
  return newestFirst.filter((marker) => kept.has(marker));
}

export function normalizeTombstones(
  tombstones: WorkspaceState['tombstones'],
): WorkspaceTombstones {
  const empty = createEmptyTombstones();
  if (!tombstones) return empty;
  return {
    projects: mergeDeletionMarkers(TOMBSTONE_LIMITS.projects, tombstones.projects ?? []),
    tasks: mergeDeletionMarkers(TOMBSTONE_LIMITS.tasks, tombstones.tasks ?? []),
    conversations: mergeDeletionMarkers(
      TOMBSTONE_LIMITS.conversations,
      tombstones.conversations ?? [],
    ),
    messages: mergeDeletionMarkers(TOMBSTONE_LIMITS.messages, tombstones.messages ?? []),
    clusters: mergeDeletionMarkers(TOMBSTONE_LIMITS.clusters, tombstones.clusters ?? []),
    stages: mergeDeletionMarkers(TOMBSTONE_LIMITS.stages, tombstones.stages ?? []),
    fields: mergeDeletionMarkers(TOMBSTONE_LIMITS.fields, tombstones.fields ?? []),
    sources: mergeDeletionMarkers(TOMBSTONE_LIMITS.sources, tombstones.sources ?? []),
  };
}

export function mergeTombstones(
  current: WorkspaceState['tombstones'],
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
    sources: mergeDeletionMarkers(
      TOMBSTONE_LIMITS.sources,
      normalized.sources,
      additions.sources ?? [],
    ),
  };
}

export function createDeletionMarkers(ids: string[], deletedAt: number): DeletionMarker[] {
  return [...new Set(ids)].map((id) => ({ id, deletedAt }));
}

function deletionTimeMap(markers: DeletionMarker[]): Map<string, number> {
  return new Map(markers.map((m) => [m.id, m.deletedAt]));
}

/**
 * True for a source retired because a refresh put a newer snapshot in its
 * place. Such an id can never legitimately return, unlike a plain removal that
 * a later reconnect is allowed to undo.
 */
function isReplacementMarker(marker: DeletionMarker): boolean {
  return marker.replaced === true;
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
        name: 'Global Workspace',
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

// ---------------------------------------------------------------------------
// State validation & normalisation
// ---------------------------------------------------------------------------

export function isWorkspaceState(value: unknown): value is WorkspaceState {
  if (!value || typeof value !== 'object') return false;
  const c = value as Partial<WorkspaceState>;
  return Array.isArray(c.projects) && Array.isArray(c.conversations) && Array.isArray(c.clusters);
}

export function normalizeWorkspaceState(value: WorkspaceState): WorkspaceState {
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
        summary: typeof cluster.summary === 'string' ? cluster.summary : legacyDescription,
        mentionCount: typeof cluster.mentionCount === 'number' ? cluster.mentionCount : 1,
        lastUpdatedAt: typeof cluster.lastUpdatedAt === 'number' ? cluster.lastUpdatedAt : 0,
        sources: Array.isArray(cluster.sources) ? cluster.sources : [],
      };
    }),
    tombstones: normalizeTombstones(value.tombstones),
    modelPreferences: normalizeModelPreferences(value.modelPreferences),
    voicePreferences: normalizeVoicePreferences(value.voicePreferences),
    archivedCitations: mergeArchivedCitations(value.archivedCitations),
  };
}

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
 * Mirrors the mobile app's scheduled-sync claim lease
 * (artifacts/venom/context/sourceState.ts). Desktop never runs scheduled
 * syncs itself, but its conflict merges must not hand a claimed slot to a
 * second device by dropping the claim.
 */
const SCHEDULED_SYNC_CLAIM_LEASE_MS = 10 * 60_000;

type ScheduledSyncClaim = { claimedAt: number; claimedBy: string };

function scheduleUpdatedAt(schedule: ProjectSourceSchedule): number {
  return typeof schedule.updatedAt === 'number' && Number.isFinite(schedule.updatedAt)
    ? schedule.updatedAt
    : 0;
}

function scheduleAttemptAt(schedule: ProjectSourceSchedule): number | null {
  return typeof schedule.lastAttemptAt === 'number' && Number.isFinite(schedule.lastAttemptAt)
    ? schedule.lastAttemptAt
    : null;
}

/** A claim already resolved by an attempt recorded at or after it is spent. */
function scheduleSyncClaim(schedule: ProjectSourceSchedule): ScheduledSyncClaim | null {
  const claimedAt =
    typeof schedule.claimedAt === 'number' && Number.isFinite(schedule.claimedAt)
      ? schedule.claimedAt
      : null;
  const claimedBy =
    typeof schedule.claimedBy === 'string' && schedule.claimedBy ? schedule.claimedBy : null;
  if (claimedAt === null || claimedBy === null) return null;
  if (claimedAt <= (scheduleAttemptAt(schedule) ?? -1)) return null;
  return { claimedAt, claimedBy };
}

/**
 * A claim staked a full lease after another is a takeover of a lease that ran
 * out; anything closer is two devices racing for the same slot, and the copy
 * already in place (the cloud side of a conflict merge) wins.
 */
function mergeScheduleSyncClaims(
  current: ProjectSourceSchedule,
  incoming: ProjectSourceSchedule,
): ScheduledSyncClaim | null {
  const left = scheduleSyncClaim(current);
  const right = scheduleSyncClaim(incoming);
  if (!left || !right) return left ?? right;
  if (Math.abs(left.claimedAt - right.claimedAt) >= SCHEDULED_SYNC_CLAIM_LEASE_MS) {
    return left.claimedAt >= right.claimedAt ? left : right;
  }
  return left;
}

/**
 * Picks the schedule a user set most recently across two copies of the same
 * source, keeping the newest attempt bookkeeping and the surviving sync claim.
 * Mirrors mergeSourceSchedules in artifacts/venom/context/sourceState.ts: a
 * desktop save that dropped a phone's schedule or claim would re-enable the
 * double syncs the claim exists to prevent.
 */
function mergeSourceSchedules(
  current: ProjectSource,
  incoming: ProjectSource,
): ProjectSourceSchedule | null {
  const left = current.schedule;
  const right = incoming.schedule;
  if (!left || !right) return right ?? left ?? null;

  const winner = scheduleUpdatedAt(right) >= scheduleUpdatedAt(left) ? right : left;
  if (winner.cadence === 'off') return winner;

  const attempt =
    (scheduleAttemptAt(right) ?? -1) >= (scheduleAttemptAt(left) ?? -1) ? right : left;
  const claim = mergeScheduleSyncClaims(left, right);
  const liveClaim =
    claim && claim.claimedAt > (scheduleAttemptAt(attempt) ?? -1) ? claim : null;

  return {
    cadence: winner.cadence,
    updatedAt: scheduleUpdatedAt(winner),
    ...(scheduleAttemptAt(attempt) !== null ? { lastAttemptAt: attempt.lastAttemptAt } : {}),
    ...(attempt.lastError ? { lastError: attempt.lastError } : {}),
    ...(liveClaim ? { claimedAt: liveClaim.claimedAt, claimedBy: liveClaim.claimedBy } : {}),
  };
}

function withSchedule(
  source: ProjectSource,
  schedule: ProjectSourceSchedule | null,
): ProjectSource {
  if (!schedule) {
    if (!source.schedule) return source;
    const { schedule: _unscheduled, ...withoutSchedule } = source;
    return withoutSchedule;
  }

  return source.schedule === schedule ? source : { ...source, schedule };
}

function mergeProjectSources(
  cloudItems: ProjectSource[],
  deviceItems: ProjectSource[],
  deletionMarkers: DeletionMarker[],
): ProjectSource[] {
  const markersById = new Map(deletionMarkers.map((marker) => [marker.id, marker] as const));
  const merged = new Map<string, ProjectSource>(
    cloudItems.map((source) => [source.id, source]),
  );

  for (const source of deviceItems) {
    const existing = merged.get(source.id);
    if (!existing) {
      merged.set(source.id, source);
      continue;
    }

    // The snapshot and the schedule are edited independently: a cadence change
    // never moves syncedAt, so picking the newer snapshot must not silently
    // discard the newer schedule (or the other way round).
    const winner = source.syncedAt >= existing.syncedAt ? source : existing;
    merged.set(source.id, withSchedule(winner, mergeSourceSchedules(existing, source)));
  }

  return [...merged.values()].filter((source) => {
    const marker = markersById.get(source.id);
    if (!marker) return true;
    // A refresh already replaced this source, so a device claiming a newer
    // snapshot (clock skew, or a sync of the old id that started before the
    // refresh) must not bring the retired id back.
    if (isReplacementMarker(marker)) return false;
    return marker.deletedAt < Date.parse(source.syncedAt);
  });
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
  const liveClusters = reconcileKnowledgeLinks(
    [...clusters.values()].filter(
      (c) =>
        (c.projectId === null || projectIds.has(c.projectId)) &&
        (clusterDeletionTimes.get(c.id) ?? -1) < c.lastUpdatedAt,
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
// Knowledge position helper
// ---------------------------------------------------------------------------

function positionForLabel(label: string, index: number): { x: number; y: number } {
  const hash = [...label].reduce((v, ch) => (v * 31 + ch.charCodeAt(0)) >>> 0, 17);
  const angle = (hash % 360) * (Math.PI / 180);
  const radius = 80 + ((hash >>> 8) % 4) * 42 + (index % 3) * 18;
  return { x: Math.round(Math.cos(angle) * radius), y: Math.round(Math.sin(angle) * radius) };
}

// ---------------------------------------------------------------------------
// Apply knowledge insights
// ---------------------------------------------------------------------------

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
      const position = positionForLabel(label, clusters.length);
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

  const reconciled = reconcileKnowledgeLinks(clusters);

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
