import React, {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  useCallback,
} from "react";
import AsyncStorage from "@react-native-async-storage/async-storage";
import {
  applyKnowledgeInsightsToState,
  clearConversationKnowledge,
  deleteProjectKnowledge,
  hydrateVenomState,
  initialVenomState,
  type Conversation,
  type KnowledgeCluster,
  type KnowledgeInsight,
  type KnowledgeSource,
  type Message,
  type Project,
  type Task,
  type TaskStatus,
  type VenomState,
} from "./knowledgeState";

const normalizeLabel = (label: string) => label.trim().toLocaleLowerCase();

function createWorkspaceBriefClusters(now: number): KnowledgeCluster[] {
  return [
    {
      id: "cluster_workspace",
      projectId: "proj_default",
      label: "Venom Workspace",
      category: "core",
      strength: 0.96,
      x: 0,
      y: 0,
      links: ["cluster_chat", "cluster_ontology", "cluster_execution"],
      summary:
        "A chat-first AI workspace that turns conversations into durable project context.",
      mentionCount: 1,
      lastUpdatedAt: now,
      sources: [],
    },
    {
      id: "cluster_chat",
      projectId: "proj_default",
      label: "Chat-first Interface",
      category: "experience",
      strength: 0.82,
      x: -82,
      y: -68,
      links: ["cluster_workspace", "cluster_feed"],
      summary:
        "The primary experience stays familiar and conversational, with deeper tools one gesture away.",
      mentionCount: 1,
      lastUpdatedAt: now - 1,
      sources: [],
    },
    {
      id: "cluster_ontology",
      projectId: "proj_default",
      label: "Living Ontology",
      category: "data",
      strength: 0.9,
      x: 92,
      y: -48,
      links: ["cluster_workspace", "cluster_sources", "cluster_feed"],
      summary:
        "Knowledge extracted from project conversations becomes an editable, connected graph.",
      mentionCount: 1,
      lastUpdatedAt: now - 2,
      sources: [],
    },
    {
      id: "cluster_execution",
      projectId: "proj_default",
      label: "Project Execution",
      category: "workflow",
      strength: 0.72,
      x: -72,
      y: 92,
      links: ["cluster_workspace", "cluster_sources"],
      summary:
        "Notes and to-dos keep decisions tied to the work that follows from them.",
      mentionCount: 1,
      lastUpdatedAt: now - 3,
      sources: [],
    },
    {
      id: "cluster_feed",
      projectId: "proj_default",
      label: "Workspace Feed",
      category: "experience",
      strength: 0.66,
      x: 120,
      y: 82,
      links: ["cluster_chat", "cluster_ontology"],
      summary:
        "A chronological surface for conversations, learned notes, and task movement.",
      mentionCount: 1,
      lastUpdatedAt: now - 4,
      sources: [],
    },
    {
      id: "cluster_sources",
      projectId: "proj_default",
      label: "Connected Sources",
      category: "data",
      strength: 0.76,
      x: 12,
      y: 142,
      links: ["cluster_ontology", "cluster_execution"],
      summary:
        "External tools and websites provide the project context Venom can reason across.",
      mentionCount: 1,
      lastUpdatedAt: now - 5,
      sources: [],
    },
  ];
}

export type {
  Conversation,
  KnowledgeCluster,
  KnowledgeInsight,
  KnowledgeSource,
  Message,
  Project,
  Task,
  TaskStatus,
} from "./knowledgeState";

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
  renameKnowledgeCluster: (clusterId: string, label: string) => void;
  deleteKnowledgeCluster: (clusterId: string) => void;
  mergeKnowledgeClusters: (
    targetClusterId: string,
    sourceClusterId: string,
  ) => void;
};

const VenomContext = createContext<VenomContextType | null>(null);

const STORAGE_KEY = "@venom_state_v3";
const LEGACY_STORAGE_KEY = "@venom_state_v1";

export function VenomProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<VenomState>(initialVenomState);
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
          const hydratedState = hydrateVenomState(JSON.parse(data));
          setState((prev) => {
            const projects = hydratedState.projects ?? prev.projects;
            const conversations =
              hydratedState.conversations ?? prev.conversations;
            const clusters = hydratedState.clusters ?? prev.clusters;
            const shouldAddWorkspaceBrief =
              clusters.length === 0 &&
              projects.some((project) => project.id === "proj_default") &&
              conversations.every(
                (conversation) => conversation.messages.length === 0,
              );

            return {
              ...prev,
              ...hydratedState,
              projects,
              conversations,
              clusters: shouldAddWorkspaceBrief
                ? createWorkspaceBriefClusters(Date.now())
                : clusters,
            };
          });
        } catch (e) {
          console.error("Failed to parse venom state", e);
        }
      } else {
        const defaultProject: Project = {
          id: "proj_default",
          name: "Main Workspace",
          description: "Default intelligence container",
          accent: "#111111",
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
          clusters: createWorkspaceBriefClusters(Date.now()),
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
    setState((state) => deleteProjectKnowledge(state, id));
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
    setState((state) => clearConversationKnowledge(state, id));
  }, []);

  const applyKnowledgeInsights = useCallback(
    (
      conversation: Pick<Conversation, "id" | "title" | "projectId">,
      insights: KnowledgeInsight[],
    ) => {
      const now = Date.now();
      setState((state) =>
        applyKnowledgeInsightsToState({
          state,
          conversation,
          insights,
          now,
          generateId,
        }),
      );
    },
    [generateId],
  );

  const renameKnowledgeCluster = useCallback(
    (clusterId: string, label: string) => {
      const cleanedLabel = label.trim();
      if (!cleanedLabel) return;

      setState((s) => {
        const cluster = s.clusters.find((item) => item.id === clusterId);
        if (!cluster) return s;

        const conflictsWithExistingLabel = s.clusters.some(
          (item) =>
            item.id !== clusterId &&
            item.projectId === cluster.projectId &&
            normalizeLabel(item.label) === normalizeLabel(cleanedLabel),
        );
        if (conflictsWithExistingLabel) return s;

        return {
          ...s,
          clusters: s.clusters.map((item) =>
            item.id === clusterId ? { ...item, label: cleanedLabel } : item,
          ),
        };
      });
    },
    [],
  );

  const deleteKnowledgeCluster = useCallback((clusterId: string) => {
    const updatedAt = Date.now();

    setState((s) => {
      const cluster = s.clusters.find((item) => item.id === clusterId);
      if (!cluster) return s;

      const clusters = reconcileKnowledgeLinks(
        s.clusters.filter((item) => item.id !== clusterId),
      );
      return {
        ...s,
        clusters,
        projects: updateProjectKnowledgeSourceCount(
          s.projects,
          clusters,
          cluster.projectId,
          updatedAt,
        ),
      };
    });
  }, []);

  const mergeKnowledgeClusters = useCallback(
    (targetClusterId: string, sourceClusterId: string) => {
      if (targetClusterId === sourceClusterId) return;
      const updatedAt = Date.now();

      setState((s) => {
        const target = s.clusters.find((item) => item.id === targetClusterId);
        const source = s.clusters.find((item) => item.id === sourceClusterId);
        if (!target || !source || target.projectId !== source.projectId)
          return s;

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
          s.clusters
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
          ...s,
          clusters,
          projects: updateProjectKnowledgeSourceCount(
            s.projects,
            clusters,
            target.projectId,
            updatedAt,
          ),
        };
      });
    },
    [],
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
        renameKnowledgeCluster,
        deleteKnowledgeCluster,
        mergeKnowledgeClusters,
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
    (a, b) => b.updatedAt - a.updatedAt,
  );
}
