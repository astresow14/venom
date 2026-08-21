// Workspace router + ontology bridge behavior: the blob is stored stripped,
// accepted saves are absorbed into the store, and every snapshot a client
// sees is hydrated with stored knowledge.
import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import test from "node:test";
import express from "express";
import { createVenomWorkspaceRouter } from "./venom-workspace-router.ts";

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
        const record = { state, revision: current.revision + 1, updatedAt };
        records.set(userId, record);
        return record;
      },
    },
  };
}

/**
 * Fake ontology bridge with client-merge-free semantics: absorb unions
 * incoming clusters into an in-memory map, hydrate injects them back.
 */
function createFakeOntology() {
  const conceptsByUser = new Map();
  const calls = [];
  return {
    conceptsByUser,
    calls,
    bridge: {
      strip(state) {
        return state && typeof state === "object"
          ? { ...state, clusters: [] }
          : state;
      },
      async ensureOwner(userId) {
        calls.push(["ensureOwner", userId]);
      },
      async absorb(userId, state) {
        calls.push(["absorb", userId]);
        const map = conceptsByUser.get(userId) ?? new Map();
        for (const cluster of state?.clusters ?? []) {
          map.set(cluster.id, cluster);
        }
        conceptsByUser.set(userId, map);
        return {
          ...state,
          clusters: [...map.values()],
        };
      },
      async hydrate(userId, state) {
        calls.push(["hydrate", userId]);
        const map = conceptsByUser.get(userId) ?? new Map();
        return state && typeof state === "object"
          ? { ...state, clusters: [...map.values()] }
          : state;
      },
    },
  };
}

