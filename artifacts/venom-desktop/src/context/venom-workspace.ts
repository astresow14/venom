/**
 * Barrel re-export for the VenomWorkspace context.
 * App.tsx imports from this path.
 */
export {
  IS_UI_TEST,
  VenomWorkspaceProvider,
  useVenomWorkspace,
} from './VenomWorkspaceContext';

export type {
  VenomWorkspaceContextType,
  Conversation,
  KnowledgeCluster,
  KnowledgeInsight,
  KnowledgeSource,
  Message,
  Project,
  SyncStatus,
  Task,
  TaskStatus,
  WorkspaceState,
} from './VenomWorkspaceContext';
