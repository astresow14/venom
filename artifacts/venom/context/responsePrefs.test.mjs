import assert from "node:assert/strict";
import test from "node:test";

import {
  BLEND_TRIANGLE,
  EVEN_BLEND,
  describeBlend,
  favoredBlend,
  isResponseMode,
  mergeConversationResponsePrefs,
  normalizeConversationBlend,
  normalizeConversationResponsePrefs,
  normalizeWeights,
  nudgeWeights,
  pinToWeights,
  weightsToPin,
} from "./responsePrefs.ts";
import {
  createEmptyTombstones,
  mergeWorkspaceStates,
  normalizeWorkspaceState,
} from "./workspaceSync.ts";

const close = (a, b, eps = 1e-9) => Math.abs(a - b) < eps;

// ── Pad math ────────────────────────────────────────────────────────────────

test("centered pin reads as an even blend", () => {
  const centroid = {
    x: (BLEND_TRIANGLE[0].x + BLEND_TRIANGLE[1].x + BLEND_TRIANGLE[2].x) / 3,
    y: (BLEND_TRIANGLE[0].y + BLEND_TRIANGLE[1].y + BLEND_TRIANGLE[2].y) / 3,
  };
  const weights = pinToWeights(centroid);
  for (const weight of weights) assert.ok(close(weight, 1 / 3, 1e-6));
});

test("a corner pin gives that voice all the weight", () => {
  for (let corner = 0; corner < 3; corner += 1) {
    const weights = pinToWeights(BLEND_TRIANGLE[corner]);
    assert.ok(close(weights[corner], 1, 1e-6));
  }
});

test("pinToWeights and weightsToPin round-trip", () => {
  const cases = [[0.5, 0.3, 0.2], [0.1, 0.1, 0.8], EVEN_BLEND];
  for (const original of cases) {
    const back = pinToWeights(weightsToPin(original));
    for (let index = 0; index < 3; index += 1) {
      assert.ok(close(back[index], original[index], 1e-6), `case ${original}`);
    }
  }
});

test("points outside the triangle clamp to a valid blend", () => {
  const weights = pinToWeights({ x: -0.4, y: -0.4 });
  assert.ok(close(weights[0] + weights[1] + weights[2], 1));
  for (const weight of weights) assert.ok(weight >= 0 && weight <= 1);
});

test("normalizeWeights clamps, fills junk, and sums to one", () => {
  assert.deepEqual(normalizeWeights([0, 0, 0]), EVEN_BLEND);
  const weights = normalizeWeights([2, -1, Number.NaN]);
  assert.ok(close(weights[0], 1));
  assert.ok(close(weights[1], 0));
  assert.ok(close(weights[2], 0));
});

test("favoredBlend favors without silencing", () => {
  const weights = favoredBlend(1);
  assert.ok(close(weights[1], 0.7));
  assert.ok(close(weights[0], 0.15));
  assert.ok(close(weights[2], 0.15));
});

test("nudgeWeights moves toward the pushed corner and stays valid", () => {
  const weights = nudgeWeights(EVEN_BLEND, 0, -0.06);
  assert.ok(weights[0] > 1 / 3);
  assert.ok(close(weights[0] + weights[1] + weights[2], 1));
});

test("describeBlend announces even and favored states", () => {
  const names = ["GPT-5", "Claude", "Gemini"];
  assert.equal(
    describeBlend(EVEN_BLEND, names),
    "Even blend of GPT-5, Claude, Gemini",
  );
  const favored = describeBlend([0.7, 0.15, 0.15], names);
  assert.ok(favored.includes("GPT-5 70%"));
  assert.ok(favored.includes("Claude 15%"));
});

// ── Preference block validation ─────────────────────────────────────────────

test("isResponseMode accepts only the three modes", () => {
  assert.equal(isResponseMode("talk"), true);
  assert.equal(isResponseMode("verify"), true);
  assert.equal(isResponseMode("debate"), true);
  assert.equal(isResponseMode("shout"), false);
  assert.equal(isResponseMode(undefined), false);
});

test("normalizeConversationBlend rejects malformed blocks", () => {
  assert.equal(normalizeConversationBlend(undefined), undefined);
  assert.equal(
    normalizeConversationBlend({ corners: ["a", "b"], weights: [1, 0, 0] }),
    undefined,
  );
  assert.equal(
    normalizeConversationBlend({ corners: ["a", "a", "b"], weights: [1, 0, 0] }),
    undefined,
  );
  assert.equal(
    normalizeConversationBlend({ corners: ["a", "b", "c"], weights: [1, 0] }),
    undefined,
  );
  assert.equal(
    normalizeConversationBlend({ corners: ["a", "b", "c"], weights: [1, 0, "x"] }),
    undefined,
  );
});

test("normalizeConversationResponsePrefs strips junk and keeps valid blocks", () => {
  const junk = normalizeConversationResponsePrefs({
    id: "c1",
    responseMode: "shout",
    blend: { corners: ["a", "b"], weights: [1, 0, 0] },
    modeUpdatedAt: -5,
  });
  assert.equal(junk.responseMode, undefined);
  assert.equal(junk.blend, undefined);
  assert.equal(junk.modeUpdatedAt, undefined);

  const valid = normalizeConversationResponsePrefs({
    id: "c2",
    responseMode: "debate",
    blend: { corners: ["a", "b", "c"], weights: [0.25, 0.125, 0.125] },
    modeUpdatedAt: 40,
  });
  assert.equal(valid.responseMode, "debate");
  assert.ok(close(valid.blend.weights[0], 0.5));
  assert.equal(valid.modeUpdatedAt, 40);
});

