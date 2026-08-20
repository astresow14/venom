type BoardValidationIssue = {
  path: (string | number)[];
  message: string;
};

type BoardField = {
  id: string;
  name: string;
  type: "text" | "number" | "date" | "single_select" | "checkbox";
  options: string[];
  position: number;
};

type BoardProject = {
  boardStages: Array<{
    id: string;
    name: string;
    position: number;
    isDone: boolean;
  }>;
  fieldDefinitions: BoardField[];
  tasks: Array<{
    id: string;
    stageId: string;
    position: number;
    values: Record<string, string | number | boolean>;
  }>;
};

function hasDuplicate<T>(values: T[]) {
  return new Set(values).size !== values.length;
}

function isIsoDate(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

export function validateVenomBoardState(state: {
  projects: BoardProject[];
}): BoardValidationIssue[] {
  const issues: BoardValidationIssue[] = [];

  state.projects.forEach((project, projectIndex) => {
    const projectPath = ["state", "projects", projectIndex];
    const stageIds = project.boardStages.map((stage) => stage.id);
    const fieldIds = project.fieldDefinitions.map((field) => field.id);
    if (hasDuplicate(stageIds)) {
      issues.push({
        path: [...projectPath, "boardStages"],
        message: "Stage IDs must be unique",
      });
    }
    if (
      hasDuplicate(
        project.boardStages.map((stage) =>
          stage.name.trim().toLocaleLowerCase(),
        ),
      )
    ) {
      issues.push({
        path: [...projectPath, "boardStages"],
        message: "Stage names must be unique",
      });
    }
    if (hasDuplicate(project.boardStages.map((stage) => stage.position))) {
      issues.push({
        path: [...projectPath, "boardStages"],
        message: "Stage positions must be unique",
      });
    }
    if (!project.boardStages.some((stage) => stage.isDone)) {
      issues.push({
        path: [...projectPath, "boardStages"],
        message: "At least one stage must mark cards done",
      });
    }
    if (hasDuplicate(fieldIds)) {
      issues.push({
        path: [...projectPath, "fieldDefinitions"],
        message: "Field IDs must be unique",
      });
    }
    if (
      hasDuplicate(
        project.fieldDefinitions.map((field) =>
          field.name.trim().toLocaleLowerCase(),
        ),
      ) ||
      hasDuplicate(project.fieldDefinitions.map((field) => field.position))
    ) {
      issues.push({
        path: [...projectPath, "fieldDefinitions"],
        message: "Field definitions must be uniquely ordered",
      });
    }

    const fieldById = new Map(
      project.fieldDefinitions.map((field) => [field.id, field]),
    );
    const stageIdSet = new Set(stageIds);
    const occupiedPositions = new Set<string>();
    project.fieldDefinitions.forEach((field, fieldIndex) => {
      if (field.type === "single_select" && field.options.length === 0) {
        issues.push({
          path: [
            ...projectPath,
            "fieldDefinitions",
            fieldIndex,
            "options",
          ],
          message: "Single-select fields need at least one option",
        });
      }
      if (field.type !== "single_select" && field.options.length > 0) {
        issues.push({
          path: [
            ...projectPath,
            "fieldDefinitions",
            fieldIndex,
            "options",
          ],
          message: "Only single-select fields may define options",
        });
      }
      if (
        hasDuplicate(
          field.options.map((option) => option.trim().toLocaleLowerCase()),
        )
      ) {
        issues.push({
          path: [
            ...projectPath,
            "fieldDefinitions",
            fieldIndex,
            "options",
          ],
          message: "Field options must be unique",
        });
      }
    });

    project.tasks.forEach((task, taskIndex) => {
      const taskPath = [...projectPath, "tasks", taskIndex];
      if (!stageIdSet.has(task.stageId)) {
        issues.push({
          path: [...taskPath, "stageId"],
          message: "Task stage must exist on its project board",
        });
      }
      const positionKey = `${task.stageId}:${task.position}`;
      if (occupiedPositions.has(positionKey)) {
        issues.push({
          path: [...taskPath, "position"],
          message: "Task positions must be unique within a stage",
        });
      }
      occupiedPositions.add(positionKey);

      Object.entries(task.values).forEach(([fieldId, value]) => {
        const field = fieldById.get(fieldId);
        if (!field) {
          issues.push({
            path: [...taskPath, "values", fieldId],
            message: "Task value must reference a live field",
          });
          return;
        }
        const valid =
          (field.type === "text" && typeof value === "string") ||
          (field.type === "number" &&
            typeof value === "number" &&
            Number.isFinite(value)) ||
          (field.type === "date" &&
            typeof value === "string" &&
            isIsoDate(value)) ||
          (field.type === "single_select" &&
            typeof value === "string" &&
            field.options.includes(value)) ||
          (field.type === "checkbox" && typeof value === "boolean");
        if (!valid) {
          issues.push({
            path: [...taskPath, "values", fieldId],
            message: "Task value does not match its field type",
          });
        }
      });
    });
  });

  return issues;
}