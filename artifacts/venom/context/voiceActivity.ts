/**
 * voiceActivity.ts — pure end-of-speech detection for hands-free voice chat.
 *
 * Consumes a stream of (level, timestamp) samples from any audio backend and
 * decides when an utterance starts and ends. No audio APIs, no timers of its
 * own — fully deterministic and unit-testable.
 *
 * The detector keeps an ambient-noise floor (EMA of quiet samples) so the
 * speech threshold adapts to the room. Hysteresis: ending an utterance uses a
 * lower threshold than starting one, so trailing-off speech is not clipped.
 */

export type SpeechDetectorOptions = {
  /** Absolute minimum level that can ever count as speech (0..1). */
  minSpeechLevel?: number;
  /** Speech threshold = max(minSpeechLevel, noiseFloor * noiseMultiplier). */
  noiseMultiplier?: number;
  /** Sustained loudness for this long before an utterance starts. */
  minSpeechMs?: number;
  /** Silence for this long ends the utterance. */
  endSilenceMs?: number;
  /** Hard cap on utterance length; ends it even if the user keeps talking. */
  maxUtteranceMs?: number;
};

export type SpeechDetectorState = 'idle' | 'maybe-speech' | 'speaking';
export type SpeechDetectorEvent = 'none' | 'speech-start' | 'speech-end';

export type SpeechDetector = {
  /** Feed one level sample; returns the transition it caused, if any. */
  push(level: number, atMs: number): SpeechDetectorEvent;
  /** Forget any in-flight utterance (used when capture pauses). */
  reset(): void;
  state(): SpeechDetectorState;
  /** Current adaptive speech threshold — exposed for tuning and tests. */
  speechThreshold(): number;
};

export const DEFAULT_SPEECH_DETECTOR_OPTIONS: Required<SpeechDetectorOptions> =
  {
    minSpeechLevel: 0.045,
    noiseMultiplier: 2.8,
    minSpeechMs: 180,
    endSilenceMs: 900,
    maxUtteranceMs: 45_000,
  };

export function createSpeechDetector(
  options: SpeechDetectorOptions = {},
): SpeechDetector {
  const opts = { ...DEFAULT_SPEECH_DETECTOR_OPTIONS, ...options };

  let state: SpeechDetectorState = 'idle';
  let noiseFloor = 0.01;
  let candidateSince = 0;
  let speechStartAt = 0;
  let lastVoiceAt = 0;

  const speechThreshold = () =>
    Math.max(opts.minSpeechLevel, noiseFloor * opts.noiseMultiplier);
  // Hysteresis: once speaking, quieter audio still counts as voice.
  const holdThreshold = () => speechThreshold() * 0.6;

  const updateNoiseFloor = (level: number) => {
    // Only quiet samples teach the floor, so speech cannot raise it.
    if (level < speechThreshold()) {
      noiseFloor = Math.max(0.004, noiseFloor * 0.95 + level * 0.05);
    }
  };

  return {
    push(level: number, atMs: number): SpeechDetectorEvent {
      const clamped = Number.isFinite(level) ? Math.max(0, Math.min(1, level)) : 0;

      if (state === 'idle') {
        if (clamped >= speechThreshold()) {
          state = 'maybe-speech';
          candidateSince = atMs;
        } else {
          updateNoiseFloor(clamped);
        }
        return 'none';
      }

      if (state === 'maybe-speech') {
        if (clamped < speechThreshold()) {
          state = 'idle';
          updateNoiseFloor(clamped);
          return 'none';
        }
        if (atMs - candidateSince >= opts.minSpeechMs) {
          state = 'speaking';
          speechStartAt = candidateSince;
          lastVoiceAt = atMs;
          return 'speech-start';
        }
        return 'none';
      }

      // speaking
      if (clamped >= holdThreshold()) {
        lastVoiceAt = atMs;
      }
      if (
        atMs - lastVoiceAt >= opts.endSilenceMs ||
        atMs - speechStartAt >= opts.maxUtteranceMs
      ) {
        state = 'idle';
        return 'speech-end';
      }
      return 'none';
    },
    reset() {
      state = 'idle';
      candidateSince = 0;
      speechStartAt = 0;
      lastVoiceAt = 0;
    },
    state: () => state,
    speechThreshold,
  };
}
