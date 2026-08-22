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
 *
 * Ducking window (hands-free barge-in): while assistant audio plays, capture
 * stays hot and the backend reports the current playback level via
 * setDucking(). Speech must then also clear a gate scaled from that level,
 * so residual speaker bleed the echo canceller lets through cannot start an
 * utterance — but sustained real speech over the reply still can. While
 * ducked, the noise-floor adaptation judges "quiet" against the un-ducked
 * threshold: bleed-band samples never teach the floor, so a long reply
 * cannot deafen the detector for the turns after it.
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
  /**
   * Fraction of the start threshold that still counts as speech after an
   * utterance has begun. Lower values preserve quiet trailing syllables;
   * higher values release noisy native microphones more promptly.
   */
  holdMultiplier?: number;
  /** Hard cap on utterance length; ends it even if the user keeps talking. */
  maxUtteranceMs?: number;
  /**
   * Ducking window: speech must also clear playbackLevel * this factor, so
   * the bot's own voice through the speaker cannot trip the detector.
   */
  duckPlaybackMultiplier?: number;
  /**
   * Ducking window: sustained loudness must last this long (instead of
   * minSpeechMs) before it counts as speech — barge-in trades one beat of
   * latency for immunity to playback transients.
   */
  duckedMinSpeechMs?: number;
};

export type SpeechDetectorState = 'idle' | 'maybe-speech' | 'speaking';
export type SpeechDetectorEvent = 'none' | 'speech-start' | 'speech-end';

export type SpeechDetector = {
  /** Feed one level sample; returns the transition it caused, if any. */
  push(level: number, atMs: number): SpeechDetectorEvent;
  /** Forget any in-flight utterance (used when capture pauses). */
  reset(): void;
  /**
   * Enter or refresh the ducking window with the current playback level
   * (0..1); null leaves it. Ducking survives reset() — pausing capture does
   * not mean playback stopped.
   */
  setDucking(playbackLevel: number | null): void;
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
    holdMultiplier: 0.6,
    maxUtteranceMs: 45_000,
    duckPlaybackMultiplier: 0.65,
    duckedMinSpeechMs: 250,
  };

/**
 * Expo Go's iOS meter reports a small but persistent room level even after a
 * person stops speaking. Keep browser defaults unchanged, but give the native
 * adapter a firmer release threshold and a short bounded turn.
 *
 * The cap is a safety net, not ordinary turn-taking: a 16 kHz mono PCM WAV
 * remains comfortably below the server's request limit even if the hardware
 * never returns to silence.
 */
export const NATIVE_SPEECH_DETECTOR_OPTIONS: SpeechDetectorOptions = {
  minSpeechLevel: 0.075,
  noiseMultiplier: 3.25,
  endSilenceMs: 650,
  holdMultiplier: 0.75,
  maxUtteranceMs: 15_000,
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
  /** Playback level while assistant audio plays; null when it doesn't. */
  let duckLevel: number | null = null;

  /** What the room alone would require — ducking never feeds back into it. */
  const baseThreshold = () =>
    Math.max(opts.minSpeechLevel, noiseFloor * opts.noiseMultiplier);
  const speechThreshold = () =>
    duckLevel === null
      ? baseThreshold()
      : Math.max(baseThreshold(), duckLevel * opts.duckPlaybackMultiplier);
  // Hysteresis: once speaking, quieter audio still counts as voice.
  const holdThreshold = () =>
    speechThreshold() * Math.max(0, Math.min(1, opts.holdMultiplier));
  const requiredSpeechMs = () =>
    duckLevel === null ? opts.minSpeechMs : opts.duckedMinSpeechMs;

  const updateNoiseFloor = (level: number) => {
    // Only quiet samples teach the floor, so speech cannot raise it. While
    // ducked, "quiet" is judged against the un-ducked threshold: samples in
    // the bleed band (above it, below the ducked gate) are presumed to be
    // the bot's own voice and must never raise the floor.
    if (level < baseThreshold()) {
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
        if (atMs - candidateSince >= requiredSpeechMs()) {
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
    setDucking(playbackLevel: number | null) {
      duckLevel =
        playbackLevel === null || !Number.isFinite(playbackLevel)
          ? null
          : Math.max(0, Math.min(1, playbackLevel));
    },
    state: () => state,
    speechThreshold,
  };
}
