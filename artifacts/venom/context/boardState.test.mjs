import assert from "node:assert/strict";
import test from "node:test";

import {
  createDefaultBoardStages,
  isValidBoardDate,
  mergeProjectBoardSnapshots,
  normalizeBoardValue,
  normalizeProjectBoard,
} from "./boardState.ts";

const legacyProject = (id = "alpha") => ({
  id,
  name: "Alpha",
  description: "",
  accent: "#000000",
  sourceCount: 0,
  updatedAt: 100,
  tasks: [
    { id: "todo", title: "Waiting", status: "todo", createdAt: 1 },
    {
      id: "active",
      title: "Working",
      status: "in_progress",
      createdAt: 2,
    },
    { id: "done", title: "Shipped", status: "done", createdAt: 3 },
  ],
});

test("legacy fixed statuses migrate to stable ordered stages without task loss", () => {
  const migrated = normalizeProjectBoard(legacyProject());
  assert.deepEqual(
    migrated.boardStages.map((stage) => [stage.name, stage.isDone]),
    [
      ["To Do", false],
      ["Active", false],
      ["Done", true],
    ],
  );
  assert.equal(migrated.tasks.length, 3);
  assert.deepEqual(
    migrated.tasks.map((task) => task.stageId),
    migrated.boardStages.map((stage) => stage.id),
  );
  assert.ok(
    migrated.tasks.every(
      (task) => typeof task.updatedAt === "number" && task.values,
    ),
  );
});

test("default stage ids are deterministic per project and isolated", () => {
  assert.deepEqual(
    createDefaultBoardStages("alpha", 1).map((stage) => stage.id),
    createDefaultBoardStages("alpha", 99).map((stage) => stage.id),
  );
  assert.notDeepEqual(
    createDefaultBoardStages("alpha", 1).map((stage) => stage.id),
    createDefaultBoardStages("beta", 1).map((stage) => stage.id),
  );
});

test("removed fields and invalid typed values are pruned during normalization", () => {
  const project = normalizeProjectBoard({
    ...legacyProject(),
    boardStages: createDefaultBoardStages("alpha", 1),
    fieldDefinitions: [
      {
        id: "estimate",
        name: "Estimate",
        type: "number",
        options: [],
        position: 0,
        showOnCard: true,
        updatedAt: 1,
      },
      {
        id: "priority",
        name: "Priority",
        type: "single_select",
        options: ["High", "Low"],
        position: 1,
        showOnCard: true,
        updatedAt: 1,
      },
    ],
    tasks: [
      {
        id: "task",
        title: "Typed",
        stageId: createDefaultBoardStages("alpha", 1)[0].id,
        position: 0,
        createdAt: 1,
        updatedAt: 1,
        values: {
          estimate: "not a number",
          priority: "Unknown",
          deleted: "must not return",
        },
      },
    ],
  });
  assert.deepEqual(project.tasks[0].values, {});
});

test("field validators enforce dates, options, numbers and checkbox values", () => {
  const field = (type, options = []) => ({
    id: type,
    name: type,
    type,
    options,
    position: 0,
    showOnCard: true,
    updatedAt: 1,
  });
  assert.equal(normalizeBoardValue(field("date"), "2026-08-20"), "2026-08-20");
  assert.equal(normalizeBoardValue(field("date"), "08/20/26"), undefined);
  assert.equal(isValidBoardDate("2026-02-30"), false);
  assert.equal(
    normalizeBoardValue(field("single_select", ["High"]), "Low"),
    undefined,
  );
  assert.equal(normalizeBoardValue(field("number"), 8), 8);
  assert.equal(normalizeBoardValue(field("checkbox"), true), true);
});

test("conflict merging keeps newest card edits and deterministic ordering", () => {
  const base = normalizeProjectBoard(legacyProject());
  const firstStage = base.boardStages[0].id;
  const cloud = {
    ...base,
    updatedAt: 200,
    tasks: base.tasks.map((task, index) => ({
      ...task,
      position: index,
      updatedAt: 200,
    })),
  };
  const device = {
    ...base,
    updatedAt: 300,
    tasks: base.tasks.map((task, index) =>
      task.id === "todo"
        ? {
            ...task,
            title: "Newest offline title",
            stageId: firstStage,
            position: 2,
            updatedAt: 350,
          }
        : { ...task, updatedAt: 150, position: index },
    ),
  };
  const merged = mergeProjectBoardSnapshots(cloud, device, {
    tasks: new Map(),
    stages: new Map(),
    fields: new Map(),
  });
  assert.equal(
    merged.tasks.find((task) => task.id === "todo")?.title,
    "Newest offline title",
  );
  assert.deepEqual(
    merged.tasks
      .filter((task) => task.stageId === firstStage)
      .map((task) => task.position),
    [0],
  );
});

test("stage and field tombstones prevent stale metadata and values returning", () => {
  const stages = createDefaultBoardStages("alpha", 10);
  const field = {
    id: "priority",
    name: "Priority",
    type: "single_select",
    options: ["High"],
    position: 0,
    showOnCard: true,
    updatedAt: 20,
  };
  const base = normalizeProjectBoard({
    ...legacyProject(),
    boardStages: stages,
    fieldDefinitions: [field],
    tasks: [
      {
        id: "task",
        title: "Stale metadata",
        stageId: stages[1].id,
        position: 0,
        createdAt: 1,
        updatedAt: 25,
        values: { priority: "High" },
      },
    ],
  });
  const merged = mergeProjectBoardSnapshots(base, base, {
    tasks: new Map(),
    stages: new Map([[stages[1].id, 30]]),
    fields: new Map([[field.id, 30]]),
  });
  assert.ok(!merged.boardStages.some((stage) => stage.id === stages[1].id));
  assert.equal(merged.fieldDefinitions.length, 0);
  assert.deepEqual(merged.tasks[0].values, {});
  assert.notEqual(merged.tasks[0].stageId, stages[1].id);
});