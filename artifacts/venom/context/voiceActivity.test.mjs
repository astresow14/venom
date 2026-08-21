import assert from "node:assert/strict";
import test from "node:test";

import {
  createSpeechDetector,
  DEFAULT_SPEECH_DETECTOR_OPTIONS,
} from "./voiceActivity.ts";

const QUIET = 0.0;
const LOUD = 0.5;

/** Feeds a constant level every `stepMs` from `fromMs` to `toMs` inclusive. */
function feed(detector, level, fromMs, toMs, stepMs = 50) {
  const events = [];
  for (let at = fromMs; at <= toMs; at += stepMs) {
    const event = detector.push(level, at);
    if (event !== "none") events.push({ event, at });
  }
  return events;
}

test("speech starts only after sustained loudness", () => {
  const detector = createSpeechDetector();

  // A single loud blip is not speech.
  assert.equal(detector.push(LOUD, 0), "none");
  assert.equal(detector.push(QUIET, 50), "none");
  assert.equal(detector.state(), "idle");

  // Sustained loudness crosses minSpeechMs and starts the utterance.
  const events = feed(detector, LOUD, 100, 400);
  assert.equal(events.length, 1);
  assert.equal(events[0].event, "speech-start");
  assert.ok(
    events[0].at - 100 >= DEFAULT_SPEECH_DETECTOR_OPTIONS.minSpeechMs,
    "start waits for the minimum speech duration",
  );
  assert.equal(detector.state(), "speaking");
});

test("silence ends the utterance after endSilenceMs", () => {
  const detector = createSpeechDetector();
  feed(detector, LOUD, 0, 300);
  assert.equal(detector.state(), "speaking");

  const events = feed(detector, QUIET, 350, 2000);
  assert.equal(events.length, 1);
  assert.equal(events[0].event, "speech-end");
  assert.ok(
    events[0].at >= 300 + DEFAULT_SPEECH_DETECTOR_OPTIONS.endSilenceMs,
    "end waits out the silence window",
  );
  assert.equal(detector.state(), "idle");
});

test("trailing-off speech is held by hysteresis, not clipped", () => {
  const detector = createSpeechDetector();
  feed(detector, LOUD, 0, 300);

  // Levels below the start threshold but above the hold threshold (60%)
  // keep the utterance alive indefinitely.
  const hold = detector.speechThreshold() * 0.8;
  const events = feed(detector, hold, 350, 3000);
  assert.equal(events.length, 0);
  assert.equal(detector.state(), "speaking");
});

test("an utterance is force-ended at maxUtteranceMs", () => {
  const detector = createSpeechDetector({ maxUtteranceMs: 5_000 });
  feed(detector, LOUD, 0, 300);

  const events = feed(detector, LOUD, 350, 6_000);
  assert.equal(events[0].event, "speech-end");
  assert.ok(events[0].at >= 5_000, "cap only fires at the limit");
  // The user is still talking, so a fresh utterance begins right after —
  // exactly what hands-free turn-taking wants.
  assert.deepEqual(
    events.slice(1).map((entry) => entry.event),
    ["speech-start"],
  );
});

test("the noise floor adapts so a loud room raises the threshold", () => {
  const detector = createSpeechDetector();
  const initialThreshold = detector.speechThreshold();

  // A noisy room hums just under the initial threshold for a while.
  feed(detector, 0.04, 0, 3_000);
  assert.ok(
    detector.speechThreshold() > initialThreshold,
    "threshold rises with ambient noise",
  );
  // A level that would start speech in a quiet room no longer does.
  assert.equal(detector.push(0.08, 3_050), "none");
  assert.equal(detector.state(), "idle");
});

test("speech itself never raises the noise floor", () => {
  const detector = createSpeechDetector();
  const before = detector.speechThreshold();
  feed(detector, LOUD, 0, 2_000);
  assert.equal(detector.speechThreshold(), before);
});

test("reset abandons an in-flight utterance", () => {
  const detector = createSpeechDetector();
  feed(detector, LOUD, 0, 300);
  assert.equal(detector.state(), "speaking");

  detector.reset();
  assert.equal(detector.state(), "idle");
  // No stray speech-end fires after a reset; silence is just silence.
  const events = feed(detector, QUIET, 350, 2_000);
  assert.equal(events.length, 0);
});

test("garbage levels are clamped instead of crashing detection", () => {
  const detector = createSpeechDetector();
  assert.equal(detector.push(Number.NaN, 0), "none");
  assert.equal(detector.push(-5, 50), "none");
  assert.equal(detector.push(99, 100), "none"); // clamps to 1 → maybe-speech
  const events = feed(detector, 1, 150, 400);
  assert.equal(events.length, 1);
  assert.equal(events[0].event, "speech-start");
});
