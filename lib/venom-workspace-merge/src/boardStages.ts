/**
 * Board-stage normalization shared by the phone and desktop apps.
 *
 * Both apps run this on every workspace load and inside every board merge, so
 * how duplicate-named stages are handled is a sync rule, not a UI nicety. The
 * apps used to disagree: desktop silently dropped a stage whose name another
 * stage already used (deleting a column the phone still showed), while the
 * phone kept exact duplicates — which the API server rejects on save
 * (artifacts/api-server/src/routes/venom-board-validation.ts, "Stage names
 * must be unique"). A workspace syncing through both devices flip-flopped
 * between the two shapes forever.
 *
 * The agreed rule is: KEEP every stage, RENAME collisions.
 * - Never drop: a dropped stage deletes a user's column and strands its cards.
 * - Never keep exact duplicates: the server refuses to save them.
 * - Rename deterministically ("Active" -> "Active (2)") in the canonical
 *   board order (position, then id), so every device computes identical names
 *   from the same stage set — and a renamed board even round-trips safely
 *   through a stale desktop build that still dedupes by name.
 *
 * The rename is a repair, not an edit: it never touches updatedAt, so a
 * repaired copy can never beat a genuine user rename in a newest-wins merge.
 */
import type { VenomKanbanStage } from '@workspace/api-client-react';

const STAGE_ID_MAX_LENGTH = 120;
const STAGE_NAME_MAX_LENGTH = 80;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function finiteTimestamp(value: unknown, fallback: number) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : fallback;
}

function boundedText(value: unknown, maxLength: number) {
  return typeof value === 'string' ? value.trim().slice(0, maxLength) : '';
}

function stableProjectSuffix(projectId: string) {
  let hash = 2166136261;
  for (const character of projectId) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

export function createDefaultBoardStages(
  projectId: string,
  updatedAt: number,
): VenomKanbanStage[] {
  const suffix = stableProjectSuffix(projectId);
  return [
    {
      id: `stage_todo_${suffix}`,
      name: 'To Do',
      position: 0,
      isDone: false,
      updatedAt,
    },
    {
      id: `stage_active_${suffix}`,
      name: 'Active',
      position: 1,
      isDone: false,
      updatedAt,
    },
    {
      id: `stage_done_${suffix}`,
      name: 'Done',
      position: 2,
      isDone: true,
      updatedAt,
    },
  ];
}

/**
 * Renames stages whose trimmed name collides case-insensitively with an
 * earlier stage in the given (already canonical) order. The first holder
 * keeps its name; later ones get the smallest free " (n)" suffix, with the
 * base truncated so the result stays within the name bound.
 */
function renameDuplicateStageNames(
  stages: VenomKanbanStage[],
): VenomKanbanStage[] {
  const taken = new Set<string>();
  return stages.map((stage) => {
    const key = stage.name.toLocaleLowerCase();
    if (!taken.has(key)) {
      taken.add(key);
      return stage;
    }
    // Terminates: candidates for distinct counters are distinct strings, and
    // `taken` is finite, so a free suffix exists within stages.length tries.
    for (let counter = 2; ; counter += 1) {
      const suffix = ` (${counter})`;
      const candidate =
        stage.name.slice(0, STAGE_NAME_MAX_LENGTH - suffix.length).trimEnd() +
        suffix;
      const candidateKey = candidate.toLocaleLowerCase();
      if (!taken.has(candidateKey)) {
        taken.add(candidateKey);
        return { ...stage, name: candidate };
      }
    }
  });
}

/**
 * The one normalization both apps run over a project's raw stage list:
 * validate and bound each record, drop id duplicates (the same entity twice),
 * fall back to the default board when nothing survives, order canonically,
 * guarantee a done stage, and resolve name collisions by renaming — never by
 * dropping a column.
 */
export function normalizeBoardStages(
  projectId: string,
  value: unknown,
  projectUpdatedAt: number,
): VenomKanbanStage[] {
  const seenIds = new Set<string>();
  const stages = Array.isArray(value)
    ? value.flatMap((candidate, index): VenomKanbanStage[] => {
        if (!isRecord(candidate)) return [];
        const id = boundedText(candidate.id, STAGE_ID_MAX_LENGTH);
        const name = boundedText(candidate.name, STAGE_NAME_MAX_LENGTH);
        if (!id || !name || seenIds.has(id)) return [];
        seenIds.add(id);
        return [
          {
            id,
            name,
            position: finiteTimestamp(candidate.position, index),
            isDone: candidate.isDone === true,
            updatedAt: finiteTimestamp(candidate.updatedAt, projectUpdatedAt),
          },
        ];
      })
    : [];

  const available =
    stages.length > 0
      ? stages
      : createDefaultBoardStages(projectId, projectUpdatedAt);
  const ordered = available
    .sort(
      (left, right) =>
        left.position - right.position || left.id.localeCompare(right.id),
    )
    .map((stage, position) => ({ ...stage, position }));
  if (!ordered.some((stage) => stage.isDone)) {
    ordered[ordered.length - 1] = {
      ...ordered[ordered.length - 1],
      isDone: true,
      updatedAt: Math.max(
        ordered[ordered.length - 1].updatedAt,
        projectUpdatedAt,
      ),
    };
  }
  return renameDuplicateStageNames(ordered);
}
