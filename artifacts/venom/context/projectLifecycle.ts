import type { VenomProject } from '@workspace/api-client-react';

import { createDefaultBoardStages } from './boardState.ts';

/**
 * Picks the workspace a project deletion should land on: the project the
 * projects screen lists first (most recently updated). Returns null when no
 * projects remain.
 */
export function mostRecentlyUpdatedProjectId(
  projects: readonly VenomProject[],
): string | null {
  let next: VenomProject | null = null;
  for (const project of projects) {
    if (!next || project.updatedAt > next.updatedAt) {
      next = project;
    }
  }
  return next?.id ?? null;
}

/**
 * Replacement workspace seeded when the last project is deleted, so the app
 * always keeps a usable chat surface instead of an empty screen. The caller
 * supplies a fresh id: reusing the deleted project's id would fight its
 * tombstone during cross-device sync.
 */
export function createFallbackWorkspaceProject(
  id: string,
  createdAt: number,
): VenomProject {
  return {
    id,
    name: 'General',
    description: 'Uncategorized intelligence',
    accent: '#73736f',
    sourceCount: 0,
    updatedAt: createdAt,
    boardStages: createDefaultBoardStages(id, createdAt),
    fieldDefinitions: [],
    tasks: [],
  };
}
