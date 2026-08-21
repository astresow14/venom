/**
 * community-agenda.ts
 *
 * Private briefing agenda helpers.
 * Extracts tasks from the viewer's venom_workspaces row using the real
 * Venom workspace schema:
 *   Project.boardStages: [{id, name, position, isDone, updatedAt}]
 *   Project.fieldDefinitions: [{id, name, type, options, position, ...}]
 *   Project.tasks: [{id, title, stageId, values, position, createdAt, updatedAt}]
 *
 * Never persists or logs agenda text or private workspace IDs.
 */

import { createHash } from "node:crypto";

export const MAX_AGENDA_ITEMS = 20;

export function resolveCalendarDay(
  timezone: string,
  explicitDate?: string,
): string {
  if (explicitDate) return explicitDate;
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const year = parts.find((part) => part.type === "year")?.value ?? "";
  const month = parts.find((part) => part.type === "month")?.value ?? "";
  const day = parts.find((part) => part.type === "day")?.value ?? "";
  return `${year}-${month}-${day}`;
}

export type PersonalAgendaItem = {
  id: string; // opaque deterministic hash of user+project+task — never raw IDs
  source: "todo";
  privacy: "personal";
  title: string;
  detail: null;
  startsAt: null;
  dueDate: string | null;
  state: "open" | "in_progress";
  projectName: string | null;
};

// ---------------------------------------------------------------------------
// Internal defensive types matching the real Venom schema
// ---------------------------------------------------------------------------

type BoardStage = {
  id: string;
  name: string;
  isDone: boolean;
  position?: number;
};

type FieldDefinition = {
  id: string;
  name: string;
  type: string; // "text"|"number"|"date"|"single_select"|"checkbox"
  options?: string[];
  position?: number;
};

type Task = {
  id: string;
  title: string;
  stageId: string;
  values?: Record<string, unknown>;
  // Legacy field — may be present in migrated snapshots
  status?: string;
  // Direct dueDate — may be present in old snapshots
  dueDate?: unknown;
  position?: number;
};

type Project = {
  id?: unknown;
  name?: unknown;
  boardStages?: unknown;
  fieldDefinitions?: unknown;
  tasks?: unknown;
  // Old shape — kept for backward compatibility
  stage?: unknown;
  isDone?: unknown;
};

