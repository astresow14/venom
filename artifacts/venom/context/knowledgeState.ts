export type TaskStatus = "todo" | "in_progress" | "done";

export type Task = {
  id: string;
  title: string;
  status?: TaskStatus;
  stageId: string;
  position: number;
  createdAt: number;
  updatedAt: number;
  values: Record<string, string | number | boolean>;
};

export type KanbanStage = {
  id: string;
  name: string;
  position: number;
  isDone: boolean;
  updatedAt: number;
};

export type KanbanField = {
  id: string;
  name: string;
  type: "text" | "number" | "date" | "single_select" | "checkbox";
  options: string[];
  position: number;
  showOnCard: boolean;
  updatedAt: number;
};

export type Project = {
  id: string;
  name: string;
  description: string;
  accent: string;
  sourceCount: number;
  updatedAt: number;
  tasks: Task[];
  boardStages: KanbanStage[];
  fieldDefinitions: KanbanField[];
};

export type Message = {
  id: string;
  role: "user" | "assistant";
  content: string;
  createdAt: number;
  status: "sending" | "sent" | "error";
};

export type Conversation = {
  id: string;
  title: string;
  projectId: string | null;
  updatedAt: number;
  messages: Message[];
};

export type KnowledgeCluster = {
  id: string;
  projectId: string | null;
  label: string;
  category: string;
  strength: number;
  x: number;
  y: number;
  links: string[];
  summary: string;
  mentionCount: number;
  lastUpdatedAt: number;
  sources: KnowledgeSource[];
};

export type KnowledgeSource = {
  conversationId: string;
  projectId: string | null;
  conversationTitle: string;
  messageIds: string[];
  excerpt: string;
  updatedAt: number;
};

export type KnowledgeInsight = {
  label: string;
  category: string;
  confidence: number;
  summary: string;
  sourceMessageIds: string[];
  relatedLabels: string[];
};

export type VenomState = {
  projects: Project[];
  conversations: Conversation[];
  clusters: KnowledgeCluster[];
  activeProjectId: string | null;
  activeConversationId: string | null;
};

export const initialVenomState: VenomState = {
  projects: [],
  conversations: [],
  clusters: [],
  activeProjectId: null,
  activeConversationId: null,
};

const normalizeLabel = (label: string) => label.trim().toLocaleLowerCase();

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

