import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import test from "node:test";
import express from "express";
import { SaveVenomWorkspaceBody } from "../../../../lib/api-zod/src/generated/api.ts";
import {
  createVenomWorkspaceRouter,
  MAX_API_JSON_BODY_BYTES,
  MAX_VENOM_WORKSPACE_BYTES,
  payloadTooLargeErrorHandler,
  workspacePayloadBytes,
  workspaceTooLargeResponse,
} from "./venom-workspace-router.ts";
import { validateVenomBoardState } from "./venom-board-validation.ts";

function createMemoryStore() {
  const records = new Map();
  return {
    records,
    store: {
      async get(userId) {
        return records.get(userId);
      },
      async create(userId, state, updatedAt) {
        if (records.has(userId)) return undefined;
        const record = { state, revision: 1, updatedAt };
        records.set(userId, record);
        return record;
      },
      async update(userId, state, baseRevision, updatedAt) {
        const current = records.get(userId);
        if (!current || current.revision !== baseRevision) return undefined;
        const record = {
          state,
          revision: current.revision + 1,
          updatedAt,
        };
        records.set(userId, record);
        return record;
      },
    },
  };
}

function createWorkspace(messageCount, messageLength) {
  const now = Date.now();
  return {
    projects: [
      {
        id: "project-large",
        name: "Large workspace",
        description: "Several realistic assistant replies",
        accent: "#000000",
        sourceCount: 1,
        updatedAt: now,
        tasks: [],
      },
    ],
    conversations: [
      {
        id: "conversation-large",
        title: "Long-running planning session",
        projectId: "project-large",
        updatedAt: now,
        messages: Array.from({ length: messageCount }, (_, index) => ({
          id: `message-${index}`,
          role: index % 2 === 0 ? "user" : "assistant",
          content: `${index}:`.padEnd(messageLength, "x"),
          createdAt: now + index,
          status: "sent",
        })),
      },
    ],
    clusters: [],
    activeProjectId: "project-large",
    activeConversationId: "conversation-large",
    tombstones: {
      projects: [],
      tasks: [],
      conversations: [],
      messages: [],
      clusters: [],
    },
  };
}

async function withWorkspaceServer(run) {
  const { records, store } = createMemoryStore();
  const app = express();
  app.use(express.json({ limit: 6 * 1024 * 1024 }));
  app.use(
    "/api",
    createVenomWorkspaceRouter({
      resolveUserId: () => "integration-user",
      parseBody: (value) =>
        value &&
        typeof value === "object" &&
        "state" in value &&
        typeof value.baseRevision === "number"
          ? {
              success: true,
              data: {
                state: value.state,
                baseRevision: value.baseRevision,
              },
            }
          : { success: false },
      store,
    }),
  );
  const server = createServer(app);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert(address && typeof address === "object");

  try {
    await run(`http://127.0.0.1:${address.port}/api`, records);
  } finally {
    server.close();
    await once(server, "close");
  }
}

test("saves and restores workspace histories well above 100 KB", async () => {
  await withWorkspaceServer(async (baseUrl) => {
    const state = createWorkspace(6, 40_000);
    assert(workspacePayloadBytes(state) > 100 * 1024);

    const saveResponse = await fetch(`${baseUrl}/venom/workspace`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ state, baseRevision: 0 }),
    });
    assert.equal(saveResponse.status, 200);
    const saved = await saveResponse.json();
    assert.equal(saved.revision, 1);

    const restoreResponse = await fetch(`${baseUrl}/venom/workspace`);
    assert.equal(restoreResponse.status, 200);
    const restored = await restoreResponse.json();
    assert.equal(restored.revision, 1);
    assert.equal(
      restored.state.conversations[0].messages[5].content,
      state.conversations[0].messages[5].content,
    );
  });
});

