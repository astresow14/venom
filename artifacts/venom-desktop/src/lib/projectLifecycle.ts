import type { VenomProject } from '@workspace/api-client-react';

import { createDefaultBoardStages } from './boardState.ts';

/**
 * Picks the workspace a project deletion should land on: the project the
 * switcher lists first (most recently updated). Returns null when no projects
 * remain. Mirrors artifacts/venom/context/projectLifecycle.ts so desktop and
 * phone land in the same place after the same deletion.
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
 * tombstone during cross-device sync. Field-for-field the same workspace the
 * mobile client seeds (artifacts/venom/context/projectLifecycle.ts).
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

/**
 * Monochrome accents rotated across newly created projects. Mirrors the
 * phone's create flow (artifacts/venom/app/projects.tsx), which cycles a
 * small set of neutral theme swatches by project count so adjacent projects
 * stay visually distinct without introducing color. The values come from the
 * neutral family both apps already persist (ink, muted ink, the
 * fallback-workspace grey, and the light border tone).
 */
export const PROJECT_ACCENT_PALETTE = [
  '#121210',
  '#62625e',
  '#73736f',
  '#d7d7d0',
] as const;

/**
 * Accent for the next project created when `existingProjectCount` projects
 * already exist. Malformed counts fall back to the first swatch instead of
 * breaking project creation.
 */
export function nextProjectAccent(existingProjectCount: number): string {
  if (!Number.isFinite(existingProjectCount) || existingProjectCount <= 0) {
    return PROJECT_ACCENT_PALETTE[0];
  }
  return PROJECT_ACCENT_PALETTE[
    Math.floor(existingProjectCount) % PROJECT_ACCENT_PALETTE.length
  ];
}