export function pruneKnowledgeSources(
  clusters: KnowledgeCluster[],
  shouldRemove: (source: KnowledgeSource) => boolean,
) {
  const withLiveSources = clusters
    .map((cluster) => ({
      ...cluster,
      sources: cluster.sources.filter((source) => !shouldRemove(source)),
    }))
    .filter((cluster) => cluster.sources.length > 0);
  const liveClusterIds = new Set(withLiveSources.map((cluster) => cluster.id));
  return withLiveSources.map((cluster) => ({
    ...cluster,
    links: cluster.links.filter((linkId) => liveClusterIds.has(linkId)),
  }));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function migrateKnowledgeClusters(
  rawClusters: unknown,
  conversations: Conversation[],
) {
  if (!Array.isArray(rawClusters)) return [];

  const conversationById = new Map(
    conversations.map((conversation) => [conversation.id, conversation]),
  );
  const migrated: KnowledgeCluster[] = [];

  for (const rawCluster of rawClusters) {
    if (
      !isRecord(rawCluster) ||
      typeof rawCluster.id !== "string" ||
      typeof rawCluster.label !== "string" ||
      !Array.isArray(rawCluster.sources)
    ) {
      continue;
    }

    const hasCurrentScope =
      Object.prototype.hasOwnProperty.call(rawCluster, "projectId") &&
      rawCluster.sources.every(
        (source) =>
          isRecord(source) &&
          Object.prototype.hasOwnProperty.call(source, "projectId"),
      );
    const sourceGroups = new Map<string, KnowledgeSource[]>();

    for (const rawSource of rawCluster.sources) {
      if (
        !isRecord(rawSource) ||
        typeof rawSource.conversationId !== "string"
      ) {
        continue;
      }
      const liveConversation = conversationById.get(rawSource.conversationId);
      if (!liveConversation) continue;

      const liveMessageIds = new Set(
        liveConversation.messages.map((message) => message.id),
      );
      const messageIds = Array.isArray(rawSource.messageIds)
        ? rawSource.messageIds.filter(
            (messageId): messageId is string =>
              typeof messageId === "string" && liveMessageIds.has(messageId),
          )
        : [];
      if (!messageIds.length) continue;

      const projectKey = liveConversation.projectId ?? "__unassigned__";
      const group = sourceGroups.get(projectKey) ?? [];
      group.push({
        conversationId: liveConversation.id,
        projectId: liveConversation.projectId,
        conversationTitle: liveConversation.title,
        messageIds,
        excerpt:
          typeof rawSource.excerpt === "string"
            ? rawSource.excerpt
            : typeof rawCluster.summary === "string"
              ? rawCluster.summary
              : rawCluster.label,
        updatedAt:
          typeof rawSource.updatedAt === "number"
            ? rawSource.updatedAt
            : liveConversation.updatedAt,
      });
      sourceGroups.set(projectKey, group);
    }

    let groupIndex = 0;
    for (const sources of sourceGroups.values()) {
      const position = positionForLabel(rawCluster.label, migrated.length);
      migrated.push({
        id: groupIndex === 0 ? rawCluster.id : `${rawCluster.id}_${groupIndex}`,
        projectId: sources[0].projectId,
        label: rawCluster.label,
        category:
          typeof rawCluster.category === "string"
            ? rawCluster.category
            : "topic",
        strength:
          typeof rawCluster.strength === "number" ? rawCluster.strength : 0.5,
        x: typeof rawCluster.x === "number" ? rawCluster.x : position.x,
        y: typeof rawCluster.y === "number" ? rawCluster.y : position.y,
        links:
          hasCurrentScope && Array.isArray(rawCluster.links)
            ? rawCluster.links.filter(
                (link): link is string => typeof link === "string",
              )
            : [],
        summary:
          typeof rawCluster.summary === "string"
            ? rawCluster.summary
            : sources[0].excerpt,
        mentionCount:
          typeof rawCluster.mentionCount === "number"
            ? rawCluster.mentionCount
            : sources.length,
        lastUpdatedAt:
          typeof rawCluster.lastUpdatedAt === "number"
            ? rawCluster.lastUpdatedAt
            : Math.max(...sources.map((source) => source.updatedAt)),
        sources,
      });
      groupIndex += 1;
    }
  }

  return pruneKnowledgeSources(migrated, () => false);
}

export function hydrateVenomState(rawState: unknown): Partial<VenomState> {
  if (!isRecord(rawState)) return {};

  const projects = Array.isArray(rawState.projects)
    ? (rawState.projects.filter(isRecord).map((project) => ({
        ...project,
        tasks: Array.isArray(project.tasks) ? project.tasks : [],
      })) as Project[])
    : [];
  const conversations = Array.isArray(rawState.conversations)
    ? (rawState.conversations.filter(isRecord) as Conversation[])
    : [];

  return {
    ...(rawState as Partial<VenomState>),
    projects,
    conversations,
    clusters: migrateKnowledgeClusters(rawState.clusters, conversations),
  };
}

export function deleteProjectKnowledge(state: VenomState, projectId: string) {
  const removedConversationIds = new Set(
    state.conversations
      .filter((conversation) => conversation.projectId === projectId)
      .map((conversation) => conversation.id),
  );

  return {
    ...state,
    projects: state.projects.filter((project) => project.id !== projectId),
    activeProjectId:
      state.activeProjectId === projectId ? null : state.activeProjectId,
    conversations: state.conversations.filter(
      (conversation) => conversation.projectId !== projectId,
    ),
    clusters: pruneKnowledgeSources(
      state.clusters,
      (source) =>
        source.projectId === projectId ||
        removedConversationIds.has(source.conversationId),
    ),
  };
}

export function clearConversationKnowledge(
  state: VenomState,
  conversationId: string,
) {
  return {
    ...state,
    conversations: state.conversations.map((conversation) =>
      conversation.id === conversationId
        ? { ...conversation, messages: [] }
        : conversation,
    ),
    clusters: pruneKnowledgeSources(
      state.clusters,
      (source) => source.conversationId === conversationId,
    ),
  };
}

export type FileKnowledgeNoteStatus =
  | "filed"
  | "no_concepts"
  | "project_unavailable";
type ApplyKnowledgeOptions = {
  state: VenomState;
  conversation: Pick<Conversation, "id" | "title" | "projectId">;
  insights: KnowledgeInsight[];
  now: number;
  generateId: (prefix: string) => string;
};

export function applyKnowledgeInsightsToState({
  state,
  conversation,
  insights,
  now,
  generateId,
}: ApplyKnowledgeOptions): VenomState {
  if (!insights.length) return state;

  const liveConversation = state.conversations.find(
    (item) => item.id === conversation.id,
  );
  if (
    !liveConversation ||
    liveConversation.projectId !== conversation.projectId
  ) {
    return state;
  }

  const liveMessageIds = new Set(
    liveConversation.messages.map((message) => message.id),
  );
  const applicableInsights = insights
    .map((insight) => ({
      ...insight,
      sourceMessageIds: insight.sourceMessageIds.filter((messageId) =>
        liveMessageIds.has(messageId),
      ),
    }))
    .filter((insight) => insight.sourceMessageIds.length > 0);
  if (!applicableInsights.length) return state;

  const clusters = state.clusters.map((cluster) => ({
    ...cluster,
    links: [...cluster.links],
    sources: [...cluster.sources],
    strength:
      cluster.projectId === liveConversation.projectId
        ? Math.max(0.12, cluster.strength * 0.96)
        : cluster.strength,
  }));
  const clusterByLabel = new Map(
    clusters
      .filter((cluster) => cluster.projectId === liveConversation.projectId)
      .map((cluster) => [normalizeLabel(cluster.label), cluster]),
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
      const priorSource = existing.sources.find(
        (item) => item.conversationId === conversation.id,
      );
      existing.category = insight.category.trim() || existing.category;
      existing.summary = insight.summary.trim() || existing.summary;
      existing.mentionCount += 1;
      existing.lastUpdatedAt = now;
      existing.strength = Math.min(
        1,
        existing.strength + 0.12 + confidence * 0.2,
      );
      existing.sources = [
        {
          ...source,
          messageIds: [
            ...new Set([
              ...(priorSource?.messageIds ?? []),
              ...source.messageIds,
            ]),
          ].slice(0, 12),
        },
        ...existing.sources.filter(
          (item) => item.conversationId !== conversation.id,
        ),
      ].slice(0, 8);
    } else {
      const position = positionForLabel(label, clusters.length);
      const created: KnowledgeCluster = {
        id: generateId("cluster"),
        projectId: liveConversation.projectId,
        label,
        category: insight.category.trim() || "topic",
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

  for (const insight of applicableInsights) {
    const source = clusterByLabel.get(normalizeLabel(insight.label));
    if (!source) continue;

    for (const relatedLabel of insight.relatedLabels) {
      const target = clusterByLabel.get(normalizeLabel(relatedLabel));
      if (!target || target.id === source.id) continue;
      if (!source.links.includes(target.id)) {
        source.links.push(target.id);
      }
      if (!target.links.includes(source.id)) {
        target.links.push(source.id);
      }
    }
  }

  const projectConversationIds = new Set(
    clusters
      .filter((cluster) => cluster.projectId === liveConversation.projectId)
      .flatMap((cluster) =>
        cluster.sources.map((source) => source.conversationId),
      ),
  );
  const projects = state.projects.map((project) =>
    project.id === liveConversation.projectId
      ? {
          ...project,
          sourceCount: projectConversationIds.size,
          updatedAt: now,
        }
      : project,
  );

  return { ...state, clusters, projects };
}

type FileKnowledgeNoteOptions = {
  state: VenomState;
  projectId: string;
  note: string;
  insights: KnowledgeInsight[];
  now: number;
  generateId: (prefix: string) => string;
};

export function fileKnowledgeNoteToState({
  state,
  projectId,
  note,
  insights,
  now,
  generateId,
}: FileKnowledgeNoteOptions): {
  state: VenomState;
  status: FileKnowledgeNoteStatus;
} {
  if (!state.projects.some((project) => project.id === projectId)) {
    return { state, status: "project_unavailable" };
  }

  const finalNote = note.trim();
  if (!finalNote || finalNote.length > 5000 || !insights.length) {
    return { state, status: "no_concepts" };
  }

  const conversationId = generateId("note");
  const messageId = generateId("note_msg");
  const conversation: Conversation = {
    id: conversationId,
    title: "Captured note",
    projectId,
    updatedAt: now,
    messages: [
      {
        id: messageId,
        role: "user",
        content: finalNote,
        createdAt: now,
        status: "sent",
      },
    ],
  };
  const noteInsights = insights.map((insight) => ({
    ...insight,
    sourceMessageIds: [messageId],
  }));
  const stagedState = {
    ...state,
    conversations: [...state.conversations, conversation],
  };
  const filedState = applyKnowledgeInsightsToState({
    state: stagedState,
    conversation,
    insights: noteInsights,
    now,
    generateId,
  });

  if (filedState.clusters === stagedState.clusters) {
    return { state, status: "no_concepts" };
  }

  return { state: filedState, status: "filed" };
}
