import assert from "node:assert/strict";
import test from "node:test";

import {
  BRAIN_NOTE_DRAFT_TTL_MS,
  BrainNoteDraftPersistenceQueue,
  brainNoteDraftStorageKey,
  parseStoredBrainNoteDraft,
  sanitizeBrainNoteDraft,
} from "./brainNoteDraft.ts";

test("draft storage keys isolate accounts and projects", () => {
  const alpha = brainNoteDraftStorageKey("user-alpha", "project-one");
  assert.notEqual(alpha, brainNoteDraftStorageKey("user-beta", "project-one"));
  assert.notEqual(alpha, brainNoteDraftStorageKey("user-alpha", "project-two"));
});

test("drafts are bounded and malformed selection falls back to original", () => {
  const draft = sanitizeBrainNoteDraft({
    originalDraft: "x".repeat(5100),
    suggestedDraft: "",
    changeNotes: Array.from(
      { length: 8 },
      (_, index) => `${index}-${"y".repeat(200)}`,
    ),
    selectedVersion: "suggestion",
  });

  assert.equal(draft.originalDraft.length, 5000);
  assert.equal(draft.changeNotes.length, 6);
  assert.equal(draft.changeNotes[0].length, 160);
  assert.equal(draft.selectedVersion, "original");
});

test("stored drafts expire after seven days", () => {
  const now = 1_000_000_000;
  const stored = (updatedAt) =>
    JSON.stringify({
      version: 1,
      updatedAt,
      draft: {
        originalDraft: "A recoverable note",
        suggestedDraft: "",
        changeNotes: [],
        selectedVersion: "original",
      },
    });

  assert.equal(
    parseStoredBrainNoteDraft(stored(now - BRAIN_NOTE_DRAFT_TTL_MS), now)
      .originalDraft,
    "A recoverable note",
  );
  assert.equal(
    parseStoredBrainNoteDraft(stored(now - BRAIN_NOTE_DRAFT_TTL_MS - 1), now),
    null,
  );
});

test("successful filing waits for pending saves and rejects later saves", async () => {
  const queue = new BrainNoteDraftPersistenceQueue();
  const events = [];
  let releaseSave;
  let markSaveStarted;
  const saveCanFinish = new Promise((resolve) => {
    releaseSave = resolve;
  });
  const saveStarted = new Promise((resolve) => {
    markSaveStarted = resolve;
  });
  const firstSave = queue.enqueue(async () => {
    events.push("save-started");
    markSaveStarted();
    await saveCanFinish;
    events.push("save-finished");
  });
  await saveStarted;

  const finish = queue.finish(async () => {
    events.push("cleared");
  });
  await queue.enqueue(async () => {
    events.push("late-save");
  });
  releaseSave();
  await Promise.all([firstSave, finish]);

  assert.deepEqual(events, ["save-started", "save-finished", "cleared"]);
});
