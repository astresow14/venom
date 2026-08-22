/**
 * venom-conversation-read.test.ts
 *
 * The per-conversation GET serves cited conversations out of the stored
 * workspace snapshot for read-only viewing. These tests pin the lookup's
 * contract: exact response shape, unknown fields dropped, malformed legacy
 * entries degraded instead of crashing, and project names resolved from the
 * same snapshot.
 *
 * Bundled via esbuild + node --test.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readWorkspaceConversation } from "./venom-conversation-read";

const message = (
  id: string,
  role: string,
  content: string,
  overrides: Record<string, unknown> = {},
) => ({
  id,
  role,
  content,
  createdAt: 1_000,
  status: "sent",
  ...overrides,
});

const snapshot = (overrides: Record<string, unknown> = {}) => ({
  projects: [
    { id: "p1", name: "Beyond Ops" },
    { id: "p2", name: "Side Quest" },
  ],
  conversations: [
    {
      id: "conv_cited",
      title: "Supplier review",
      projectId: "p1",
      updatedAt: 5_000,
      messages: [
        message("m1", "user", "Where did the Acme renewal land?"),
        message("m2", "assistant", "March, with a 12% uplift cap.", {
          modelName: "Claude",
          speakerId: "voice_1",
          speakerName: "The Analyst",
        }),
      ],
    },
  ],
  clusters: [],
  ...overrides,
});

describe("readWorkspaceConversation", () => {
  it("returns the conversation with its project name, exact shape", () => {
    const read = readWorkspaceConversation(snapshot(), "conv_cited");
    assert.deepEqual(read, {
      conversation: {
        id: "conv_cited",
        title: "Supplier review",
        projectId: "p1",
        updatedAt: 5_000,
        messages: [
          {
            id: "m1",
            role: "user",
            content: "Where did the Acme renewal land?",
            createdAt: 1_000,
            status: "sent",
          },
          {
            id: "m2",
            role: "assistant",
            content: "March, with a 12% uplift cap.",
            createdAt: 1_000,
            status: "sent",
            modelName: "Claude",
            speakerId: "voice_1",
            speakerName: "The Analyst",
          },
        ],
      },
      projectName: "Beyond Ops",
    });
  });

  it("misses cleanly: unknown id, empty snapshot, malformed state", () => {
    assert.equal(readWorkspaceConversation(snapshot(), "conv_other"), null);
    assert.equal(readWorkspaceConversation({}, "conv_cited"), null);
    assert.equal(readWorkspaceConversation(null, "conv_cited"), null);
    assert.equal(readWorkspaceConversation("blob", "conv_cited"), null);
    assert.equal(
      readWorkspaceConversation({ conversations: "nope" }, "conv_cited"),
      null,
    );
    assert.equal(
      readWorkspaceConversation({ conversations: [null, 4] }, "conv_cited"),
      null,
    );
  });

  it("drops unknown fields so the response matches the contract", () => {
    const state = snapshot();
    const conversation = state.conversations[0] as Record<string, unknown>;
    conversation.responseMode = "debate";
    conversation.blend = { weights: [] };
    conversation.legacyJunk = { huge: true };
    const messages = conversation.messages as Record<string, unknown>[];
    messages[1].deliberation = { stages: ["big"] };
    messages[1].modelId = "claude";

    const read = readWorkspaceConversation(state, "conv_cited");
    assert.ok(read);
    assert.deepEqual(Object.keys(read.conversation).sort(), [
      "id",
      "messages",
      "projectId",
      "title",
      "updatedAt",
    ]);
    assert.deepEqual(Object.keys(read.conversation.messages[1]).sort(), [
      "content",
      "createdAt",
      "id",
      "modelName",
      "role",
      "speakerId",
      "speakerName",
      "status",
    ]);
  });

  it("degrades malformed legacy entries instead of failing the read", () => {
    const read = readWorkspaceConversation(
      snapshot({
        conversations: [
          {
            id: "conv_legacy",
            title: "",
            projectId: 7,
            updatedAt: "yesterday",
            messages: [
              message("m_ok", "assistant", "Still readable."),
              message("m_bad_role", "system", "dropped"),
              message("", "user", "dropped: empty id"),
              { id: "m_no_content", role: "user", createdAt: 1 },
              "not a message",
              message("m_bad_status", "user", "status defaults", {
                status: "streaming",
                createdAt: -5,
              }),
            ],
          },
        ],
      }),
      "conv_legacy",
    );
    assert.ok(read);
    assert.equal(read.conversation.title, "Untitled conversation");
    assert.equal(read.conversation.projectId, null);
    assert.equal(read.conversation.updatedAt, 0);
    assert.equal(read.projectName, null);
    assert.deepEqual(
      read.conversation.messages.map((entry) => entry.id),
      ["m_ok", "m_bad_status"],
    );
    assert.equal(read.conversation.messages[1].status, "sent");
    assert.equal(read.conversation.messages[1].createdAt, 0);
  });

  it("resolves projectName null when the project is gone from the snapshot", () => {
    const read = readWorkspaceConversation(
      snapshot({ projects: [{ id: "p_other", name: "Elsewhere" }] }),
      "conv_cited",
    );
    assert.ok(read);
    assert.equal(read.conversation.projectId, "p1");
    assert.equal(read.projectName, null);
  });

  it("bounds oversized strings and keeps only the newest 1000 messages", () => {
    const read = readWorkspaceConversation(
      snapshot({
        projects: [{ id: "p1", name: "N".repeat(300) }],
        conversations: [
          {
            id: "conv_cited",
            title: "T".repeat(300),
            projectId: "p1",
            updatedAt: 5_000,
            messages: Array.from({ length: 1_050 }, (_, index) =>
              message(`m${index}`, "user", "x".repeat(50_100)),
            ),
          },
        ],
      }),
      "conv_cited",
    );
    assert.ok(read);
    assert.equal(read.conversation.title.length, 200);
    assert.equal(read.projectName?.length, 200);
    assert.equal(read.conversation.messages.length, 1_000);
    assert.equal(read.conversation.messages[0].id, "m50");
    assert.equal(read.conversation.messages[0].content.length, 50_000);
  });
});
