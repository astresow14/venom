import assert from "node:assert/strict";
import test from "node:test";

import {
  createFallbackWorkspaceProject,
  mostRecentlyUpdatedProjectId,
} from "./projectLifecycle.ts";

const project = (id, updatedAt) => ({
  id,
  name: id,
  description: "",
  accent: "#000000",
  sourceCount: 0,
  updatedAt,
  tasks: [],
  boardStages: [],
  fieldDefinitions: [],
});

test("lands on the most recently updated remaining project", () => {
  assert.equal(
    mostRecentlyUpdatedProjectId([
      project("older", 10),
      project("newest", 30),
      project("middle", 20),
    ]),
    "newest",
  );
});

test("returns null when no projects remain", () => {
  assert.equal(mostRecentlyUpdatedProjectId([]), null);
});

test("fallback workspace is a fresh usable default project", () => {
  const fallback = createFallbackWorkspaceProject("proj_next", 123);

  assert.equal(fallback.id, "proj_next");
  assert.equal(fallback.name, "General");
  assert.equal(fallback.updatedAt, 123);
  assert.deepEqual(fallback.tasks, []);
  assert.deepEqual(fallback.fieldDefinitions, []);
  assert.ok(fallback.boardStages.length > 0, "board needs default stages");
  assert.ok(
    fallback.boardStages.every((stage) => stage.updatedAt === 123),
    "stages carry the creation timestamp",
  );
});

test("fallback workspaces never collide with each other or the deleted id", () => {
  const first = createFallbackWorkspaceProject("proj_a", 1);
  const second = createFallbackWorkspaceProject("proj_b", 2);

  assert.notEqual(first.id, second.id);
  const firstStageIds = new Set(first.boardStages.map((stage) => stage.id));
  assert.ok(
    second.boardStages.every((stage) => !firstStageIds.has(stage.id)),
    "stage ids must stay distinct per workspace",
  );
});
