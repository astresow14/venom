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
} from './VenomWorkspaceContext';

export type {
  Conversation,
  KnowledgeCluster,
  KnowledgeInsight,
  KnowledgeSource,
  Project,
  SyncStatus,
  WorkspaceState,
} from '@/lib/workspaceState';
