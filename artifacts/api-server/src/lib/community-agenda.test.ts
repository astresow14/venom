/**
 * community-agenda.test.ts
 *
 * Tests extractAgendaItems using real canonical workspace fixtures
 * (boardStages + fieldDefinitions + tasks[stageId, values]).
 * Also covers legacy shape, done-stage exclusion, selected-day date field,
 * per-viewer isolation.
 *
 * Bundled via esbuild + node --test.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { extractAgendaItems, MAX_AGENDA_ITEMS } from "./community-agenda";

// ---------------------------------------------------------------------------
// Canonical workspace fixture builders
// ---------------------------------------------------------------------------

function makeStage(id: string, name: string, isDone: boolean, position = 0) {
  return { id, name, isDone, position, updatedAt: 0 };
}

function makeField(id: string, name: string, type: string, position = 0) {
  return { id, name, type, options: [], position, showOnCard: false, updatedAt: 0 };
}

function makeTask(
  id: string,
  title: string,
  stageId: string,
  values: Record<string, unknown> = {},
  position = 0,
) {
  return { id, title, stageId, values, position, createdAt: 0, updatedAt: 0 };
}

function makeCanonicalProject(overrides: {
  id?: string;
  name?: string;
  stages?: ReturnType<typeof makeStage>[];
  fields?: ReturnType<typeof makeField>[];
  tasks?: ReturnType<typeof makeTask>[];
}) {
  return {
    id: overrides.id ?? "proj-1",
    name: overrides.name ?? "Test Project",
    description: "",
    accent: "#000",
    sourceCount: 0,
    updatedAt: 0,
    boardStages: overrides.stages ?? [
      makeStage("todo", "To Do", false, 0),
      makeStage("done", "Done", true, 1),
    ],
    fieldDefinitions: overrides.fields ?? [],
    tasks: overrides.tasks ?? [],
  };
}

// ---------------------------------------------------------------------------
// Basic canonical shape
// ---------------------------------------------------------------------------

describe("extractAgendaItems — canonical workspace shape", () => {
  it("extracts open task from To Do stage", () => {
    const state = {
      projects: [
        makeCanonicalProject({
          tasks: [makeTask("t1", "Write tests", "todo")],
        }),
      ],
    };
    const items = extractAgendaItems("user1", state, "2025-06-15");
    assert.equal(items.length, 1);
    assert.equal(items[0].title, "Write tests");
    assert.equal(items[0].state, "open");
    assert.equal(items[0].source, "todo");
    assert.equal(items[0].privacy, "personal");
    assert.equal(items[0].projectName, "Test Project");
  });

  it("skips tasks in isDone=true stages", () => {
    const state = {
      projects: [
        makeCanonicalProject({
          tasks: [
            makeTask("t1", "Active Task", "todo"),
            makeTask("t2", "Done Task", "done"),
          ],
        }),
      ],
    };
    const items = extractAgendaItems("user1", state, "2025-06-15");
    assert.equal(items.length, 1);
    assert.equal(items[0].title, "Active Task");
  });

  it("skips projects where all stages are isDone", () => {
    const allDoneProject = makeCanonicalProject({
      stages: [
        makeStage("done1", "Done", true, 0),
        makeStage("done2", "Archived", true, 1),
      ],
      tasks: [makeTask("t1", "Hidden Task", "done1")],
    });
    const state = { projects: [allDoneProject] };
    const items = extractAgendaItems("user1", state, "2025-06-15");
    assert.equal(items.length, 0, "All-done-stage project must produce no items");
  });

  it("derives in_progress from 'In Progress' stage name", () => {
    const state = {
      projects: [
        makeCanonicalProject({
          stages: [
            makeStage("todo", "To Do", false, 0),
            makeStage("wip", "In Progress", false, 1),
            makeStage("done", "Done", true, 2),
          ],
          tasks: [
            makeTask("t1", "In-flight task", "wip"),
            makeTask("t2", "Open task", "todo"),
          ],
        }),
      ],
    };
    const items = extractAgendaItems("user1", state, "2025-06-15");
    assert.equal(items.length, 2);
    // in_progress before open
    assert.equal(items[0].state, "in_progress");
    assert.equal(items[0].title, "In-flight task");
    assert.equal(items[1].state, "open");
  });

  it("derives in_progress from 'Doing' stage name", () => {
    const state = {
      projects: [
        makeCanonicalProject({
          stages: [
            makeStage("doing", "Doing", false, 0),
            makeStage("done", "Done", true, 1),
          ],
          tasks: [makeTask("t1", "Doing Task", "doing")],
        }),
      ],
    };
    const items = extractAgendaItems("user1", state, "2025-06-15");
    assert.equal(items[0].state, "in_progress");
  });

  it("derives in_progress from 'Active' stage name", () => {
    const state = {
      projects: [
        makeCanonicalProject({
          stages: [
            makeStage("active", "Active", false, 0),
            makeStage("done", "Done", true, 1),
          ],
          tasks: [makeTask("t1", "Active Task", "active")],
        }),
      ],
    };
    const items = extractAgendaItems("user1", state, "2025-06-15");
    assert.equal(items[0].state, "in_progress");
  });

  it("skips tasks with unknown stageId", () => {
    const state = {
      projects: [
        makeCanonicalProject({
          tasks: [makeTask("t1", "Orphan Task", "nonexistent-stage-id")],
        }),
      ],
    };
    const items = extractAgendaItems("user1", state, "2025-06-15");
    assert.equal(items.length, 0, "Task with unknown stageId must be skipped");
  });
});

// ---------------------------------------------------------------------------
// Date field extraction from task.values
// ---------------------------------------------------------------------------

describe("extractAgendaItems — date field via task.values", () => {
  it("extracts due date from task.values[dateFieldId]", () => {
    const dateFieldId = "field-due-date";
    const calendarDay = "2025-06-20";
    const state = {
      projects: [
        makeCanonicalProject({
          fields: [makeField(dateFieldId, "Due Date", "date")],
          tasks: [
            makeTask("t1", "Due Task", "todo", {
              [dateFieldId]: calendarDay,
            }),
          ],
        }),
      ],
    };
    const items = extractAgendaItems("user1", state, calendarDay);
    assert.equal(items[0].dueDate, calendarDay);
    assert.equal(items[0].state, "open"); // due today but in open stage → still goes first
  });

  it("prioritizes due-today over in_progress when date matches calendar day", () => {
    const dateFieldId = "field-due";
    const calendarDay = "2025-06-15";
    const state = {
      projects: [
        makeCanonicalProject({
          stages: [
            makeStage("todo", "To Do", false, 0),
            makeStage("wip", "In Progress", false, 1),
            makeStage("done", "Done", true, 2),
          ],
          fields: [makeField(dateFieldId, "Due", "date")],
          tasks: [
            makeTask("t1", "In-flight", "wip"), // in_progress, no due date
            makeTask("t2", "Due Today", "todo", { [dateFieldId]: calendarDay }),
          ],
        }),
      ],
    };
    const items = extractAgendaItems("user1", state, calendarDay);
    assert.equal(items[0].title, "Due Today", "Due-today must come before in-progress");
    assert.equal(items[1].title, "In-flight");
  });

  it("date field found by type='date' even if name is custom", () => {
    const dateFieldId = "field-custom-date";
    const calendarDay = "2025-07-04";
    const state = {
      projects: [
        makeCanonicalProject({
          fields: [makeField(dateFieldId, "Target Date", "date")],
          tasks: [
            makeTask("t1", "July 4th Task", "todo", {
              [dateFieldId]: calendarDay,
            }),
          ],
        }),
      ],
    };
    const items = extractAgendaItems("user1", state, calendarDay);
    assert.equal(items[0].dueDate, calendarDay);
  });

  it("ignores non-date values in date fields", () => {
    const dateFieldId = "field-date";
    const state = {
      projects: [
        makeCanonicalProject({
          fields: [makeField(dateFieldId, "Due Date", "date")],
          tasks: [
            makeTask("t1", "No Valid Date", "todo", { [dateFieldId]: "not-a-date" }),
          ],
        }),
      ],
    };
    const items = extractAgendaItems("user1", state, "2025-06-15");
    assert.equal(items[0].dueDate, null);
  });
});

// ---------------------------------------------------------------------------
// Legacy workspace shape (backward compatibility)
// ---------------------------------------------------------------------------

describe("extractAgendaItems — legacy shape", () => {
  it("falls back to task.status for projects without boardStages", () => {
    const legacyState = {
      projects: [
        {
          id: "legacy-proj",
          name: "Legacy Project",
          // no boardStages
          tasks: [
            { id: "t1", title: "Open Task", status: "open" },
            { id: "t2", title: "Done Task", status: "done" },
            { id: "t3", title: "WIP Task", status: "in_progress" },
          ],
        },
      ],
    };
    const items = extractAgendaItems("user1", legacyState, "2025-06-15");
    assert.equal(items.length, 2);
    const states = items.map((i) => i.state);
    assert.ok(states.includes("open"));
    assert.ok(states.includes("in_progress"));
  });

  it("falls back to task.dueDate for projects without fieldDefinitions", () => {
    const legacyState = {
      projects: [
        {
          id: "legacy-proj",
          name: "Legacy Project",
          tasks: [
            { id: "t1", title: "Has Due Date", status: "open", dueDate: "2025-06-15" },
          ],
        },
      ],
    };
    const items = extractAgendaItems("user1", legacyState, "2025-06-15");
    assert.equal(items[0].dueDate, "2025-06-15");
  });

  it("legacy stage/isDone sentinel skips done project", () => {
    const legacyState = {
      projects: [
        {
          id: "proj-1",
          stage: "done",
          isDone: "done",
          tasks: [{ id: "t1", title: "Hidden", status: "open" }],
        },
      ],
    };
    const items = extractAgendaItems("user1", legacyState, "2025-06-15");
    assert.equal(items.length, 0);
  });
});

// ---------------------------------------------------------------------------
// Privacy and isolation
// ---------------------------------------------------------------------------

describe("extractAgendaItems — privacy", () => {
  it("opaque ID does not contain raw project or task IDs", () => {
    const state = {
      projects: [
        makeCanonicalProject({
          id: "PRIVATE_PROJECT_ID",
          tasks: [makeTask("PRIVATE_TASK_ID", "Some Task", "todo")],
        }),
      ],
    };
    const items = extractAgendaItems("user1", state, "2025-06-15");
    assert.ok(!items[0].id.includes("PRIVATE_PROJECT_ID"));
    assert.ok(!items[0].id.includes("PRIVATE_TASK_ID"));
    assert.match(items[0].id, /^[0-9a-f]{40}$/);
  });

  it("same task produces different opaque ID for different users", () => {
    const state = {
      projects: [makeCanonicalProject({ tasks: [makeTask("t1", "Task", "todo")] })],
    };
    const a = extractAgendaItems("user-A", state, "2025-06-15");
    const b = extractAgendaItems("user-B", state, "2025-06-15");
    assert.notEqual(a[0].id, b[0].id, "Per-viewer isolation: IDs must differ across users");
  });

  it("detail and startsAt are always null (no calendar)", () => {
    const state = { projects: [makeCanonicalProject({ tasks: [makeTask("t1", "T", "todo")] })] };
    const [item] = extractAgendaItems("user1", state, "2025-06-15");
    assert.equal(item.detail, null);
    assert.equal(item.startsAt, null);
  });

  it("caps at MAX_AGENDA_ITEMS", () => {
    const tasks = Array.from({ length: 30 }, (_, i) => makeTask(`t${i}`, `Task ${i}`, "todo"));
    const state = { projects: [makeCanonicalProject({ tasks })] };
    const items = extractAgendaItems("user1", state, "2025-06-15");
    assert.equal(items.length, MAX_AGENDA_ITEMS);
  });
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

describe("extractAgendaItems — edge cases", () => {
  it("returns empty for null state", () => {
    assert.deepEqual(extractAgendaItems("u", null, "2025-06-15"), []);
  });

  it("returns empty for non-object state", () => {
    assert.deepEqual(extractAgendaItems("u", "string", "2025-06-15"), []);
  });

  it("returns empty for empty projects array", () => {
    assert.deepEqual(extractAgendaItems("u", { projects: [] }, "2025-06-15"), []);
  });

  it("skips tasks with no title", () => {
    const state = {
      projects: [
        makeCanonicalProject({
          tasks: [
            { id: "t1", stageId: "todo" } as ReturnType<typeof makeTask>,
            makeTask("t2", "Valid Task", "todo"),
          ],
        }),
      ],
    };
    const items = extractAgendaItems("user1", state, "2025-06-15");
    assert.equal(items.length, 1);
    assert.equal(items[0].title, "Valid Task");
  });

  it("handles malformed task entries gracefully", () => {
    const state = {
      projects: [
        makeCanonicalProject({
          tasks: [
            null,
            "not-a-task",
            42,
            makeTask("t1", "Real Task", "todo"),
          ] as unknown as ReturnType<typeof makeTask>[],
        }),
      ],
    };
    const items = extractAgendaItems("user1", state, "2025-06-15");
    assert.equal(items.length, 1);
    assert.equal(items[0].title, "Real Task");
  });
});