test("returns a deliberate 413 without replacing the saved workspace", async () => {
  await withWorkspaceServer(async (baseUrl) => {
    const initialState = createWorkspace(1, 100);
    const initialResponse = await fetch(`${baseUrl}/venom/workspace`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ state: initialState, baseRevision: 0 }),
    });
    assert.equal(initialResponse.status, 200);

    const oversizedState = createWorkspace(106, 50_000);
    assert(workspacePayloadBytes(oversizedState) > MAX_VENOM_WORKSPACE_BYTES);
    const oversizedResponse = await fetch(`${baseUrl}/venom/workspace`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ state: oversizedState, baseRevision: 1 }),
    });
    assert.equal(oversizedResponse.status, 413);
    assert.deepEqual(
      await oversizedResponse.json(),
      workspaceTooLargeResponse(),
    );

    const restoreResponse = await fetch(`${baseUrl}/venom/workspace`);
    const restored = await restoreResponse.json();
    assert.equal(restored.revision, 1);
    assert.equal(restored.state.conversations[0].messages.length, 1);
  });
});

test("parser-level 413 matches the published workspace error shape", async () => {
  const app = express();
  app.use(express.json({ limit: MAX_API_JSON_BODY_BYTES }));
  app.post("/api/venom/workspace", (_request, response) => {
    response.json({ unexpected: true });
  });
  app.use(payloadTooLargeErrorHandler);

  const server = createServer(app);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert(address && typeof address === "object");

  try {
    const response = await fetch(
      `http://127.0.0.1:${address.port}/api/venom/workspace`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          content: "x".repeat(MAX_API_JSON_BODY_BYTES),
        }),
      },
    );
    assert.equal(response.status, 413);
    assert.deepEqual(await response.json(), workspaceTooLargeResponse());
  } finally {
    server.close();
    await once(server, "close");
  }
});

function createBoardWorkspace() {
  const now = Date.now();
  return {
    projects: [
      {
        id: "project-board",
        name: "Board",
        description: "",
        accent: "#000000",
        sourceCount: 0,
        updatedAt: now,
        boardStages: [
          {
            id: "stage-todo",
            name: "To Do",
            position: 0,
            isDone: false,
            updatedAt: now,
          },
          {
            id: "stage-done",
            name: "Done",
            position: 1,
            isDone: true,
            updatedAt: now,
          },
        ],
        fieldDefinitions: [
          {
            id: "field-date",
            name: "Due",
            type: "date",
            options: [],
            position: 0,
            showOnCard: true,
            updatedAt: now,
          },
          {
            id: "field-priority",
            name: "Priority",
            type: "single_select",
            options: ["High", "Low"],
            position: 1,
            showOnCard: true,
            updatedAt: now,
          },
        ],
        tasks: [
          {
            id: "task-board",
            title: "Validate the board",
            stageId: "stage-todo",
            position: 0,
            createdAt: now,
            updatedAt: now,
            values: {
              "field-date": "2026-08-20",
              "field-priority": "High",
            },
          },
        ],
      },
    ],
    conversations: [],
    clusters: [],
    activeProjectId: "project-board",
    activeConversationId: null,
    tombstones: {
      projects: [],
      tasks: [],
      conversations: [],
      messages: [],
      clusters: [],
      stages: [],
      fields: [],
    },
  };
}

test("generated contract accepts a fully typed customizable board", () => {
  const state = createBoardWorkspace();
  assert.equal(
    SaveVenomWorkspaceBody.safeParse({ state, baseRevision: 0 }).success,
    true,
  );
  assert.deepEqual(validateVenomBoardState(state), []);
});

test("board validation rejects stale field values and invalid typed values", () => {
  const state = createBoardWorkspace();
  state.projects[0].tasks[0].values["field-date"] = "August 20";
  state.projects[0].tasks[0].values["field-priority"] = "Urgent";
  state.projects[0].tasks[0].values["removed-field"] = "must not return";

  const issues = validateVenomBoardState(state);
  assert.equal(issues.length, 3);
  assert.ok(
    issues.every((issue) => !JSON.stringify(issue).includes("must not return")),
  );
});

test("board validation requires valid ordering and explicit done semantics", () => {
  const state = createBoardWorkspace();
  state.projects[0].boardStages[1].position = 0;
  state.projects[0].boardStages[1].isDone = false;
  state.projects[0].tasks.push({
    ...state.projects[0].tasks[0],
    id: "task-collision",
  });

  const messages = validateVenomBoardState(state).map(
    (issue) => issue.message,
  );
  assert.ok(messages.includes("Stage positions must be unique"));
  assert.ok(messages.includes("At least one stage must mark cards done"));
  assert.ok(messages.includes("Task positions must be unique within a stage"));
});