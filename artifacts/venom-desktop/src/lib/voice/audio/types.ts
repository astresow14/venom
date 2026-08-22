/**
 * types.ts — the one audio interface voice mode talks to.
 *
 * Every platform backend (browser WebAudio, native Expo audio, UI-test fake)
 * implements exactly this contract, so the conversation loop never touches a
 * platform API directly.
 */

export type VoiceCaptureErrorCode =
  | 'permission_denied'
  | 'unsupported'
  | 'capture_failed';

export type VoiceCaptureEvent =
  /** Smoothed input loudness (0..1), for the orb and for barge-in. */
  | { type: 'level'; level: number; atMs: number }
  /** The user started talking. */
  | { type: 'speech-start' }
  /** The user finished one utterance; audio is base64 (container format). */
  | { type: 'utterance'; audioBase64: string; durationMs: number }
  | { type: 'error'; code: VoiceCaptureErrorCode; message: string };

export type VoiceCaptureHandle = {
  /** Acquire the microphone and begin end-of-speech detection. */
  start(): Promise<void>;
  /** Keep the mic session alive but stop cutting utterances. */
  pause(): void;
  /** Resume utterance detection after pause(). */
  resume(): void;
  /**
   * Enter/refresh the ducking window with the current playback level (0..1),
   * or leave it with null. While ducked, the speech detector is gated
   * against playback bleed so the bot's own voice cannot start an
   * utterance — the basis of hands-free barge-in.
   */
  setDucking(playbackLevel: number | null): void;
  /** Release the microphone entirely. */
  stop(): void;
};

export type VoicePlaybackEvent =
  /** Approximate output loudness (0..1) while speaking. */
  | { type: 'level'; level: number }
  /** First audio is actually audible. */
  | { type: 'started' }
  /** All queued audio drained after end(). */
  | { type: 'finished' }
  | { type: 'error'; message: string };

export type VoicePlaybackHandle = {
  /** Start an assistant turn. Chunks are PCM16 mono at the given rate. */
  begin(format: { sampleRate: number }): void;
  /** Append one base64 PCM16 chunk (may arrive across several sentences). */
  enqueueChunk(base64Pcm16: string): void;
  /** No more chunks will arrive; 'finished' fires once audio drains. */
  end(): void;
  /** Cut playback immediately and discard anything queued. */
  stop(): void;
};

export type VoiceAudioSupport =
  | { supported: true }
  | { supported: false; reason: string };

export type VoiceAudioAdapter = {
  kind: 'web' | 'native' | 'test';
  isSupported(): VoiceAudioSupport;
  createCapture(onEvent: (event: VoiceCaptureEvent) => void): VoiceCaptureHandle;
  createPlayback(
    onEvent: (event: VoicePlaybackEvent) => void,
  ): VoicePlaybackHandle;
};
