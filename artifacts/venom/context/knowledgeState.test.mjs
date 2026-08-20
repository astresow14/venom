import assert from "node:assert/strict";
import test from "node:test";

import {
  applyKnowledgeInsightsToState,
  clearConversationKnowledge,
  deleteProjectKnowledge,
  hydrateVenomState,
} from "./knowledgeState.ts";

const project = (id) => ({
  id,
  name: id,
  description: "",
  accent: "#10b981",
  sourceCount: 0,
  updatedAt: 1,
  tasks: [],
});

const conversation = (id, projectId, messageId = `${id}-message`) => ({
  id,
  title: `${id} conversation`,
  projectId,
  updatedAt: 1,
  messages: [
    {
      id: messageId,
      role: "user",
      content: "Project knowledge",
      createdAt: 1,
      status: "sent",
    },
  ],
});

const insight = (label, sourceMessageId) => ({
  label,
  category: "topic",
  confidence: 0.9,
  summary: `${label} summary`,
  sourceMessageIds: [sourceMessageId],
  relatedLabels: [],
});

const apply = (state, currentConversation, insights) =>
  applyKnowledgeInsightsToState({
    state,
    conversation: currentConversation,
    insights,
    now: 100,
    generateId: (prefix) => `${prefix}-${state.clusters.length + 1}`,
  });

test("same-named clusters are isolated to their own projects", () => {
  const alphaConversation = conversation("alpha-conversation", "alpha");
  const betaConversation = conversation("beta-conversation", "beta");
  const initialState = {
    projects: [project("alpha"), project("beta")],
    conversations: [alphaConversation, betaConversation],
    clusters: [],
    activeProjectId: "alpha",
    activeConversationId: alphaConversation.id,
  };

  const withAlphaKnowledge = apply(initialState, alphaConversation, [
    insight("Roadmap", "alpha-conversation-message"),
  ]);
  const withBothProjects = apply(withAlphaKnowledge, betaConversation, [
    insight(" roadmap ", "beta-conversation-message"),
  ]);

  assert.equal(withBothProjects.clusters.length, 2);
  assert.deepEqual(
    withBothProjects.clusters.map((cluster) => cluster.projectId).sort(),
    ["alpha", "beta"],
  );
  assert.ok(
    withBothProjects.clusters.every(
      (cluster) =>
        cluster.sources.length === 1 &&
        cluster.sources[0].projectId === cluster.projectId,
    ),
  );
  assert.ok(
    withBothProjects.clusters.every((cluster) => cluster.links.length === 0),
  );
});

test("clearing conversations and deleting projects prune orphan knowledge", () => {
  const alphaConversation = conversation("alpha-conversation", "alpha");
  const betaConversation = conversation("beta-conversation", "beta");
  const seededState = apply(
    apply(
      {
        projects: [project("alpha"), project("beta")],
        conversations: [alphaConversation, betaConversation],
        clusters: [],
        activeProjectId: "alpha",
        activeConversationId: alphaConversation.id,
      },
      alphaConversation,
      [insight("Alpha plan", "alpha-conversation-message")],
    ),
    betaConversation,
    [insight("Beta plan", "beta-conversation-message")],
  );

  const afterClear = clearConversationKnowledge(
    seededState,
    alphaConversation.id,
  );
  assert.deepEqual(
    afterClear.clusters.map((cluster) => cluster.projectId),
    ["beta"],
  );
  assert.equal(
    afterClear.conversations.find((item) => item.id === alphaConversation.id)
      ?.messages.length,
    0,
  );

  const afterDelete = deleteProjectKnowledge(afterClear, "beta");
  assert.equal(afterDelete.projects.length, 1);
  assert.equal(afterDelete.conversations.length, 1);
  assert.equal(afterDelete.clusters.length, 0);
});

test("delayed extraction cannot restore sources removed by conversation cleanup", () => {
  const alphaConversation = conversation("alpha-conversation", "alpha");
  const initialState = {
    projects: [project("alpha")],
    conversations: [alphaConversation],
    clusters: [],
    activeProjectId: "alpha",
    activeConversationId: alphaConversation.id,
  };
  const clearedState = clearConversationKnowledge(
    initialState,
    alphaConversation.id,
  );

  const afterDelayedExtraction = apply(clearedState, alphaConversation, [
    insight("Resurrected plan", "alpha-conversation-message"),
  ]);

  assert.equal(afterDelayedExtraction.clusters.length, 0);
  assert.deepEqual(afterDelayedExtraction, clearedState);
});

test("delayed extraction cannot restore a deleted project", () => {
  const alphaConversation = conversation("alpha-conversation", "alpha");
  const initialState = {
    projects: [project("alpha")],
    conversations: [alphaConversation],
    clusters: [],
    activeProjectId: "alpha",
    activeConversationId: alphaConversation.id,
  };
  const deletedState = deleteProjectKnowledge(initialState, "alpha");

  const afterDelayedExtraction = apply(deletedState, alphaConversation, [
    insight("Resurrected project", "alpha-conversation-message"),
  ]);

  assert.equal(afterDelayedExtraction.projects.length, 0);
  assert.equal(afterDelayedExtraction.conversations.length, 0);
  assert.equal(afterDelayedExtraction.clusters.length, 0);
  assert.deepEqual(afterDelayedExtraction, deletedState);
});

test("hydration scopes legacy clusters to their live project conversations", () => {
  const alphaConversation = conversation("alpha-conversation", "alpha");
  const betaConversation = conversation("beta-conversation", "beta");
  const hydrated = hydrateVenomState({
    projects: [project("alpha"), project("beta")],
    conversations: [alphaConversation, betaConversation],
    clusters: [
      {
        id: "legacy-roadmap",
        label: "Roadmap",
        summary: "Legacy project context",
        sources: [
          {
            conversationId: alphaConversation.id,
            messageIds: ["alpha-conversation-message"],
          },
          {
            conversationId: betaConversation.id,
            messageIds: ["beta-conversation-message"],
          },
        ],
      },
    ],
  });

  assert.equal(hydrated.clusters?.length, 2);
  assert.deepEqual(
    hydrated.clusters?.map((cluster) => cluster.projectId).sort(),
    ["alpha", "beta"],
  );
  assert.ok(
    hydrated.clusters?.every((cluster) =>
      cluster.sources.every((source) => source.projectId === cluster.projectId),
    ),
  );
});