async function startServer(router) {
  const app = express();
  app.use(express.json({ limit: "6mb" }));
  app.use((req, _res, next) => {
    req.log = { warn() {} };
    next();
  });
  app.use(router);
  const server = createServer(app);
  server.listen(0);
  await once(server, "listening");
  const { port } = server.address();
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

function passthroughParseBody(value) {
  if (!value || typeof value !== "object" || !("state" in value)) {
    return { success: false };
  }
  return {
    success: true,
    data: { state: value.state, baseRevision: value.baseRevision ?? 0 },
  };
}

const cluster = (id, lastUpdatedAt = 1) => ({
  id,
  projectId: null,
  label: id,
  category: "topic",
  strength: 0.5,
  x: 0,
  y: 0,
  links: [],
  summary: id,
  mentionCount: 1,
  lastUpdatedAt,
  sources: [],
});

test("workspace router stores stripped blobs and returns hydrated snapshots", async () => {
  const { records, store } = createMemoryStore();
  const { conceptsByUser, calls, bridge } = createFakeOntology();
  const router = createVenomWorkspaceRouter({
    resolveUserId: (req) => req.headers["x-user"],
    parseBody: passthroughParseBody,
    store,
    ontology: bridge,
  });
  const { baseUrl, close } = await startServer(router);

  try {
    const state = {
      projects: [],
      clusters: [cluster("c1"), cluster("c2")],
      tombstones: { clusters: [] },
    };
    const saveResponse = await fetch(`${baseUrl}/venom/workspace`, {
      method: "PUT",
      headers: { "content-type": "application/json", "x-user": "user_a" },
      body: JSON.stringify({ state, baseRevision: 0 }),
    });
    assert.equal(saveResponse.status, 200);
    const saved = await saveResponse.json();

    // The blob record kept everything except knowledge.
    assert.deepEqual(records.get("user_a").state.clusters, []);
    // The response carries the absorbed knowledge back.
    assert.equal(saved.state.clusters.length, 2);
    assert.equal(saved.revision, 1);
    // ensureOwner ran before the save absorbed the state.
    assert.deepEqual(calls[0], ["ensureOwner", "user_a"]);
    assert.deepEqual(calls[1], ["absorb", "user_a"]);
    assert.equal(conceptsByUser.get("user_a").size, 2);

    // GET returns the stripped blob hydrated from the store.
    const getResponse = await fetch(`${baseUrl}/venom/workspace`, {
      headers: { "x-user": "user_a" },
    });
    const fetched = await getResponse.json();
    assert.equal(fetched.state.clusters.length, 2);
    assert.equal(fetched.revision, 1);
  } finally {
    await close();
  }
});

test("conflicting saves get a hydrated 409 snapshot and do not absorb", async () => {
  const { store } = createMemoryStore();
  const { conceptsByUser, calls, bridge } = createFakeOntology();
  const router = createVenomWorkspaceRouter({
    resolveUserId: (req) => req.headers["x-user"],
    parseBody: passthroughParseBody,
    store,
    ontology: bridge,
  });
  const { baseUrl, close } = await startServer(router);

  try {
    const baseState = { projects: [], clusters: [cluster("c1")], tombstones: {} };
    await fetch(`${baseUrl}/venom/workspace`, {
      method: "PUT",
      headers: { "content-type": "application/json", "x-user": "user_b" },
      body: JSON.stringify({ state: baseState, baseRevision: 0 }),
    });
    calls.length = 0;

    const staleResponse = await fetch(`${baseUrl}/venom/workspace`, {
      method: "PUT",
      headers: { "content-type": "application/json", "x-user": "user_b" },
      body: JSON.stringify({
        state: { projects: [], clusters: [cluster("c9")], tombstones: {} },
        baseRevision: 99,
      }),
    });
    assert.equal(staleResponse.status, 409);
    const conflict = await staleResponse.json();
    assert.equal(conflict.revision, 1);
    assert.deepEqual(
      conflict.state.clusters.map((entry) => entry.id),
      ["c1"],
    );
    // The stale save never reached the store.
    assert.equal(conceptsByUser.get("user_b").size, 1);
    assert.ok(!calls.some(([name]) => name === "absorb"));
  } finally {
    await close();
  }
});

test("knowledge no longer counts against the workspace size cap", async () => {
  const { store } = createMemoryStore();
  const { bridge } = createFakeOntology();
  const router = createVenomWorkspaceRouter({
    resolveUserId: (req) => req.headers["x-user"],
    parseBody: passthroughParseBody,
    store,
    ontology: bridge,
  });
  const { baseUrl, close } = await startServer(router);

  try {
    const bigText = "x".repeat(1900);
    const clusters = Array.from({ length: 2600 }, (_, index) => ({
      ...cluster(`c${index}`),
      summary: bigText,
    }));
    const state = { projects: [], clusters, tombstones: {} };
    // Sanity: this state would blow the 5 MiB cap without stripping.
    assert.ok(JSON.stringify(state).length > 5 * 1024 * 1024);

    const response = await fetch(`${baseUrl}/venom/workspace`, {
      method: "PUT",
      headers: { "content-type": "application/json", "x-user": "user_c" },
      body: JSON.stringify({ state, baseRevision: 0 }),
    });
    assert.equal(response.status, 200);
  } finally {
    await close();
  }
});

test("router without an ontology bridge behaves exactly as before", async () => {
  const { records, store } = createMemoryStore();
  const router = createVenomWorkspaceRouter({
    resolveUserId: (req) => req.headers["x-user"],
    parseBody: passthroughParseBody,
    store,
  });
  const { baseUrl, close } = await startServer(router);

  try {
    const state = { projects: [], clusters: [cluster("c1")], tombstones: {} };
    const response = await fetch(`${baseUrl}/venom/workspace`, {
      method: "PUT",
      headers: { "content-type": "application/json", "x-user": "user_d" },
      body: JSON.stringify({ state, baseRevision: 0 }),
    });
    const saved = await response.json();
    assert.equal(saved.state.clusters.length, 1);
    assert.equal(records.get("user_d").state.clusters.length, 1);
  } finally {
    await close();
  }
});