test("mergeConversationResponsePrefs takes the newer block whole", () => {
  const base = { id: "c" };
  const cloud = {
    responseMode: "verify",
    blend: { corners: ["a", "b", "c"], weights: [0.5, 0.25, 0.25] },
    modeUpdatedAt: 200,
  };
  const device = { responseMode: "talk", modeUpdatedAt: 120 };
  const merged = mergeConversationResponsePrefs(base, cloud, device);
  assert.equal(merged.responseMode, "verify");
  assert.deepEqual(merged.blend.corners, ["a", "b", "c"]);
  assert.equal(merged.modeUpdatedAt, 200);

  // Tie keeps the device copy; a missing block ranks lowest.
  const tie = mergeConversationResponsePrefs(
    base,
    { responseMode: "verify", modeUpdatedAt: 150 },
    { responseMode: "debate", modeUpdatedAt: 150 },
  );
  assert.equal(tie.responseMode, "debate");
  const missing = mergeConversationResponsePrefs(base, undefined, {
    responseMode: "debate",
    modeUpdatedAt: 10,
  });
  assert.equal(missing.responseMode, "debate");
});

// ── Workspace-level integration ─────────────────────────────────────────────

function conversationWith(prefs = {}, extra = {}) {
  return {
    id: "conv-prefs",
    title: "Prefs",
    projectId: null,
    messages: [
      { id: "m1", role: "user", content: "hi", createdAt: 10, status: "sent" },
    ],
    createdAt: 5,
    updatedAt: 100,
    ...prefs,
    ...extra,
  };
}

function stateWithConversation(conversation) {
  return normalizeWorkspaceState({
    projects: [],
    conversations: [conversation],
    clusters: [],
    sources: [],
    activeProjectId: null,
    activeConversationId: conversation.id,
    tombstones: createEmptyTombstones(),
  });
}

test("normalizeWorkspaceState drops malformed response prefs", () => {
  const state = stateWithConversation(
    conversationWith({
      responseMode: "shout",
      blend: { corners: ["a", "b"], weights: [1, 0, 0] },
      modeUpdatedAt: -5,
    }),
  );
  const conv = state.conversations[0];
  assert.equal(conv.responseMode, undefined);
  assert.equal(conv.blend, undefined);
  assert.equal(conv.modeUpdatedAt, undefined);
});

test("normalizeWorkspaceState keeps valid response prefs and normalizes weights", () => {
  const state = stateWithConversation(
    conversationWith({
      responseMode: "debate",
      blend: { corners: ["a", "b", "c"], weights: [0.25, 0.125, 0.125] },
      modeUpdatedAt: 50,
    }),
  );
  const conv = state.conversations[0];
  assert.equal(conv.responseMode, "debate");
  assert.deepEqual(conv.blend.corners, ["a", "b", "c"]);
  assert.ok(close(conv.blend.weights[0], 0.5));
  assert.equal(conv.modeUpdatedAt, 50);
});

test("merge keeps the preference block with the newer modeUpdatedAt", () => {
  const cloud = stateWithConversation(
    conversationWith({
      responseMode: "verify",
      blend: { corners: ["a", "b", "c"], weights: [0.5, 0.25, 0.25] },
      modeUpdatedAt: 200,
    }),
  );
  // Device has newer chat content but an older preference change.
  const device = stateWithConversation(
    conversationWith(
      { responseMode: "talk", modeUpdatedAt: 120 },
      {
        updatedAt: 300,
        messages: [
          { id: "m1", role: "user", content: "hi", createdAt: 10, status: "sent" },
          { id: "m2", role: "assistant", content: "yo", createdAt: 20, status: "sent" },
        ],
      },
    ),
  );

  const merged = mergeWorkspaceStates(cloud, device);
  const conv = merged.conversations[0];
  // Newest content wins for messages…
  assert.equal(conv.messages.length, 2);
  // …but the cloud's newer preference block wins whole.
  assert.equal(conv.responseMode, "verify");
  assert.deepEqual(conv.blend.corners, ["a", "b", "c"]);
  assert.equal(conv.modeUpdatedAt, 200);
});

test("merge tie on modeUpdatedAt keeps the device preference block", () => {
  const cloud = stateWithConversation(
    conversationWith({ responseMode: "verify", modeUpdatedAt: 150 }),
  );
  const device = stateWithConversation(
    conversationWith({ responseMode: "debate", modeUpdatedAt: 150 }),
  );
  const merged = mergeWorkspaceStates(cloud, device);
  assert.equal(merged.conversations[0].responseMode, "debate");
});

test("merge treats a missing preference block as oldest", () => {
  const cloud = stateWithConversation(conversationWith());
  const device = stateWithConversation(
    conversationWith({ responseMode: "debate", modeUpdatedAt: 10 }),
  );
  const merged = mergeWorkspaceStates(cloud, device);
  assert.equal(merged.conversations[0].responseMode, "debate");

  // And the reverse: a device without prefs loses to a cloud with them.
  const merged2 = mergeWorkspaceStates(device, cloud);
  assert.equal(merged2.conversations[0].responseMode, "debate");
});

test("speaker fields on messages survive the cross-device merge", () => {
  const turn = {
    id: "m-turn",
    role: "assistant",
    content: "point taken",
    createdAt: 30,
    status: "sent",
    speakerId: "voice-a",
    speakerName: "First take",
    modelId: "venom-gpt",
    modelName: "GPT-5",
  };
  const cloud = stateWithConversation(
    conversationWith({}, { messages: [turn], updatedAt: 400 }),
  );
  const device = stateWithConversation(conversationWith());
  const merged = mergeWorkspaceStates(cloud, device);
  const kept = merged.conversations[0].messages.find(
    (message) => message.id === "m-turn",
  );
  assert.ok(kept, "debate turn should survive the merge");
  assert.equal(kept.speakerId, "voice-a");
  assert.equal(kept.speakerName, "First take");
});
