import assert from "node:assert/strict";
import test from "node:test";

import {
  applyKnowledgeInsightsToState,
  knowledgeDisplayText,
  clearConversationKnowledge,
  deleteProjectKnowledge,
  fileKnowledgeNoteToState,
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

test("filing a note is atomic, project-scoped, and preserves chat selection", () => {
  const alphaChat = conversation("alpha-chat", "alpha");
  const betaChat = conversation("beta-chat", "beta");
  const initialState = {
    projects: [project("alpha"), project("beta")],
    conversations: [alphaChat, betaChat],
    clusters: [],
    activeProjectId: "alpha",
    activeConversationId: alphaChat.id,
  };
  let idCounter = 0;

  const result = fileKnowledgeNoteToState({
    state: initialState,
    projectId: "beta",
    note: "  Ship the beta release after accessibility review.  ",
    insights: [
      {
        ...insight("Accessibility review", "temporary-source"),
        sourceMessageIds: ["temporary-source"],
      },
    ],
    now: 200,
    generateId: (prefix) => `${prefix}-${++idCounter}`,
  });

  assert.equal(result.status, "filed");
  assert.equal(result.state.activeProjectId, "alpha");
  assert.equal(result.state.activeConversationId, alphaChat.id);
  assert.equal(result.state.clusters.length, 1);
  assert.equal(result.state.clusters[0].projectId, "beta");

  const noteConversation = result.state.conversations.find(
    (item) => item.title === "Captured note",
  );
  assert.ok(noteConversation);
  assert.equal(noteConversation.projectId, "beta");
  assert.equal(
    noteConversation.messages[0].content,
    "Ship the beta release after accessibility review.",
  );
  assert.deepEqual(result.state.clusters[0].sources[0].messageIds, [
    noteConversation.messages[0].id,
  ]);
  assert.equal(
    result.state.clusters[0].sources[0].conversationId,
    noteConversation.id,
  );
});

test("note filing rejects missing projects and no-concept results without residue", () => {
  const initialState = {
    projects: [project("alpha")],
    conversations: [conversation("alpha-chat", "alpha")],
    clusters: [],
    activeProjectId: "alpha",
    activeConversationId: "alpha-chat",
  };
  const options = {
    state: initialState,
    note: "A durable note",
    now: 200,
    generateId: (prefix) => `${prefix}-unused`,
  };

  const missingProject = fileKnowledgeNoteToState({
    ...options,
    projectId: "deleted",
    insights: [insight("Plan", "temporary-source")],
  });
  assert.equal(missingProject.status, "project_unavailable");
  assert.strictEqual(missingProject.state, initialState);

  const noConcepts = fileKnowledgeNoteToState({
    ...options,
    projectId: "alpha",
    insights: [],
  });
  assert.equal(noConcepts.status, "no_concepts");
  assert.strictEqual(noConcepts.state, initialState);
});

test("filing a duplicate concept updates only the initiating project", () => {
  const alphaChat = conversation("alpha-chat", "alpha");
  const betaChat = conversation("beta-chat", "beta");
  const seededState = apply(
    apply(
      {
        projects: [project("alpha"), project("beta")],
        conversations: [alphaChat, betaChat],
        clusters: [],
        activeProjectId: "alpha",
        activeConversationId: alphaChat.id,
      },
      alphaChat,
      [insight("Roadmap", "alpha-chat-message")],
    ),
    betaChat,
    [insight("Roadmap", "beta-chat-message")],
  );

  const result = fileKnowledgeNoteToState({
    state: seededState,
    projectId: "beta",
    note: "The roadmap now prioritizes the mobile release.",
    insights: [insight("Roadmap", "temporary-source")],
    now: 300,
    generateId: (prefix) => `${prefix}-new`,
  });

  assert.equal(result.status, "filed");
  const alphaRoadmap = result.state.clusters.find(
    (cluster) => cluster.projectId === "alpha",
  );
  const betaRoadmap = result.state.clusters.find(
    (cluster) => cluster.projectId === "beta",
  );
  assert.equal(alphaRoadmap.mentionCount, 1);
  assert.equal(betaRoadmap.mentionCount, 2);
  assert.equal(betaRoadmap.sources.length, 2);
});

const citation = (overrides) => ({
  id: "cite_live",
  provider: "github",
  kind: "issue",
  title: "Drawer stays open",
  url: "https://github.com/acme/venom/issues/12",
  excerpt: "Drawer stays open on mobile.",
  reference: "acme/venom#12",
  ...overrides,
});

test("Brain note text names its live sources instead of raw markers", () => {
  const lookup = {
    citationsById: new Map([["cite_live", citation()]]),
    archivedById: new Map(),
  };

  assert.equal(
    knowledgeDisplayText(
      "The release is blocked by [source:cite_live] until Friday.",
      lookup,
    ),
    "The release is blocked by Drawer stays open until Friday.",
  );
});

test("Brain note text reads disconnected sources as archived references", () => {
  const archivedLookup = {
    citationsById: new Map(),
    archivedById: new Map([
      [
        "cite_gone",
        {
          id: "cite_gone",
          title: "Closed pull request",
          url: "https://github.com/acme/venom/pull/4",
          retiredAt: 10,
        },
      ],
    ]),
  };

  assert.equal(
    knowledgeDisplayText("Shipped in [source:cite_gone].", archivedLookup),
    "Shipped in Closed pull request (archived).",
  );
  assert.equal(
    knowledgeDisplayText("Shipped in [source:cite_unknown].", {
      citationsById: new Map(),
    }),
    "Shipped in (archived source).",
  );
});

test("Brain note text never shows a raw source marker", () => {
  const withoutLookup = knowledgeDisplayText(
    "Blocked by [source:cite_live] and [source:cite_gone], see [source:cite",
  );

  assert.ok(!withoutLookup.includes("[source:"));
  assert.equal(withoutLookup, "Blocked by (archived source) and (archived source), see");
  assert.equal(knowledgeDisplayText(""), "");
});
