import React, { createContext, useContext, useEffect, useState } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';

export type Project = {
  id: string;
  name: string;
  description: string;
  accent: string;
  sourceCount: number;
  updatedAt: number;
};

export type Message = {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  createdAt: number;
  status: 'sending' | 'sent' | 'error';
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
  label: string;
  category: string;
  strength: number;
  x: number;
  y: number;
  links: string[];
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
  addProject: (p: Omit<Project, 'id' | 'updatedAt'>) => void;
  updateProject: (id: string, p: Partial<Project>) => void;
  deleteProject: (id: string) => void;
  setActiveProject: (id: string | null) => void;
  addMessage: (convId: string | null, msg: Omit<Message, 'id' | 'createdAt'>) => string;
  updateMessage: (convId: string, msgId: string, updates: Partial<Message>) => void;
  setActiveConversation: (id: string | null) => void;
  clearConversation: (id: string) => void;
  createNewConversation: (projectId: string | null) => string;
};

const initialState: VenomState = {
  projects: [],
  conversations: [],
  clusters: [
    { id: '1', label: 'Core Intelligence', category: 'core', strength: 1.0, x: 50, y: 50, links: ['2', '3'] },
    { id: '2', label: 'Tactical Subsystem', category: 'tactical', strength: 0.8, x: 120, y: -30, links: ['1', '4'] },
    { id: '3', label: 'Memory Matrix', category: 'memory', strength: 0.9, x: -80, y: 60, links: ['1'] },
    { id: '4', label: 'External APIs', category: 'external', strength: 0.5, x: 200, y: 10, links: ['2'] },
    { id: '5', label: 'User Persona', category: 'memory', strength: 0.7, x: -40, y: -90, links: ['3', '1'] },
  ],
  activeProjectId: null,
  activeConversationId: null,
};

const VenomContext = createContext<VenomContextType | null>(null);

const STORAGE_KEY = '@venom_state_v1';

export function VenomProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<VenomState>(initialState);
  const [isReady, setIsReady] = useState(false);

  useEffect(() => {
    AsyncStorage.getItem(STORAGE_KEY).then((data) => {
      if (data) {
        try {
          const parsed = JSON.parse(data);
          setState(prev => ({ ...prev, ...parsed, clusters: initialState.clusters })); // Always keep clusters seeded for now
        } catch (e) {
          console.error('Failed to parse venom state', e);
        }
      } else {
        // Seed default project
        const defaultProject = {
          id: 'proj_default',
          name: 'Global Workspace',
          description: 'Uncategorized intelligence',
          accent: '#b4f536',
          sourceCount: 0,
          updatedAt: Date.now()
        };
        const defaultConv = {
          id: 'conv_default',
          title: 'New Session',
          projectId: 'proj_default',
          updatedAt: Date.now(),
          messages: []
        };
        setState(prev => ({
          ...prev,
          projects: [defaultProject],
          conversations: [defaultConv],
          activeProjectId: 'proj_default',
          activeConversationId: 'conv_default'
        }));
      }
      setIsReady(true);
    });
  }, []);

  useEffect(() => {
    if (isReady) {
      AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    }
  }, [state, isReady]);

  const generateId = (prefix: string) => `${prefix}_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

  const addProject = (p: Omit<Project, 'id' | 'updatedAt'>) => {
    const newProject = { ...p, id: generateId('proj'), updatedAt: Date.now() };
    setState(s => ({ ...s, projects: [...s.projects, newProject] }));
  };

  const updateProject = (id: string, updates: Partial<Project>) => {
    setState(s => ({
      ...s,
      projects: s.projects.map(p => p.id === id ? { ...p, ...updates, updatedAt: Date.now() } : p)
    }));
  };

  const deleteProject = (id: string) => {
    setState(s => ({
      ...s,
      projects: s.projects.filter(p => p.id !== id),
      activeProjectId: s.activeProjectId === id ? null : s.activeProjectId,
      conversations: s.conversations.filter(c => c.projectId !== id)
    }));
  };

  const setActiveProject = (id: string | null) => {
    setState(s => ({ ...s, activeProjectId: id }));
  };

  const createNewConversation = (projectId: string | null) => {
    const newConv: Conversation = {
      id: generateId('conv'),
      title: 'New Session',
      projectId,
      updatedAt: Date.now(),
      messages: []
    };
    setState(s => ({
      ...s,
      conversations: [...s.conversations, newConv],
      activeConversationId: newConv.id
    }));
    return newConv.id;
  };

  const setActiveConversation = (id: string | null) => {
    setState(s => ({ ...s, activeConversationId: id }));
  };

  const addMessage = (convId: string | null, msg: Omit<Message, 'id' | 'createdAt'>) => {
    let targetConvId = convId;
    let s = { ...state };
    
    if (!targetConvId) {
      targetConvId = createNewConversation(s.activeProjectId);
      // createNewConversation updates state later, we need to manipulate immediate state
      const newConv: Conversation = {
        id: targetConvId,
        title: 'New Session',
        projectId: s.activeProjectId,
        updatedAt: Date.now(),
        messages: []
      };
      s.conversations = [...s.conversations, newConv];
      s.activeConversationId = targetConvId;
    }

    const newMessage: Message = { ...msg, id: generateId('msg'), createdAt: Date.now() };

    setState(prev => {
      const targetConvIndex = prev.conversations.findIndex(c => c.id === targetConvId);
      if (targetConvIndex === -1) return prev;

      const updatedConvs = [...prev.conversations];
      updatedConvs[targetConvIndex] = {
        ...updatedConvs[targetConvIndex],
        updatedAt: Date.now(),
        messages: [...updatedConvs[targetConvIndex].messages, newMessage]
      };

      // Generate a title if it's the first message
      if (updatedConvs[targetConvIndex].messages.length === 1 && newMessage.role === 'user') {
        updatedConvs[targetConvIndex].title = newMessage.content.slice(0, 30) + '...';
      }

      return { ...prev, conversations: updatedConvs, activeConversationId: targetConvId };
    });

    return targetConvId;
  };

  const updateMessage = (convId: string, msgId: string, updates: Partial<Message>) => {
    setState(s => {
      const convIndex = s.conversations.findIndex(c => c.id === convId);
      if (convIndex === -1) return s;

      const updatedConvs = [...s.conversations];
      const conv = updatedConvs[convIndex];
      const msgIndex = conv.messages.findIndex(m => m.id === msgId);
      if (msgIndex === -1) return s;

      const updatedMessages = [...conv.messages];
      updatedMessages[msgIndex] = { ...updatedMessages[msgIndex], ...updates };

      updatedConvs[convIndex] = { ...conv, messages: updatedMessages };

      return { ...s, conversations: updatedConvs };
    });
  };

  const clearConversation = (id: string) => {
    setState(s => ({
      ...s,
      conversations: s.conversations.map(c => c.id === id ? { ...c, messages: [] } : c)
    }));
  };

  return (
    <VenomContext.Provider value={{
      state,
      isReady,
      addProject,
      updateProject,
      deleteProject,
      setActiveProject,
      addMessage,
      updateMessage,
      setActiveConversation,
      clearConversation,
      createNewConversation
    }}>
      {children}
    </VenomContext.Provider>
  );
}

export function useVenom() {
  const context = useContext(VenomContext);
  if (!context) throw new Error('useVenom must be used within VenomProvider');
  return context;
}
