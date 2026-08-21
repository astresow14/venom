/**
 * community-agenda.test.mjs
 *
 * Pure unit tests for agenda extraction, timezone day boundaries,
 * and per-viewer workspace isolation.
 * No DB, no auth.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { extractAgendaItems, MAX_AGENDA_ITEMS } from "./community-agenda.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeProject(overrides = {}) {
  return {
    id: "proj-1",
    name: "Test Project",
    stage: "in_progress",
    isDone: "done",
    tasks: [],
    ...overrides,
  };
}

function makeTask(overrides = {}) {
  return {
    id: "task-1",
    title: "Do the thing",
    status: "open",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Basic extraction
// ---------------------------------------------------------------------------

describe("extractAgendaItems", () => {
  it("returns empty array for null state", () => {
    assert.deepEqual(extractAgendaItems("user1", null, "2025-06-15"), []);
  });

  it("returns empty array for non-object state", () => {
    assert.deepEqual(extractAgendaItems("user1", "string", "2025-06-15"), []);
    assert.deepEqual(extractAgendaItems("user1", 42, "2025-06-15"), []);
    assert.deepEqual(extractAgendaItems("user1", [], "2025-06-15"), []);
  });

  it("returns empty array for state with no projects", () => {
    assert.deepEqual(extractAgendaItems("user1", {}, "2025-06-15"), []);
    assert.deepEqual(extractAgendaItems("user1", { projects: [] }, "2025-06-15"), []);
  });

  it("extracts open tasks from active project", () => {
    const state = {
      projects: [
        makeProject({
          tasks: [makeTask({ id: "t1", title: "Task One" })],
        }),
      ],
    };
    const items = extractAgendaItems("user1", state, "2025-06-15");
    assert.equal(items.length, 1);
    assert.equal(items[0].title, "Task One");
    assert.equal(items[0].source, "todo");
    assert.equal(items[0].privacy, "personal");
    assert.equal(items[0].state, "open");
    assert.equal(items[0].projectName, "Test Project");
  });

  it("skips done tasks", () => {
    const state = {
      projects: [
        makeProject({
          tasks: [
            makeTask({ id: "t1", title: "Done Task", status: "done" }),
            makeTask({ id: "t2", title: "Active Task" }),
          ],
        }),
      ],
    };
    const items = extractAgendaItems("user1", state, "2025-06-15");
    assert.equal(items.length, 1);
    assert.equal(items[0].title, "Active Task");
  });

  it("skips completed tasks", () => {
    const state = {
      projects: [
        makeProject({
          tasks: [makeTask({ id: "t1", title: "Completed Task", status: "completed" })],
        }),
      ],
    };
    const items = extractAgendaItems("user1", state, "2025-06-15");
    assert.equal(items.length, 0);
  });

  it("skips done projects", () => {
    const state = {
      projects: [
        makeProject({
          stage: "done", // matches isDone value
          tasks: [makeTask({ id: "t1", title: "Hidden Task" })],
        }),
      ],
    };
    const items = extractAgendaItems("user1", state, "2025-06-15");
    assert.equal(items.length, 0);
  });

  it("caps results at MAX_AGENDA_ITEMS", () => {
    const tasks = Array.from({ length: 30 }, (_, i) => ({
      id: `task-${i}`,
      title: `Task ${i}`,
      status: "open",
    }));
    const state = { projects: [makeProject({ tasks })] };
    const items = extractAgendaItems("user1", state, "2025-06-15");
    assert.equal(items.length, MAX_AGENDA_ITEMS);
  });

  it("prioritizes due-today tasks over in_progress over open", () => {
    const calendarDay = "2025-06-15";
    const state = {
      projects: [
        makeProject({
          tasks: [
            makeTask({ id: "t1", title: "Open Task", status: "open" }),
            makeTask({ id: "t2", title: "In Progress Task", status: "in_progress" }),
            makeTask({ id: "t3", title: "Due Today Task", status: "open", dueDate: calendarDay }),
          ],
        }),
      ],
    };
    const items = extractAgendaItems("user1", state, calendarDay);
    assert.equal(items[0].title, "Due Today Task");
    assert.equal(items[1].title, "In Progress Task");
    assert.equal(items[2].title, "Open Task");
  });

  it("extracts dueDate from task field", () => {
    const state = {
      projects: [
        makeProject({
          tasks: [makeTask({ id: "t1", title: "With Due Date", dueDate: "2025-07-01" })],
        }),
      ],
    };
    const items = extractAgendaItems("user1", state, "2025-06-15");
    assert.equal(items[0].dueDate, "2025-07-01");
  });

  it("produces opaque IDs — no raw workspace or task IDs emitted", () => {
    const state = {
      projects: [
        makeProject({
          id: "PRIVATE_PROJECT_ID",
          tasks: [makeTask({ id: "PRIVATE_TASK_ID", title: "Sensitive Task" })],
        }),
      ],
    };
    const items = extractAgendaItems("user1", state, "2025-06-15");
    assert.equal(items.length, 1);
    // ID must be a hex hash, not the raw private IDs
    assert.ok(!items[0].id.includes("PRIVATE_PROJECT_ID"), "Project ID must not appear in opaque ID");
    assert.ok(!items[0].id.includes("PRIVATE_TASK_ID"), "Task ID must not appear in opaque ID");
    assert.match(items[0].id, /^[0-9a-f]{40}$/);
  });

  it("per-viewer isolation: same task produces different opaque ID for different users", () => {
    const state = {
      projects: [
        makeProject({ tasks: [makeTask({ id: "t1", title: "Task" })] }),
      ],
    };
    const items1 = extractAgendaItems("user-A", state, "2025-06-15");
    const items2 = extractAgendaItems("user-B", state, "2025-06-15");
    assert.notEqual(items1[0].id, items2[0].id);
  });

  it("never includes startsAt (no calendar)", () => {
    const state = {
      projects: [makeProject({ tasks: [makeTask()] })],
    };
    const items = extractAgendaItems("user1", state, "2025-06-15");
    assert.equal(items[0].startsAt, null);
  });

  it("never includes detail field", () => {
    const state = {
      projects: [makeProject({ tasks: [makeTask()] })],
    };
    const items = extractAgendaItems("user1", state, "2025-06-15");
    assert.equal(items[0].detail, null);
  });

  it("handles tasks with missing titles gracefully", () => {
    const state = {
      projects: [
        makeProject({
          tasks: [
            { id: "t1" }, // no title
            makeTask({ id: "t2", title: "Valid Task" }),
          ],
        }),
      ],
    };
    const items = extractAgendaItems("user1", state, "2025-06-15");
    assert.equal(items.length, 1);
    assert.equal(items[0].title, "Valid Task");
  });

  it("handles malformed task entries", () => {
    const state = {
      projects: [
        makeProject({
          tasks: ["not an object", null, 42, makeTask({ id: "t1", title: "Real Task" })],
        }),
      ],
    };
    const items = extractAgendaItems("user1", state, "2025-06-15");
    assert.equal(items.length, 1);
  });

  it("handles state with no projects array", () => {
    const items = extractAgendaItems("user1", { other: "data" }, "2025-06-15");
    assert.deepEqual(items, []);
  });
});

// ---------------------------------------------------------------------------
// Timezone day boundary
// ---------------------------------------------------------------------------

describe("timezone day boundaries", () => {
  it("due-today filter uses the resolved calendar day, not UTC", () => {
    // We pass explicit calendarDay so this is timezone-independent in test
    const calendarDay = "2025-12-31";
    const state = {
      projects: [
        makeProject({
          tasks: [
            makeTask({ id: "t1", title: "Due on 2025-12-31", dueDate: "2025-12-31" }),
            makeTask({ id: "t2", title: "Due on 2026-01-01", dueDate: "2026-01-01" }),
          ],
        }),
      ],
    };
    const items = extractAgendaItems("user1", state, calendarDay);
    assert.equal(items[0].title, "Due on 2025-12-31", "Due-today task comes first");
    assert.equal(items[1].title, "Due on 2026-01-01");
  });
});
