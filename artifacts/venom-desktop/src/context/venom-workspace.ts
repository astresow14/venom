/**
 * Barrel re-export for the VenomWorkspace context.
 * App.tsx imports from this path.
 */
export {
  UI_TEST_USER_ID,
  VenomWorkspaceProvider,
  useVenomWorkspace,
} from './VenomWorkspaceContext';

// Lives in its own leaf module so the router can read the flag without
// pulling the workspace state machine into the entry chunk.
export { IS_UI_TEST } from '@/lib/ui-test';

export type {
  VenomWorkspaceContextType,
} from './VenomWorkspaceContext';

export type {
  Conversation,
  KnowledgeCluster,
  KnowledgeInsight,
  KnowledgeSource,
  ModelPreferences,
  Project,
  SyncStatus,
  VenomModelId,
  WorkspaceState,
} from '@/lib/workspaceState';
export {
  ALL_MODEL_IDS,
  createDefaultModelPreferences,
  normalizeModelPreferences,
} from '@/lib/workspaceState';
