/**
 * voiceRestraint.test.mjs — the outcome tracker and talkativeness copy.
 *
 * The tracker is the client half of the decision-logging loop: every server
 * decision must settle into exactly one outcome, resolved lazily from events
 * and timestamps (no timers). These tests drive it with explicit clocks.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  createVoiceOutcomeTracker,
  DECISION_OVERLAP_GRACE_MS,
  DECISION_REQUEST_TIMEOUT_MS,
  FOLLOW_UP_WINDOW_MS,
  resolveDecisionGraceMs,
  resolveDecisionRequestTimeoutMs,
  resolveWindDownDelayMs,
  TALKATIVENESS_OPTIONS,
  talkativenessOption,
  WIND_DOWN_CLOSE_DELAY_MS,
} from "./voiceRestraint.ts";

/** Collects (decisionId, outcome) pairs the tracker reports. */
function harness() {
  const reported = [];
  const tracker = createVoiceOutcomeTracker((decisionId, outcome) => {
    reported.push({ decisionId, outcome });
  });
  return { tracker, reported };
}

// ── Spoken decisions ─────────────────────────────────────────────────────────

test("a respond decision settles when the reply plays out", () => {
  const { tracker, reported } = harness();
  tracker.register("d1", "respond", 1_000);
  assert.equal(tracker.hasPending(), true);
  tracker.replyCompleted();
  assert.deepEqual(reported, [{ decisionId: "d1", outcome: "reply_completed" }]);
  assert.equal(tracker.hasPending(), false);
});

test("an interrupted reply reports reply_interrupted exactly once", () => {
  const { tracker, reported } = harness();
  tracker.register("d1", "respond", 1_000);
  tracker.replyInterrupted();
  // finalize() still calls replyCompleted afterwards — must be a no-op.
  tracker.replyCompleted();
  assert.deepEqual(reported, [
    { decisionId: "d1", outcome: "reply_interrupted" },
  ]);
});

test("acknowledgments settle like replies", () => {
  const { tracker, reported } = harness();
  tracker.register("d1", "acknowledge", 1_000);
  tracker.replyCompleted();
  assert.deepEqual(reported, [{ decisionId: "d1", outcome: "reply_completed" }]);
});

// ── Quiet decisions and the follow-up window ────────────────────────────────

test("silence followed by quick re-engagement reads as user_followed_up", () => {
  const { tracker, reported } = harness();
  tracker.register("d1", "silent", 1_000);
  // Reply events must never settle a silent decision.
  tracker.replyCompleted();
  assert.deepEqual(reported, []);
  tracker.userSpoke(1_000 + FOLLOW_UP_WINDOW_MS);
  assert.deepEqual(reported, [
    { decisionId: "d1", outcome: "user_followed_up" },
  ]);
});

test("silence that outlives the window reads as stayed_quiet", () => {
  const { tracker, reported } = harness();
  tracker.register("d1", "silent", 1_000);
  tracker.userSpoke(1_000 + FOLLOW_UP_WINDOW_MS + 1);
  assert.deepEqual(reported, [{ decisionId: "d1", outcome: "stayed_quiet" }]);
});

test("a new decision settles the quiet one still waiting", () => {
  const { tracker, reported } = harness();
  tracker.register("d1", "silent", 1_000);
  tracker.register("d2", "respond", 2_000);
  assert.deepEqual(reported, [
    { decisionId: "d1", outcome: "user_followed_up" },
  ]);
  tracker.replyCompleted();
  assert.deepEqual(reported, [
    { decisionId: "d1", outcome: "user_followed_up" },
    { decisionId: "d2", outcome: "reply_completed" },
  ]);
});

test("a respond decision abandoned by the stream settles on the next turn", () => {
  const { tracker, reported } = harness();
  tracker.register("d1", "respond", 1_000);
  // No replyCompleted/App interrupted — the turn just moved on.
  tracker.register("d2", "respond", 5_000);
  assert.deepEqual(reported, [
    { decisionId: "d1", outcome: "user_followed_up" },
  ]);
});

// ── Session endings ──────────────────────────────────────────────────────────

test("the wind-down timer closing the session reports wound_down", () => {
  const { tracker, reported } = harness();
  tracker.register("d1", "acknowledge", 1_000);
  tracker.replyCompleted();
  tracker.register("d2", "silent", 2_000);
  tracker.woundDown();
  tracker.sessionClosed(20_000);
  assert.deepEqual(reported, [
    { decisionId: "d1", outcome: "reply_completed" },
    { decisionId: "d2", outcome: "wound_down" },
  ]);
});

