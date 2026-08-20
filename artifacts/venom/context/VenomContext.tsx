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
  type KnowledgeInsight,
  type Message,
  type Project,
  type Task,
  type TaskStatus,
  type VenomState,
} from "./knowledgeState";

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
          setState((prev) => ({
            ...prev,
            ...hydratedState,
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
