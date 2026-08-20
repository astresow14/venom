import React, {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  useCallback,
} from "react";
import AsyncStorage from "@react-native-async-storage/async-storage";

export type TaskStatus = "todo" | "in_progress" | "done";

export type Task = {
  id: string;
  title: string;
  status: TaskStatus;
  createdAt: number;
};

export type Project = {
  id: string;
  name: string;
  description: string;
  accent: string;
  sourceCount: number;
  updatedAt: number;
  tasks: Task[];
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

type VenomState = {
  projects: Project[];
  conversations: Conversation[];
  clusters: KnowledgeCluster[];
  activeProjectId: string | null;
  activeConversationId: string | null;
};

type VenomContextType = {
  state: VenomState;
  isReady: boolean;
  addProject: (p: Omit<Project, "id" | "updatedAt" | "tasks">) => void;
  updateProject: (id: string, p: Partial<Project>) => void;
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
    convId: string | null,
    msg: Omit<Message, "id" | "createdAt"> & { id?: string },
  ) => string;
  updateMessage: (
    convId: string,
    msgId: string,
    updates: Partial<Message>,
  ) => void;
  setActiveConversation: (id: string | null) => void;
  clearConversation: (id: string) => void;
  createNewConversation: (projectId: string | null) => string;
  applyKnowledgeInsights: (
    conversation: Pick<Conversation, "id" | "title" | "projectId">,
    insights: KnowledgeInsight[],
  ) => void;
};

const initialState: VenomState = {
  projects: [],
  conversations: [],
  clusters: [],
  activeProjectId: null,
  activeConversationId: null,
};

const VenomContext = createContext<VenomContextType | null>(null);

const STORAGE_KEY = "@venom_state_v3";
const LEGACY_STORAGE_KEY = "@venom_state_v1";
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