test("closing the session settles a pending decision as session_closed", () => {
  const { tracker, reported } = harness();
  tracker.register("d1", "respond", 1_000);
  tracker.sessionClosed(2_000);
  assert.deepEqual(reported, [{ decisionId: "d1", outcome: "session_closed" }]);
});

test("a quiet decision that already proved itself closes as stayed_quiet", () => {
  const { tracker, reported } = harness();
  tracker.register("d1", "silent", 1_000);
  tracker.sessionClosed(1_000 + FOLLOW_UP_WINDOW_MS + 1);
  assert.deepEqual(reported, [{ decisionId: "d1", outcome: "stayed_quiet" }]);
});

test("nothing is reported when nothing is pending", () => {
  const { tracker, reported } = harness();
  tracker.userSpoke(1_000);
  tracker.replyCompleted();
  tracker.replyInterrupted();
  tracker.woundDown();
  tracker.sessionClosed(2_000);
  assert.deepEqual(reported, []);
  assert.equal(tracker.hasPending(), false);
});

// ── Talkativeness copy & wind-down timing ────────────────────────────────────

test("talkativeness options are ordered chatty → reserved with copy", () => {
  assert.deepEqual(
    TALKATIVENESS_OPTIONS.map((option) => option.id),
    ["chatty", "balanced", "reserved"],
  );
  for (const option of TALKATIVENESS_OPTIONS) {
    assert.ok(option.label.length > 0);
    assert.ok(option.description.length > 0);
    assert.equal(talkativenessOption(option.id), option);
  }
  // Unknown ids land on balanced — the safe middle.
  assert.equal(talkativenessOption(undefined).id, "balanced");
  assert.equal(talkativenessOption("verbose").id, "balanced");
});

test("wind-down delay defaults sensibly outside a browser", () => {
  assert.equal(resolveWindDownDelayMs(), WIND_DOWN_CLOSE_DELAY_MS);
  assert.ok(WIND_DOWN_CLOSE_DELAY_MS > FOLLOW_UP_WINDOW_MS / 4);
});

// ── Decision-overlap grace ───────────────────────────────────────────────────

test("decision grace is tight in production and serialized for UI tests", () => {
  // Without a window (native / node): production overlaps quickly…
  assert.equal(resolveDecisionGraceMs(false), DECISION_OVERLAP_GRACE_MS);
  assert.ok(DECISION_OVERLAP_GRACE_MS > 0 && DECISION_OVERLAP_GRACE_MS < 1_000);
  // …while UI-test builds wait beyond the decide call's own 4s abort, so
  // stubbed (instant) decides always keep the serialized flow and a slow
  // runner can't flip restraint specs onto the optimistic path.
  assert.ok(resolveDecisionGraceMs(true) > 4_000);
});

test("a window override pins the decision grace exactly", () => {
  globalThis.window = { __venomVoiceDecideGraceMs: 0 };
  try {
    // 0 forces the optimistic path even where the default serializes.
    assert.equal(resolveDecisionGraceMs(true), 0);
    globalThis.window.__venomVoiceDecideGraceMs = 125;
    assert.equal(resolveDecisionGraceMs(false), 125);
    // Nonsense values fall back to the defaults.
    globalThis.window.__venomVoiceDecideGraceMs = -1;
    assert.equal(resolveDecisionGraceMs(false), DECISION_OVERLAP_GRACE_MS);
  } finally {
    delete globalThis.window;
  }
});

test("the decide request budget honors only sane overrides", () => {
  assert.equal(resolveDecisionRequestTimeoutMs(), DECISION_REQUEST_TIMEOUT_MS);
  globalThis.window = { __venomVoiceDecideTimeoutMs: 30_000 };
  try {
    assert.equal(resolveDecisionRequestTimeoutMs(), 30_000);
    // A zero or negative budget would abort every decide instantly and turn
    // the restraint layer into a no-op — such overrides are ignored.
    globalThis.window.__venomVoiceDecideTimeoutMs = 0;
    assert.equal(resolveDecisionRequestTimeoutMs(), DECISION_REQUEST_TIMEOUT_MS);
    globalThis.window.__venomVoiceDecideTimeoutMs = -500;
    assert.equal(resolveDecisionRequestTimeoutMs(), DECISION_REQUEST_TIMEOUT_MS);
  } finally {
    delete globalThis.window;
  }
});
