/**
 * Pure state utilities for VenomWorkspace – no React, no I/O.
 * Mirrors mobile knowledgeState.ts + VenomContext.tsx merge helpers,
 * re-typed against the generated VenomWorkspaceState contract.
 */

import type {
  VenomConversation,
  VenomDeletionMarker,
  VenomKnowledgeCluster,
  VenomKnowledgeSource,
  VenomProject,
  VenomWorkspaceState,
  VenomWorkspaceTombstones,
  KnowledgeCandidate,
} from '@workspace/api-client-react';

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
};

export function createEmptyTombstones(): WorkspaceTombstones {
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
  ...markerLists: DeletionMarker[][]
): DeletionMarker[] {
  const merged = new Map<string, DeletionMarker>();
  for (const marker of markerLists.flat()) {
    const existing = merged.get(marker.id);
    if (!existing || marker.deletedAt > existing.deletedAt) {
      merged.set(marker.id, marker);
    }
  }
  return [...merged.values()]
    .sort((a, b) => b.deletedAt - a.deletedAt)
    .slice(0, limit);
}

export function normalizeTombstones(
  tombstones: WorkspaceState['tombstones'],
): WorkspaceTombstones {
  const empty = createEmptyTombstones();
  if (!tombstones) return empty;
  return {
    projects: mergeDeletionMarkers(TOMBSTONE_LIMITS.projects, tombstones.projects),
    tasks: mergeDeletionMarkers(TOMBSTONE_LIMITS.tasks, tombstones.tasks),
    conversations: mergeDeletionMarkers(TOMBSTONE_LIMITS.conversations, tombstones.conversations),
    messages: mergeDeletionMarkers(TOMBSTONE_LIMITS.messages, tombstones.messages),
    clusters: mergeDeletionMarkers(TOMBSTONE_LIMITS.clusters, tombstones.clusters),
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
  };
}

export function createDeletionMarkers(ids: string[], deletedAt: number): DeletionMarker[] {
  return [...new Set(ids)].map((id) => ({ id, deletedAt }));
}

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
  return {
    projects: [
      {
        id: 'proj_default',
        name: 'Global Workspace',
        description: 'Uncategorized intelligence',
        accent: '#e5e5e5',
        sourceCount: 0,
        updatedAt: now,
        tasks: [
          { id: 'task_1', title: 'Define data schema', status: 'done', createdAt: now - 100000 },
          { id: 'task_2', title: 'Implement authentication', status: 'in_progress', createdAt: now - 50000 },
          { id: 'task_3', title: 'Design onboarding flow', status: 'todo', createdAt: now },
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
        summary: typeof cluster.summary === 'string' ? cluster.summary : legacyDescription,
        mentionCount: typeof cluster.mentionCount === 'number' ? cluster.mentionCount : 1,
        lastUpdatedAt: typeof cluster.lastUpdatedAt === 'number' ? cluster.lastUpdatedAt : 0,
        sources: Array.isArray(cluster.sources) ? cluster.sources : [],
      };
    }),
    tombstones: normalizeTombstones(value.tombstones),
  };
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
  const taskDeletionTimes = deletionTimeMap(tombstones.tasks);
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

    const older = newest === deviceItem ? cloudItem : deviceItem;
    const tasks = new Map((older?.tasks ?? []).map((task) => [task.id, task]));
    for (const task of newest.tasks) tasks.set(task.id, task);

    merged.push({
      ...newest,
      tasks: [...tasks.values()].filter(
        (task) => (taskDeletionTimes.get(task.id) ?? -1) < task.createdAt,
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

    merged.push({
      ...newest,
      messages: [...messages.values()]
        .filter((m) => (msgDeletionTimes.get(m.id) ?? -1) < m.createdAt)
        .sort((a, b) => a.createdAt - b.createdAt),
    });
  }
  return merged;
}

export function mergeWorkspaceStates(
  cloudState: WorkspaceState,
  deviceState: WorkspaceState,
): WorkspaceState {
  const tombstones = mergeTombstones(cloudState.tombstones, {
    ...normalizeTombstones(deviceState.tombstones),
  });
  const projects = mergeProjects(cloudState.projects, deviceState.projects, tombstones);
  const conversations = mergeConversations(
    cloudState.conversations,
    deviceState.conversations,
    tombstones,
  );
  const clusterDeletionTimes = deletionTimeMap(tombstones.clusters);
  const clusters = new Map(cloudState.clusters.map((c) => [c.id, c]));
  for (const cluster of deviceState.clusters) {
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

  const preferredProjectId =
    deviceState.activeProjectId && projectIds.has(deviceState.activeProjectId)
      ? deviceState.activeProjectId
      : cloudState.activeProjectId && projectIds.has(cloudState.activeProjectId)
        ? cloudState.activeProjectId
        : null;

  const preferredConversationId =
    deviceState.activeConversationId && conversationIds.has(deviceState.activeConversationId)
      ? deviceState.activeConversationId
      : cloudState.activeConversationId && conversationIds.has(cloudState.activeConversationId)
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