function pruneKnowledgeSources(
  clusters: KnowledgeCluster[],
  shouldRemove: (source: KnowledgeSource) => boolean,
) {
  const withLiveSources = clusters
    .map((cluster) => ({
      ...cluster,
      sources: cluster.sources.filter((source) => !shouldRemove(source)),
    }))
    .filter((cluster) => cluster.sources.length > 0);
  const liveClusterIds = new Set(
    withLiveSources.map((cluster) => cluster.id),
  );
  return withLiveSources.map((cluster) => ({
    ...cluster,
    links: cluster.links.filter((linkId) => liveClusterIds.has(linkId)),
  }));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function migrateKnowledgeClusters(
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
              typeof messageId === "string" &&
              liveMessageIds.has(messageId),
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
        id:
          groupIndex === 0
            ? rawCluster.id
            : `${rawCluster.id}_${groupIndex}`,
        projectId: sources[0].projectId,
        label: rawCluster.label,
        category:
          typeof rawCluster.category === "string"
            ? rawCluster.category
            : "topic",
        strength:
          typeof rawCluster.strength === "number"
            ? rawCluster.strength
            : 0.5,
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

export function VenomProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<VenomState>(initialState);
  const [isReady, setIsReady] = useState(false);
  const persistenceQueue = useRef<Promise<void>>(Promise.resolve());

  useEffect(() => {
    Promise.all([
      AsyncStorage.getItem(STORAGE_KEY),
      AsyncStorage.getItem(LEGACY_STORAGE_KEY),
    ]).then(([currentData, legacyData]) => {
      const data = currentData ?? legacyData;

      if (data) {
        try {
          const parsed = JSON.parse(data) as Partial<VenomState>;
          const migratedProjects = Array.isArray(parsed.projects)
            ? parsed.projects.map((project) => ({
                ...project,
                tasks: Array.isArray(project.tasks) ? project.tasks : [],
              }))
            : [];
          const conversations = Array.isArray(parsed.conversations)
            ? parsed.conversations
            : [];
          const clusters = migrateKnowledgeClusters(
            parsed.clusters,
            conversations,
          );
          setState((prev) => ({
            ...prev,
            ...parsed,
            projects: migratedProjects,
            conversations,
            clusters,
          }));
        } catch (e) {
          console.error("Failed to parse venom state", e);
        }
      } else {
        const defaultProject: Project = {
          id: "proj_default",
          name: "Main Workspace",
          description: "Default intelligence container",
          accent: "#10b981",
          sourceCount: 0,
          updatedAt: Date.now(),
          tasks: [
            {
              id: "task_1",
              title: "Define data schema",
              status: "done",
              createdAt: Date.now() - 100000,
            },
            {
              id: "task_2",
              title: "Implement authentication",
              status: "in_progress",
              createdAt: Date.now() - 50000,
            },
            {
              id: "task_3",
              title: "Design onboarding flow",
              status: "todo",
              createdAt: Date.now(),
            },
          ],
        };
        const defaultConv: Conversation = {
          id: "conv_default",
          title: "New Session",
          projectId: "proj_default",
          updatedAt: Date.now(),
          messages: [],
        };
        setState((prev) => ({
          ...prev,
          projects: [defaultProject],
          conversations: [defaultConv],
          activeProjectId: "proj_default",
          activeConversationId: "conv_default",
        }));
      }
      setIsReady(true);
    });
  }, []);

  useEffect(() => {
    if (isReady) {
      const snapshot = JSON.stringify(state);
      persistenceQueue.current = persistenceQueue.current
        .catch(() => undefined)
        .then(() => AsyncStorage.setItem(STORAGE_KEY, snapshot))
        .catch((error) => {
          console.error("Failed to persist venom state", error);
        });
    }
  }, [state, isReady]);

  const generateId = useCallback(
    (prefix: string) =>
      `${prefix}_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`,
    [],
  );

  const addProject = useCallback(
    (p: Omit<Project, "id" | "updatedAt" | "tasks">) => {
      const newProject = {
        ...p,
        id: generateId("proj"),
        updatedAt: Date.now(),
        tasks: [],
      };
      setState((s) => ({ ...s, projects: [...s.projects, newProject] }));
    },
    [generateId],
  );

  const updateProject = useCallback((id: string, updates: Partial<Project>) => {
    setState((s) => ({
      ...s,
      projects: s.projects.map((p) =>
        p.id === id ? { ...p, ...updates, updatedAt: Date.now() } : p,
      ),
    }));
  }, []);

  const deleteProject = useCallback((id: string) => {
    setState((s) => {
      const removedConversationIds = new Set(
        s.conversations
          .filter((conversation) => conversation.projectId === id)
          .map((conversation) => conversation.id),
      );
      return {
        ...s,
        projects: s.projects.filter((project) => project.id !== id),
        activeProjectId: s.activeProjectId === id ? null : s.activeProjectId,
        conversations: s.conversations.filter(
          (conversation) => conversation.projectId !== id,
        ),
        clusters: pruneKnowledgeSources(
          s.clusters,
          (source) =>
            source.projectId === id ||
            removedConversationIds.has(source.conversationId),
        ),
      };
    });
  }, []);

  const setActiveProject = useCallback((id: string | null) => {
    setState((s) => ({ ...s, activeProjectId: id }));
  }, []);

  const addTask = useCallback(
    (projectId: string, title: string) => {
      setState((s) => ({
        ...s,
        projects: s.projects.map((p) => {
          if (p.id !== projectId) return p;
          const newTask: Task = {
            id: generateId("task"),
            title,
            status: "todo",
            createdAt: Date.now(),
          };
          return { ...p, tasks: [...p.tasks, newTask], updatedAt: Date.now() };
        }),
      }));
    },
    [generateId],
  );

  const updateTaskStatus = useCallback(
    (projectId: string, taskId: string, status: TaskStatus) => {
      setState((s) => ({
        ...s,
        projects: s.projects.map((p) => {
          if (p.id !== projectId) return p;
          const updatedTasks = p.tasks.map((t) =>
            t.id === taskId ? { ...t, status } : t,
          );
          return { ...p, tasks: updatedTasks, updatedAt: Date.now() };
        }),
      }));
    },
    [],
  );

  const deleteTask = useCallback((projectId: string, taskId: string) => {
    setState((s) => ({
      ...s,
      projects: s.projects.map((p) => {
        if (p.id !== projectId) return p;
        const updatedTasks = p.tasks.filter((t) => t.id !== taskId);
        return { ...p, tasks: updatedTasks, updatedAt: Date.now() };
      }),
    }));
  }, []);

  const createNewConversation = useCallback(
    (projectId: string | null) => {
      const newConv: Conversation = {
        id: generateId("conv"),
        title: "New Session",
        projectId,
        updatedAt: Date.now(),
        messages: [],
      };
      setState((s) => ({
        ...s,
        conversations: [...s.conversations, newConv],
        activeConversationId: newConv.id,
      }));
      return newConv.id;
    },
    [generateId],
  );

  const setActiveConversation = useCallback((id: string | null) => {
    setState((s) => ({ ...s, activeConversationId: id }));
  }, []);

  const addMessage = useCallback(
    (
      convId: string | null,
      msg: Omit<Message, "id" | "createdAt"> & { id?: string },
    ) => {
      let targetConvId = convId;
      let s = { ...state };

      if (!targetConvId) {
        targetConvId = createNewConversation(s.activeProjectId);
        const newConv: Conversation = {
          id: targetConvId,
          title: "New Session",
          projectId: s.activeProjectId,
          updatedAt: Date.now(),
          messages: [],
        };
        s.conversations = [...s.conversations, newConv];
        s.activeConversationId = targetConvId;
      }

      const newMessage: Message = {
        ...msg,
        id: msg.id ?? generateId("msg"),
        createdAt: Date.now(),
      };

      setState((prev) => {
        const targetConvIndex = prev.conversations.findIndex(
          (c) => c.id === targetConvId,
        );
        if (targetConvIndex === -1) return prev;

        const updatedConvs = [...prev.conversations];
        updatedConvs[targetConvIndex] = {
          ...updatedConvs[targetConvIndex],
          updatedAt: Date.now(),
          messages: [...updatedConvs[targetConvIndex].messages, newMessage],
        };

        if (
          updatedConvs[targetConvIndex].messages.length === 1 &&
          newMessage.role === "user"
        ) {
          updatedConvs[targetConvIndex].title =
            newMessage.content.slice(0, 30) + "...";
        }

        return {
          ...prev,
          conversations: updatedConvs,
          activeConversationId: targetConvId,
        };
      });

      return targetConvId;
    },
    [state, createNewConversation, generateId],
  );

  const updateMessage = useCallback(
    (convId: string, msgId: string, updates: Partial<Message>) => {
      setState((s) => {
        const convIndex = s.conversations.findIndex((c) => c.id === convId);
        if (convIndex === -1) return s;

        const updatedConvs = [...s.conversations];
        const conv = updatedConvs[convIndex];
        const msgIndex = conv.messages.findIndex((m) => m.id === msgId);
        if (msgIndex === -1) return s;

        const updatedMessages = [...conv.messages];
        updatedMessages[msgIndex] = {
          ...updatedMessages[msgIndex],
          ...updates,
        };

        updatedConvs[convIndex] = { ...conv, messages: updatedMessages };

        return { ...s, conversations: updatedConvs };
      });
    },
    [],
  );

  const clearConversation = useCallback((id: string) => {
    setState((s) => ({
      ...s,
      conversations: s.conversations.map((c) =>
        c.id === id ? { ...c, messages: [] } : c,
      ),
      clusters: pruneKnowledgeSources(
        s.clusters,
        (source) => source.conversationId === id,
      ),
    }));
  }, []);

  const applyKnowledgeInsights = useCallback(
    (
      conversation: Pick<Conversation, "id" | "title" | "projectId">,
      insights: KnowledgeInsight[],
    ) => {
      if (!insights.length) return;

      const now = Date.now();
      setState((s) => {
        const liveConversation = s.conversations.find(
          (item) => item.id === conversation.id,
        );
        if (
          !liveConversation ||
          liveConversation.projectId !== conversation.projectId
        ) {
          return s;
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
        if (!applicableInsights.length) return s;

        const clusters = s.clusters.map((cluster) => ({
          ...cluster,
          strength:
            cluster.projectId === liveConversation.projectId
              ? Math.max(0.12, cluster.strength * 0.96)
              : cluster.strength,
        }));
        const clusterByLabel = new Map(
          clusters
            .filter(
              (cluster) =>
                cluster.projectId === liveConversation.projectId,
            )
            .map((cluster) => [normalizeLabel(cluster.label), cluster]),
        );

        for (const insight of applicableInsights) {
          const label = insight.label.trim();
          const normalizedLabel = normalizeLabel(label);
          if (!label || !normalizedLabel) continue;

          const confidence = Math.max(
            0,
            Math.min(1, insight.confidence),
          );
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
            existing.category =
              insight.category.trim() || existing.category;
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
          const source = clusterByLabel.get(
            normalizeLabel(insight.label),
          );
          if (!source) continue;

          for (const relatedLabel of insight.relatedLabels) {
            const target = clusterByLabel.get(
              normalizeLabel(relatedLabel),
            );
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
            .filter(
              (cluster) =>
                cluster.projectId === liveConversation.projectId,
            )
            .flatMap((cluster) =>
              cluster.sources.map((source) => source.conversationId),
            ),
        );
        const projects = s.projects.map((project) =>
          project.id === liveConversation.projectId
            ? {
                ...project,
                sourceCount: projectConversationIds.size,
                updatedAt: now,
              }
            : project,
        );

        return { ...s, clusters, projects };
      });
    },
    [generateId],
  );

  return (
    <VenomContext.Provider
      value={{
        state,
        isReady,
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
      }}
    >
      {children}
    </VenomContext.Provider>
  );
}

export function useVenom() {
  const context = useContext(VenomContext);
  if (!context) throw new Error("useVenom must be used within VenomProvider");
  return context;
}
