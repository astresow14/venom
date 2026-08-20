import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import test from "node:test";
import express from "express";
import {
  createVenomWorkspaceRouter,
  MAX_API_JSON_BODY_BYTES,
  MAX_VENOM_WORKSPACE_BYTES,
  payloadTooLargeErrorHandler,
  workspacePayloadBytes,
  workspaceTooLargeResponse,
} from "./venom-workspace-router.ts";

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