import type {
  VenomKanbanField,
  VenomKanbanFieldType,
  VenomProject,
  VenomTask,
  VenomTaskStatus,
} from '@workspace/api-client-react';
import {
  createDefaultBoardStages,
  normalizeBoardStages,
} from '@workspace/venom-workspace-merge';

// Stage rules are shared with the phone app via @workspace/venom-workspace-merge
// so the two normalizers cannot drift: a drifted desktop copy used to silently
// drop duplicate-named columns the phone still showed, and the board
// flip-flopped through sync forever. Re-exported (from the imported bindings,
// which the code below also calls) for existing call sites and the cross-app
// identity tests in workspaceMergeRules.test.mjs.
export { createDefaultBoardStages, normalizeBoardStages };

export type BoardValue = string | number | boolean;

const FIELD_TYPES = new Set<VenomKanbanFieldType>([
  'text',
  'number',
  'date',
  'single_select',
  'checkbox',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function finiteTimestamp(value: unknown, fallback: number) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : fallback;
}

function boundedText(value: unknown, maxLength: number, fallback = '') {
  return typeof value === 'string'
    ? value.trim().slice(0, maxLength)
    : fallback;
}

export function isValidBoardDate(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

function normalizeFields(value: unknown, projectUpdatedAt: number) {
  const seenIds = new Set<string>();
  const seenNames = new Set<string>();
  return (Array.isArray(value) ? value : [])
    .flatMap((candidate, index): VenomKanbanField[] => {
      if (!isRecord(candidate)) return [];
      const id = boundedText(candidate.id, 120);
      const name = boundedText(candidate.name, 80);
      const normalizedName = name.toLocaleLowerCase();
      const type = candidate.type as VenomKanbanFieldType;
      if (
        !id ||
        !name ||
        seenIds.has(id) ||
        seenNames.has(normalizedName) ||
        !FIELD_TYPES.has(type)
      ) {
        return [];
      }
      const optionSet = new Set<string>();
      const options = (
        Array.isArray(candidate.options) ? candidate.options : []
      ).flatMap((option): string[] => {
        const normalized = boundedText(option, 80);
        const key = normalized.toLocaleLowerCase();
        if (!normalized || optionSet.has(key)) return [];
        optionSet.add(key);
        return [normalized];
      });
      if (type === 'single_select' && options.length === 0) return [];
      seenIds.add(id);
      seenNames.add(normalizedName);
      return [
        {
          id,
          name,
          type,
          options: type === 'single_select' ? options.slice(0, 30) : [],
          position: finiteTimestamp(candidate.position, index),
          showOnCard: candidate.showOnCard === true,
          updatedAt: finiteTimestamp(candidate.updatedAt, projectUpdatedAt),
        },
      ];
    })
    .sort(
      (left, right) =>
        left.position - right.position || left.id.localeCompare(right.id),
    )
    .map((field, position) => ({ ...field, position }));
}

export function normalizeBoardValue(
  field: VenomKanbanField,
  value: unknown,
): BoardValue | undefined {
  if (field.type === 'checkbox') {
    return typeof value === 'boolean' ? value : undefined;
  }
  if (field.type === 'number') {
    return typeof value === 'number' &&
      Number.isFinite(value) &&
      value >= -1_000_000_000 &&
      value <= 1_000_000_000
      ? value
      : undefined;
  }
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  if (field.type === 'date') {
    return isValidBoardDate(trimmed) ? trimmed : undefined;
  }
  if (field.type === 'single_select') {
    return field.options.includes(trimmed) ? trimmed : undefined;
  }
  return trimmed.slice(0, 1000);
}

export function normalizeProjectBoard(project: VenomProject): VenomProject {
  const projectUpdatedAt = finiteTimestamp(project.updatedAt, Date.now());
  const boardStages = normalizeBoardStages(
    project.id,
    (project as unknown as Record<string, unknown>).boardStages,
    projectUpdatedAt,
  );
  const fieldDefinitions = normalizeFields(
    (project as unknown as Record<string, unknown>).fieldDefinitions,
    projectUpdatedAt,
  );
  const stageIds = new Set(boardStages.map((stage) => stage.id));
  const fieldsById = new Map(
    fieldDefinitions.map((field) => [field.id, field]),
  );
  const defaultStages = createDefaultBoardStages(project.id, projectUpdatedAt);
  const legacyStageByStatus = {
    todo:
      boardStages.find((stage) => stage.name.toLocaleLowerCase() === 'to do')
        ?.id ?? boardStages[0].id,
    in_progress:
      boardStages.find((stage) => stage.name.toLocaleLowerCase() === 'active')
        ?.id ??
      boardStages.find((stage) => !stage.isDone)?.id ??
      boardStages[0].id,
    done:
      boardStages.find((stage) => stage.isDone)?.id ??
      boardStages[boardStages.length - 1].id,
  };
  const nextPositionByStage = new Map<string, number>();
  const seenTasks = new Set<string>();
  const rawTasks = Array.isArray(project.tasks) ? project.tasks : [];
  const tasks = rawTasks.flatMap((candidate): VenomTask[] => {
    if (!isRecord(candidate)) return [];
    const id = boundedText(candidate.id, 120);
    const title = boundedText(candidate.title, 280);
    if (!id || !title || seenTasks.has(id)) return [];
    seenTasks.add(id);
    const legacyStatus =
      candidate.status === 'in_progress' || candidate.status === 'done'
        ? candidate.status
        : 'todo';
    const requestedStageId = boundedText(candidate.stageId, 120);
    const stageId = stageIds.has(requestedStageId)
      ? requestedStageId
      : legacyStageByStatus[legacyStatus] ?? defaultStages[0].id;
    const fallbackPosition = nextPositionByStage.get(stageId) ?? 0;
    const position = finiteTimestamp(candidate.position, fallbackPosition);
    nextPositionByStage.set(stageId, Math.max(fallbackPosition, position) + 1);
    const createdAt = finiteTimestamp(candidate.createdAt, projectUpdatedAt);
    const rawValues = isRecord(candidate.values) ? candidate.values : {};
    const values: Record<string, BoardValue> = {};
    for (const [fieldId, rawValue] of Object.entries(rawValues)) {
      const field = fieldsById.get(fieldId);
      if (!field) continue;
      const normalizedValue = normalizeBoardValue(field, rawValue);
      if (normalizedValue !== undefined) values[fieldId] = normalizedValue;
    }
    return [
      {
        id,
        title,
        stageId,
        position,
        createdAt,
        updatedAt: finiteTimestamp(candidate.updatedAt, createdAt),
        values,
      },
    ];
  });

  const stagePosition = new Map(
    boardStages.map((stage) => [stage.id, stage.position]),
  );
  const nextCompactPosition = new Map<string, number>();
  const orderedTasks = tasks.sort(
    (left, right) =>
      (stagePosition.get(left.stageId) ?? 0) -
        (stagePosition.get(right.stageId) ?? 0) ||
      left.position - right.position ||
      left.id.localeCompare(right.id),
  );
  return {
    ...project,
    updatedAt: projectUpdatedAt,
    boardStages,
    fieldDefinitions,
    tasks: orderedTasks.map((task) => {
      const position = nextCompactPosition.get(task.stageId) ?? 0;
      nextCompactPosition.set(task.stageId, position + 1);
      return { ...task, position };
    }),
  };
}

export function compactBoardPositions(project: VenomProject): VenomProject {
  const boardStages = [...project.boardStages]
    .sort(
      (left, right) =>
        left.position - right.position || left.id.localeCompare(right.id),
    )
    .map((stage, position) => ({ ...stage, position }));
  const fieldDefinitions = [...project.fieldDefinitions]
    .sort(
      (left, right) =>
        left.position - right.position || left.id.localeCompare(right.id),
    )
    .map((field, position) => ({ ...field, position }));
  const orderedTasks: VenomTask[] = [];
  for (const stage of boardStages) {
    orderedTasks.push(
      ...project.tasks
        .filter((task) => task.stageId === stage.id)
        .sort(
          (left, right) =>
            left.position - right.position || left.id.localeCompare(right.id),
        )
        .map((task, position) => ({ ...task, position })),
    );
  }
  return { ...project, boardStages, fieldDefinitions, tasks: orderedTasks };
}

type BoardDeletionTimes = {
  tasks: Map<string, number>;
  stages: Map<string, number>;
  fields: Map<string, number>;
};

function mergeVersionedRecords<T extends { id: string; updatedAt: number }>(
  cloudItems: T[],
  deviceItems: T[],
) {
  const merged = new Map(cloudItems.map((item) => [item.id, item]));
  for (const item of deviceItems) {
    const existing = merged.get(item.id);
    if (!existing || item.updatedAt >= existing.updatedAt) {
      merged.set(item.id, item);
    }
  }
  return [...merged.values()];
}

export function mergeProjectBoardSnapshots(
  cloudProject: VenomProject,
  deviceProject: VenomProject,
  deletionTimes: BoardDeletionTimes,
): VenomProject {
  const cloud = normalizeProjectBoard(cloudProject);
  const device = normalizeProjectBoard(deviceProject);
  const newest =
    device.updatedAt >= cloud.updatedAt ? device : cloud;
  const tasks = mergeVersionedRecords(cloud.tasks, device.tasks).filter(
    (task) => (deletionTimes.tasks.get(task.id) ?? -1) < task.updatedAt,
  );
  const boardStages = mergeVersionedRecords(
    cloud.boardStages,
    device.boardStages,
  ).filter(
    (stage) => (deletionTimes.stages.get(stage.id) ?? -1) < stage.updatedAt,
  );
  const fieldDefinitions = mergeVersionedRecords(
    cloud.fieldDefinitions,
    device.fieldDefinitions,
  ).filter(
    (field) => (deletionTimes.fields.get(field.id) ?? -1) < field.updatedAt,
  );
  const safeStages =
    boardStages.length > 0
      ? boardStages
      : createDefaultBoardStages(newest.id, newest.updatedAt);
  return compactBoardPositions(
    normalizeProjectBoard({
      ...newest,
      tasks,
      boardStages: safeStages,
      fieldDefinitions,
    }),
  );
}

export function taskStatusForProject(
  project: VenomProject,
  task: VenomTask,
): VenomTaskStatus {
  const stages = [...project.boardStages].sort(
    (left, right) =>
      left.position - right.position || left.id.localeCompare(right.id),
  );
  const stage = stages.find((candidate) => candidate.id === task.stageId);
  if (stage?.isDone) return 'done';
  const openStages = stages.filter((candidate) => !candidate.isDone);
  return stage?.id === openStages[0]?.id ? 'todo' : 'in_progress';
}

export function stageIdForTaskStatus(
  project: VenomProject,
  status: VenomTaskStatus,
): string | null {
  const stages = [...project.boardStages].sort(
    (left, right) =>
      left.position - right.position || left.id.localeCompare(right.id),
  );
  const openStages = stages.filter((stage) => !stage.isDone);
  if (status === 'done') {
    return stages.find((stage) => stage.isDone)?.id ?? null;
  }
  if (status === 'in_progress') {
    return openStages[1]?.id ?? null;
  }
  return openStages[0]?.id ?? null;
}

export function availableTaskStatuses(
  project: VenomProject,
): VenomTaskStatus[] {
  const openStageCount = project.boardStages.filter((stage) => !stage.isDone).length;
  return [
    ...(openStageCount > 0 ? (['todo'] as const) : []),
    ...(openStageCount > 1 ? (['in_progress'] as const) : []),
    ...(project.boardStages.some((stage) => stage.isDone)
      ? (['done'] as const)
      : []),
  ];
}