// ---------------------------------------------------------------------------
// Guards
// ---------------------------------------------------------------------------

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function str(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

function parseBoardStage(raw: unknown): BoardStage | null {
  if (!isRecord(raw)) return null;
  const id = str(raw["id"]);
  const name = str(raw["name"]);
  if (!id || !name) return null;
  const isDone = typeof raw["isDone"] === "boolean" ? raw["isDone"] : false;
  return { id, name, isDone };
}

function parseFieldDefinition(raw: unknown): FieldDefinition | null {
  if (!isRecord(raw)) return null;
  const id = str(raw["id"]);
  const name = str(raw["name"]);
  const type = str(raw["type"]);
  if (!id || !name || !type) return null;
  return { id, name, type };
}

function parseTask(raw: unknown): Task | null {
  if (!isRecord(raw)) return null;
  const id = str(raw["id"]);
  const title = str(raw["title"]);
  const stageId = str(raw["stageId"]);
  if (!id || !title) return null;
  // stageId may be absent in legacy data
  return {
    id,
    title,
    stageId: stageId ?? "",
    values: isRecord(raw["values"]) ? (raw["values"] as Record<string, unknown>) : undefined,
    status: str(raw["status"]) ?? undefined,
    dueDate: raw["dueDate"],
  };
}

// ---------------------------------------------------------------------------
// Stage analysis
// ---------------------------------------------------------------------------

/**
 * Determine if a project has any boardStages and if a given task's stage
 * is done. Handles both the canonical boardStages array and legacy stage/isDone
 * sentinel fields for backward compat.
 */
function buildStageMap(project: Project): {
  stageById: Map<string, BoardStage>;
  hasCanonicalStages: boolean;
} {
  const stageById = new Map<string, BoardStage>();
  let hasCanonicalStages = false;

  if (Array.isArray(project.boardStages)) {
    for (const raw of project.boardStages) {
      const stage = parseBoardStage(raw);
      if (stage) {
        stageById.set(stage.id, stage);
        hasCanonicalStages = true;
      }
    }
  }

  return { stageById, hasCanonicalStages };
}

/** True if the project itself is entirely done (all stages are isDone, or legacy sentinel). */
function isProjectDone(project: Project, stageById: Map<string, BoardStage>, hasCanonicalStages: boolean): boolean {
  if (hasCanonicalStages) {
    // Project is "done" only if ALL stages are isDone (i.e. no active column)
    // In practice: skip projects where every stage is done
    const stages = [...stageById.values()];
    return stages.length > 0 && stages.every((s) => s.isDone);
  }

  // Legacy fallback: stage string matches isDone sentinel
  const stage = str(project.stage);
  const isDone = str(project.isDone);
  if (stage !== null && isDone !== null && stage === isDone) return true;
  if (stage && ["done", "complete", "completed", "archived"].includes(stage.toLowerCase())) return true;
  return false;
}

/** Determine task state from its stageId within the project's board. */
function getTaskState(
  task: Task,
  stageById: Map<string, BoardStage>,
  hasCanonicalStages: boolean,
): "open" | "in_progress" | null {
  if (hasCanonicalStages && task.stageId) {
    const stage = stageById.get(task.stageId);
    if (!stage) return null; // unknown stage — skip
    if (stage.isDone) return null; // task is complete
    // Derive in_progress from stage name patterns
    const stageName = stage.name.toLowerCase().trim();
    if (
      stageName === "in progress" ||
      stageName === "in_progress" ||
      stageName === "doing" ||
      stageName === "active" ||
      stageName === "wip" ||
      stageName === "in review" ||
      stageName === "review"
    ) {
      return "in_progress";
    }
    return "open";
  }

  // Legacy: use direct status field
  const status = str(task.status);
  if (!status) return "open";
  const lower = status.toLowerCase();
  if (lower === "in_progress" || lower === "in progress" || lower === "doing" || lower === "active") {
    return "in_progress";
  }
  if (lower === "done" || lower === "complete" || lower === "completed") return null;
  return "open";
}

// ---------------------------------------------------------------------------
// Date field extraction
// ---------------------------------------------------------------------------

function findDateFieldId(fieldDefs: FieldDefinition[]): string | null {
  for (const fd of fieldDefs) {
    if (fd.type === "date") return fd.id;
    const name = fd.name.toLowerCase().trim();
    if (["due", "due date", "duedate", "deadline", "due_date"].includes(name)) {
      return fd.id;
    }
  }
  return null;
}

function getTaskDueDate(task: Task, dueDateFieldId: string | null): string | null {
  // Canonical: task.values[dateFieldId]
  if (dueDateFieldId && task.values) {
    const val = str(task.values[dueDateFieldId]);
    if (val && /^\d{4}-\d{2}-\d{2}$/.test(val)) return val;
  }

  // Legacy direct dueDate field
  const direct = str(task.dueDate);
  if (direct && /^\d{4}-\d{2}-\d{2}$/.test(direct)) return direct;

  return null;
}

// ---------------------------------------------------------------------------
// Opaque ID
// ---------------------------------------------------------------------------

function makeOpaqueId(userId: string, projectId: string, taskId: string): string {
  return createHash("sha256")
    .update(`agenda|${userId}|${projectId}|${taskId}`)
    .digest("hex")
    .slice(0, 40);
}

// ---------------------------------------------------------------------------
// Main extractor
// ---------------------------------------------------------------------------

/**
 * Extract personal agenda items from workspace state JSON.
 * Defensive parsing; any unexpected shape returns empty array.
 * Does NOT log any agenda text or workspace IDs.
 */
export function extractAgendaItems(
  userId: string,
  workspaceState: unknown,
  calendarDay: string,
): PersonalAgendaItem[] {
  if (!isRecord(workspaceState)) return [];
  if (!Array.isArray((workspaceState as { projects?: unknown }).projects)) return [];

  const projects = (workspaceState as { projects: unknown[] }).projects;
  const dueToday: PersonalAgendaItem[] = [];
  const inProgress: PersonalAgendaItem[] = [];
  const open: PersonalAgendaItem[] = [];

  for (const rawProject of projects) {
    if (!isRecord(rawProject)) continue;
    const project = rawProject as Project;

    const { stageById, hasCanonicalStages } = buildStageMap(project);

    if (isProjectDone(project, stageById, hasCanonicalStages)) continue;

    const projectId = str(project.id) ?? "unknown";
    const projectName = str(project.name);

    // Parse field definitions for date field lookup
    const fieldDefs: FieldDefinition[] = [];
    if (Array.isArray(project.fieldDefinitions)) {
      for (const raw of project.fieldDefinitions) {
        const fd = parseFieldDefinition(raw);
        if (fd) fieldDefs.push(fd);
      }
    }
    const dueDateFieldId = findDateFieldId(fieldDefs);

    if (!Array.isArray(project.tasks)) continue;

    for (const rawTask of project.tasks) {
      const task = parseTask(rawTask);
      if (!task) continue;

      const taskState = getTaskState(task, stageById, hasCanonicalStages);
      if (taskState === null) continue; // done or unknown stage

      const dueDate = getTaskDueDate(task, dueDateFieldId);

      const item: PersonalAgendaItem = {
        id: makeOpaqueId(userId, projectId, task.id),
        source: "todo",
        privacy: "personal",
        title: task.title.slice(0, 300),
        detail: null,
        startsAt: null,
        dueDate: dueDate ?? null,
        state: taskState,
        projectName: projectName ? projectName.slice(0, 120) : null,
      };

      if (dueDate === calendarDay) {
        dueToday.push(item);
      } else if (taskState === "in_progress") {
        inProgress.push(item);
      } else {
        open.push(item);
      }
    }
  }

  const results = [...dueToday, ...inProgress, ...open];
  return results.slice(0, MAX_AGENDA_ITEMS);
}

// ---------------------------------------------------------------------------
// Calendar provider stub
// ---------------------------------------------------------------------------

export type CalendarStatus = "connected" | "not_connected" | "unavailable";

export type CalendarProvider = {
  getEvents(userId: string, date: string): Promise<unknown[]>;
  status: CalendarStatus;
};

// No calendar connector available; always returns not_connected
export const nullCalendarProvider: CalendarProvider = {
  async getEvents(_userId: string, _date: string): Promise<unknown[]> {
    return [];
  },
  status: "not_connected",
};

